"""通过 PostgreSQL 保存 Entry 的用户、登录、租户配置、凭据和审计数据。"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .crypto import CredentialCipher
from .db import Database


@dataclass(frozen=True)
class Session:
    """浏览器持有的原始登录令牌及其用户和失效时间。"""

    sid: str
    user_id: str
    expires_at: int


@dataclass(frozen=True)
class LoginState:
    """一次已提交登录事务的响应所需状态。"""

    session: Session
    has_api_key: bool


@dataclass(frozen=True)
class TenantContext:
    """启动或访问一个租户所需的平台配置和解密凭据。"""

    api_key: str
    container_token: str
    endpoint: tuple[str, str] | None
    catalog: list[tuple[str, str]]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _affected_rows(command_tag: str) -> int:
    try:
        return int(command_tag.rsplit(" ", 1)[-1])
    except (TypeError, ValueError):
        return 0


class Store:
    """提供面向业务实体的异步 PostgreSQL 操作。"""

    def __init__(self, database: Database, cipher: CredentialCipher):
        self.database = database
        self.cipher = cipher

    @staticmethod
    def _mask_phone(phone: str) -> str:
        """只保留可展示的打码手机号，不保存明文或无用途哈希。"""
        digits = "".join(character for character in phone if character.isdigit())
        if len(digits) >= 11:
            return f"{digits[:3]}****{digits[-4:]}"
        return digits[:2] + "****" if digits else ""

    @staticmethod
    def _session_hash(sid: str) -> bytes:
        return hashlib.sha256(sid.encode("utf-8")).digest()

    @staticmethod
    def _catalog_json(catalog: list[tuple[str, str]]) -> str:
        return json.dumps(
            [
                {"model_name": model_name, "base_url": base_url}
                for model_name, base_url in catalog
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )

    @staticmethod
    def _decode_catalog(raw: Any) -> list[tuple[str, str]]:
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                return []
        if not isinstance(raw, list):
            return []
        catalog: list[tuple[str, str]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            model_name = str(item.get("model_name") or "").strip()
            base_url = str(item.get("base_url") or "").strip()
            if model_name:
                catalog.append((model_name, base_url))
        return catalog

    async def finish_login(
        self,
        *,
        user_id: str,
        phone: str,
        api_key: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None,
        ttl_s: int,
        upstream_expires_at_ms: int | None,
        login_method: str,
    ) -> LoginState:
        """原子保存登录相关平台状态，空套餐值不会清除已有有效值。"""
        now = _utc_now()
        expires_at = now + timedelta(seconds=ttl_s)
        upstream_expires_at: datetime | None = None
        if upstream_expires_at_ms:
            upstream_expires_at = datetime.fromtimestamp(
                upstream_expires_at_ms / 1000,
                tz=timezone.utc,
            )
            expires_at = min(expires_at, upstream_expires_at - timedelta(minutes=5))
        if expires_at <= now:
            raise ValueError("上游登录凭据剩余有效期不足")

        sid = secrets.token_urlsafe(32)
        masked_phone = self._mask_phone(phone) or None
        async with self.database.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO users(user_id, masked_phone, last_login_at)
                    VALUES($1, $2, $3)
                    ON CONFLICT(user_id) DO UPDATE SET
                        masked_phone = COALESCE(EXCLUDED.masked_phone, users.masked_phone),
                        last_login_at = EXCLUDED.last_login_at
                    """,
                    user_id,
                    masked_phone,
                    now,
                )
                if (endpoint and endpoint[0]) or catalog:
                    base_url, model_name = endpoint or ("", "")
                    await connection.execute(
                        """
                        INSERT INTO tenant_model_config(
                            user_id, default_base_url, default_model, model_catalog, synced_at
                        ) VALUES($1, $2, $3, COALESCE($4::jsonb, '[]'::jsonb), now())
                        ON CONFLICT(user_id) DO UPDATE SET
                            default_base_url = COALESCE(
                                EXCLUDED.default_base_url,
                                tenant_model_config.default_base_url
                            ),
                            default_model = COALESCE(
                                EXCLUDED.default_model,
                                tenant_model_config.default_model
                            ),
                            model_catalog = CASE
                                WHEN $5 THEN EXCLUDED.model_catalog
                                ELSE tenant_model_config.model_catalog
                            END,
                            synced_at = now()
                        """,
                        user_id,
                        base_url or None,
                        model_name or None,
                        self._catalog_json(catalog) if catalog else None,
                        bool(catalog),
                    )
                if api_key:
                    await connection.execute(
                        """
                        INSERT INTO tenant_credentials(
                            user_id, api_key_ciphertext
                        ) VALUES($1, $2)
                        ON CONFLICT(user_id) DO UPDATE SET
                            api_key_ciphertext = EXCLUDED.api_key_ciphertext,
                            updated_at = now()
                        """,
                        user_id,
                        self.cipher.encrypt(api_key),
                    )
                await connection.execute(
                    """
                    INSERT INTO auth_sessions(
                        session_token_hash, user_id, created_at, expires_at, upstream_expires_at
                    ) VALUES($1, $2, $3, $4, $5)
                    """,
                    self._session_hash(sid),
                    user_id,
                    now,
                    expires_at,
                    upstream_expires_at,
                )
                await connection.execute(
                    """
                    INSERT INTO audit_events(user_id, event_type, details)
                    VALUES($1, 'login', $2::jsonb)
                    """,
                    user_id,
                    json.dumps({"method": login_method}, separators=(",", ":")),
                )
                has_api_key = bool(
                    await connection.fetchval(
                        "SELECT api_key_ciphertext IS NOT NULL FROM tenant_credentials WHERE user_id = $1",
                        user_id,
                    )
                )
        return LoginState(
            session=Session(sid=sid, user_id=user_id, expires_at=int(expires_at.timestamp())),
            has_api_key=has_api_key,
        )

    async def get_session(self, sid: str) -> Session | None:
        if not sid:
            return None
        async with self.database.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT s.user_id, s.expires_at
                FROM auth_sessions AS s
                JOIN users AS u ON u.user_id = s.user_id
                WHERE s.session_token_hash = $1
                  AND s.expires_at > now()
                  AND u.status = 'active'
                """,
                self._session_hash(sid),
            )
        if row is None:
            return None
        return Session(sid=sid, user_id=row["user_id"], expires_at=int(row["expires_at"].timestamp()))

    async def delete_session(self, sid: str) -> None:
        if not sid:
            return
        async with self.database.acquire() as connection:
            await connection.execute(
                "DELETE FROM auth_sessions WHERE session_token_hash = $1",
                self._session_hash(sid),
            )

    async def purge_expired_sessions(self) -> int:
        async with self.database.acquire() as connection:
            result = await connection.execute("DELETE FROM auth_sessions WHERE expires_at <= now()")
        return _affected_rows(result)

    async def masked_phone(self, user_id: str) -> str:
        """返回平台登录手机号的脱敏显示值。"""
        async with self.database.acquire() as connection:
            value = await connection.fetchval(
                "SELECT masked_phone FROM users WHERE user_id = $1",
                user_id,
            )
        return str(value or "")

    async def ensure_tenant_token(self, user_id: str) -> str:
        """并发安全地创建一次容器令牌并确保运行态记录存在。"""
        candidate = secrets.token_hex(32)
        encrypted = self.cipher.encrypt(candidate)
        async with self.database.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    """
                    INSERT INTO tenant_credentials(
                        user_id, container_token_ciphertext
                    ) VALUES($1, $2)
                    ON CONFLICT(user_id) DO UPDATE SET
                        container_token_ciphertext = COALESCE(
                            tenant_credentials.container_token_ciphertext,
                            EXCLUDED.container_token_ciphertext
                        ),
                        updated_at = CASE
                            WHEN tenant_credentials.container_token_ciphertext IS NULL
                            THEN now()
                            ELSE tenant_credentials.updated_at
                        END
                    RETURNING container_token_ciphertext
                    """,
                    user_id,
                    encrypted,
                )
                await connection.execute(
                    """
                    INSERT INTO tenant_runtime(user_id, state)
                    VALUES($1, 'stopped')
                    ON CONFLICT(user_id) DO NOTHING
                    """,
                    user_id,
                )
        return self.cipher.decrypt(row["container_token_ciphertext"])

    async def get_tenant_context(self, user_id: str) -> TenantContext:
        async with self.database.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    u.user_id,
                    m.default_base_url,
                    m.default_model,
                    m.model_catalog,
                    c.api_key_ciphertext,
                    c.container_token_ciphertext
                FROM users AS u
                LEFT JOIN tenant_model_config AS m ON m.user_id = u.user_id
                LEFT JOIN tenant_credentials AS c ON c.user_id = u.user_id
                WHERE u.user_id = $1
                """,
                user_id,
            )
        if row is None:
            raise KeyError(f"未知平台用户: {user_id}")
        api_key = (
            self.cipher.decrypt(row["api_key_ciphertext"])
            if row["api_key_ciphertext"] is not None
            else ""
        )
        container_token = (
            self.cipher.decrypt(row["container_token_ciphertext"])
            if row["container_token_ciphertext"] is not None
            else ""
        )
        base_url = str(row["default_base_url"] or "")
        model_name = str(row["default_model"] or "")
        endpoint = (base_url, model_name) if base_url or model_name else None
        return TenantContext(
            api_key=api_key,
            container_token=container_token,
            endpoint=endpoint,
            catalog=self._decode_catalog(row["model_catalog"]),
        )

    async def set_tenant_state(self, user_id: str, state: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                UPDATE tenant_runtime
                SET state_changed_at = CASE WHEN state <> $2 THEN now() ELSE state_changed_at END,
                    state = $2
                WHERE user_id = $1
                """,
                user_id,
                state,
            )

    async def touch_tenant(self, user_id: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE tenant_runtime SET last_activity_at = now() WHERE user_id = $1",
                user_id,
            )

    async def idle_tenants(self, older_than_s: int, exclude: set[str] | None = None) -> list[str]:
        """返回可回收租户；数据库查询失败时异常上抛，调用方必须跳过本轮回收。"""
        cutoff = _utc_now() - timedelta(seconds=older_than_s)
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT user_id
                FROM tenant_runtime
                WHERE state = 'running' AND last_activity_at < $1
                ORDER BY user_id
                """,
                cutoff,
            )
        blocked = exclude or set()
        return [row["user_id"] for row in rows if row["user_id"] not in blocked]

    async def all_tenant_states(self) -> list[tuple[str, str, int]]:
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT user_id, state, last_activity_at
                FROM tenant_runtime
                ORDER BY user_id
                """
            )
        return [
            (row["user_id"], row["state"], int(row["last_activity_at"].timestamp()))
            for row in rows
        ]

    async def write_audit(
        self,
        user_id: str | None,
        event_type: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO audit_events(user_id, event_type, details)
                VALUES($1, $2, $3::jsonb)
                """,
                user_id,
                event_type,
                json.dumps(details or {}, ensure_ascii=False, separators=(",", ":")),
            )
