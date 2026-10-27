"""通过 PostgreSQL 保存 Entry 的用户、登录、租户配置、凭据和审计数据。"""

from __future__ import annotations

import hashlib
import json
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
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
    # 企业模式下这个用户在平台上的状态（enterprise_binding.access_status）；没有绑定是空串。
    enterprise_status: str = ""


@dataclass(frozen=True)
class EnterpriseBinding:
    """企业模式：用户在 UNIWORK 企业管理平台上的成员身份（设备令牌在 tenant_credentials 里）。"""

    tenant_id: str
    tenant_code: str
    tenant_name: str
    uid: str
    device_id: str
    member_id: str
    member_name: str
    access_status: str
    policy_revision: str = ""
    checked_at: int = 0


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
    # 套餐给的每个模型的上下文长度 {模型名: context_window}；10-09 之前登录的用户没有，重新登录后才有。
    limits: dict[str, int] = field(default_factory=dict)
    # 平台的运行环境（svc: 用户，见 service_runtime 表）：实例要另开 API 服务，人设按平台的写
    service: bool = False
    persona: str = ""


@dataclass(frozen=True)
class ServiceRuntime:
    """平台调用云端运行智能体的一个运行环境（docs/企业版对接/15），连同它的实例状态。"""

    user_id: str
    tenant_id: str
    tenant_code: str
    runtime_key: str
    kind: str
    label: str
    spec_sha256: str
    current_run_id: str
    run_started_at: datetime | None
    created_at: datetime
    last_active_at: datetime
    state: str = ""
    sandbox_id: str = ""
    template_id: str = ""


@dataclass(frozen=True)
class Runtime:
    """沙箱后端：这个用户的实例与状态归档记录（谁说了算）。"""

    state: str
    sandbox_id: str
    template_id: str
    state_epoch: int
    state_owner: str
    state_archive: str
    lifecycle: str
    traffic_token: str = ""   # 数据面流量令牌（已解密）；实例是公开访问的就是空串
    hermes_key_sha256: str = ""  # 实例里的 hermes 是用哪把模型 key 起的（sha256）；不知道就是空串


def advisory_key(user_id: str) -> int:
    """把用户 ID 变成 PG 咨询锁要的 64 位整数键（稳定、与 PG 版本无关）。"""
    digest = hashlib.blake2b(user_id.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


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
    def _catalog_json(catalog: list[tuple[str, str]], limits: dict[str, int] | None = None) -> str:
        limits = limits or {}
        return json.dumps(
            [
                {"model_name": model_name, "base_url": base_url,
                 **({"context_window": limits[model_name]} if model_name in limits else {})}
                for model_name, base_url in catalog
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )

    @staticmethod
    def _decode_limits(raw: Any) -> dict[str, int]:
        """模型清单里各模型的上下文长度；老数据没有这一项就是空的。"""
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                return {}
        limits: dict[str, int] = {}
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("model_name") or "").strip()
            value = item.get("context_window")
            if name and isinstance(value, int) and not isinstance(value, bool) and value > 0:
                limits[name] = value
        return limits

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

    @classmethod
    async def _upsert_model_config(
        cls,
        connection,
        user_id: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None,
        limits: dict[str, int] | None,
    ) -> None:
        """写入套餐（或企业策略）给的端点和模型清单；空值不清除已有的有效值。"""
        if not ((endpoint and endpoint[0]) or catalog):
            return
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
            cls._catalog_json(catalog, limits) if catalog else None,
            bool(catalog),
        )

    @staticmethod
    async def _upsert_binding(connection, user_id: str, binding: EnterpriseBinding) -> None:
        await connection.execute(
            """
            INSERT INTO enterprise_binding(
                user_id, tenant_id, tenant_code, tenant_name, uid, device_id,
                member_id, member_name, access_status, policy_revision, checked_at
            ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
            ON CONFLICT(user_id) DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                tenant_code = EXCLUDED.tenant_code,
                tenant_name = EXCLUDED.tenant_name,
                uid = EXCLUDED.uid,
                device_id = EXCLUDED.device_id,
                member_id = EXCLUDED.member_id,
                member_name = EXCLUDED.member_name,
                access_status = EXCLUDED.access_status,
                policy_revision = EXCLUDED.policy_revision,
                checked_at = now()
            """,
            user_id,
            binding.tenant_id,
            binding.tenant_code,
            binding.tenant_name,
            binding.uid,
            binding.device_id,
            binding.member_id,
            binding.member_name,
            binding.access_status,
            binding.policy_revision,
        )

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
        limits: dict[str, int] | None = None,
        enterprise: EnterpriseBinding | None = None,
    ) -> LoginState:
        """原子保存登录相关平台状态，空套餐值不会清除已有有效值。企业模式下同时写入平台绑定。"""
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
                await self._upsert_model_config(connection, user_id, endpoint, catalog, limits)
                if enterprise is not None:
                    await self._upsert_binding(connection, user_id, enterprise)
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
                SELECT s.user_id, s.expires_at, b.access_status
                FROM auth_sessions AS s
                JOIN users AS u ON u.user_id = s.user_id
                LEFT JOIN enterprise_binding AS b ON b.user_id = s.user_id
                WHERE s.session_token_hash = $1
                  AND s.expires_at > now()
                  AND u.status = 'active'
                """,
                self._session_hash(sid),
            )
        if row is None:
            return None
        return Session(
            sid=sid,
            user_id=row["user_id"],
            expires_at=int(row["expires_at"].timestamp()),
            enterprise_status=str(row["access_status"] or ""),
        )

    async def delete_session(self, sid: str) -> None:
        if not sid:
            return
        async with self.database.acquire() as connection:
            await connection.execute(
                "DELETE FROM auth_sessions WHERE session_token_hash = $1",
                self._session_hash(sid),
            )

    # ---- 企业模式：平台绑定 -------------------------------------------------------

    async def get_enterprise_binding(self, user_id: str) -> EnterpriseBinding | None:
        async with self.database.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT tenant_id, tenant_code, tenant_name, uid, device_id, member_id, member_name,
                       access_status, policy_revision, checked_at
                FROM enterprise_binding WHERE user_id = $1
                """,
                user_id,
            )
        if row is None:
            return None
        return EnterpriseBinding(
            tenant_id=row["tenant_id"],
            tenant_code=row["tenant_code"],
            tenant_name=row["tenant_name"],
            uid=row["uid"],
            device_id=row["device_id"],
            member_id=row["member_id"],
            member_name=row["member_name"],
            access_status=row["access_status"],
            policy_revision=row["policy_revision"],
            checked_at=int(row["checked_at"].timestamp()),
        )

    async def update_enterprise_access(
        self,
        user_id: str,
        access_status: str,
        *,
        policy_revision: str | None = None,
        member_name: str | None = None,
        tenant_name: str | None = None,
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
        limits: dict[str, int] | None = None,
    ) -> None:
        """复查平台后更新绑定状态；放行了就顺带换上策略里的模型清单（空值不清除已有的）。"""
        async with self.database.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    UPDATE enterprise_binding SET
                        access_status = $2,
                        policy_revision = COALESCE($3, policy_revision),
                        member_name = COALESCE($4, member_name),
                        tenant_name = COALESCE(NULLIF($5, ''), tenant_name),
                        checked_at = now()
                    WHERE user_id = $1
                    """,
                    user_id,
                    access_status,
                    policy_revision,
                    member_name,
                    tenant_name,
                )
                await self._upsert_model_config(connection, user_id, endpoint, catalog, limits)

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
                    c.container_token_ciphertext,
                    s.user_id IS NOT NULL AS service,
                    s.persona
                FROM users AS u
                LEFT JOIN tenant_model_config AS m ON m.user_id = u.user_id
                LEFT JOIN tenant_credentials AS c ON c.user_id = u.user_id
                LEFT JOIN service_runtime AS s ON s.user_id = u.user_id
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
            limits=self._decode_limits(row["model_catalog"]),
            service=bool(row["service"]),
            persona=str(row["persona"] or ""),
        )

    # ---- 平台的运行环境（svc: 用户，docs/企业版对接/15） ------------------------------------------

    async def upsert_service_runtime(
        self,
        *,
        user_id: str,
        tenant_id: str,
        tenant_code: str,
        runtime_key: str,
        kind: str,
        label: str,
        device_token: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None,
        limits: dict[str, int] | None,
        persona: str,
    ) -> None:
        """建或更新一个运行环境：用户、平台给的设备令牌、模型配置、人设一次写完。"""
        now = _utc_now()
        async with self.database.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO users(user_id, masked_phone, last_login_at) VALUES($1, NULL, $2)
                    ON CONFLICT(user_id) DO UPDATE SET last_login_at = EXCLUDED.last_login_at
                    """,
                    user_id,
                    now,
                )
                await self._upsert_model_config(connection, user_id, endpoint, catalog, limits)
                await connection.execute(
                    """
                    INSERT INTO tenant_credentials(user_id, api_key_ciphertext) VALUES($1, $2)
                    ON CONFLICT(user_id) DO UPDATE SET
                        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
                        updated_at = now()
                    """,
                    user_id,
                    self.cipher.encrypt(device_token),
                )
                await connection.execute(
                    """
                    INSERT INTO service_runtime(
                        user_id, tenant_id, tenant_code, runtime_key, kind, label, persona
                    ) VALUES($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT(user_id) DO UPDATE SET
                        tenant_code = EXCLUDED.tenant_code,
                        kind = EXCLUDED.kind,
                        label = EXCLUDED.label,
                        persona = EXCLUDED.persona,
                        last_active_at = now()
                    """,
                    user_id,
                    tenant_id,
                    tenant_code,
                    runtime_key,
                    kind,
                    label,
                    persona,
                )

    _SERVICE_SELECT = """
        SELECT s.user_id, s.tenant_id, s.tenant_code, s.runtime_key, s.kind, s.label, s.spec_sha256,
               s.current_run_id, s.run_started_at, s.created_at, s.last_active_at,
               r.state, r.sandbox_id, r.template_id
        FROM service_runtime AS s
        LEFT JOIN tenant_runtime AS r ON r.user_id = s.user_id
    """

    @staticmethod
    def _service_row(row) -> ServiceRuntime:
        return ServiceRuntime(
            user_id=row["user_id"],
            tenant_id=row["tenant_id"],
            tenant_code=row["tenant_code"],
            runtime_key=row["runtime_key"],
            kind=row["kind"],
            label=row["label"],
            spec_sha256=row["spec_sha256"],
            current_run_id=row["current_run_id"] or "",
            run_started_at=row["run_started_at"],
            created_at=row["created_at"],
            last_active_at=row["last_active_at"],
            state=row["state"] or "",
            sandbox_id=row["sandbox_id"] or "",
            template_id=row["template_id"] or "",
        )

    async def find_service_runtimes(self, runtime_key: str, tenant_id: str = "") -> list[ServiceRuntime]:
        """按运行环境 key 找；带了企业 ID 就只在这个企业里找（平台的 key 跨企业会重名）。"""
        async with self.database.acquire() as connection:
            if tenant_id:
                rows = await connection.fetch(
                    self._SERVICE_SELECT + " WHERE s.tenant_id = $1 AND s.runtime_key = $2",
                    tenant_id,
                    runtime_key,
                )
            else:
                rows = await connection.fetch(self._SERVICE_SELECT + " WHERE s.runtime_key = $1", runtime_key)
        return [self._service_row(row) for row in rows]

    async def list_service_runtimes(self, tenant_id: str) -> list[ServiceRuntime]:
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                self._SERVICE_SELECT + " WHERE s.tenant_id = $1 ORDER BY s.created_at", tenant_id)
        return [self._service_row(row) for row in rows]

    async def set_service_spec(self, user_id: str, digest: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE service_runtime SET spec_sha256 = $2 WHERE user_id = $1", user_id, digest)

    async def begin_service_run(self, user_id: str, run_id: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                UPDATE service_runtime
                SET current_run_id = $2, run_started_at = now(), last_active_at = now()
                WHERE user_id = $1
                """,
                user_id,
                run_id,
            )

    async def end_service_run(self, user_id: str, run_id: str) -> None:
        """只清掉这一次：期间若已经换成别的运行，不动。"""
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                UPDATE service_runtime SET current_run_id = NULL, last_active_at = now()
                WHERE user_id = $1 AND current_run_id = $2
                """,
                user_id,
                run_id,
            )

    async def touch_service_runtime(self, user_id: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE service_runtime SET last_active_at = now() WHERE user_id = $1", user_id)

    async def delete_user(self, user_id: str) -> None:
        """连同运行态、凭据、模型配置、运行环境记录一起删（外键都是级联）。只给删运行环境用。"""
        async with self.database.acquire() as connection:
            await connection.execute("DELETE FROM users WHERE user_id = $1", user_id)

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

    # ---- 沙箱后端：实例 ID ------------------------------------------------------
    #
    # 只有沙箱后端用得上。实例 ID 由平台下发、我们算不出来，所以必须存。
    # ★ 它是易变的：实例被回收或重建后会换一个新值，而用户数据在按用户 ID 命名的
    #   持久卷上，不随实例走。所以这一列丢了只会导致多建一个实例，不会丢数据。

    async def get_sandbox_id(self, user_id: str) -> str:
        async with self.database.acquire() as connection:
            row = await connection.fetchrow(
                "SELECT sandbox_id FROM tenant_runtime WHERE user_id = $1",
                user_id,
            )
        return (row and row["sandbox_id"]) or ""

    async def set_sandbox_id(self, user_id: str, sandbox_id: str | None) -> None:
        """记下或清掉这个用户当前的实例 ID。传 None 表示他现在没有实例（流量令牌一起清掉）。"""
        async with self.database.acquire() as connection:
            if sandbox_id:
                await connection.execute(
                    "UPDATE tenant_runtime SET sandbox_id = $2 WHERE user_id = $1",
                    user_id,
                    sandbox_id,
                )
            else:
                await connection.execute(
                    "UPDATE tenant_runtime SET sandbox_id = NULL, traffic_token_ciphertext = NULL WHERE user_id = $1",
                    user_id,
                )

    @asynccontextmanager
    async def advisory_lock(self, user_id: str):
        """跨入口副本的用户级互斥：同一用户的实例变更在整个集群里一次只做一件。

        会话级咨询锁，持有期间独占一条连接（所以只包住真正要变更的那一段，
        不包每个请求都走的快路径）。退出时在同一条连接上解锁。
        """
        key = advisory_key(user_id)
        async with self.database.acquire() as connection:
            await connection.execute("SELECT pg_advisory_lock($1)", key)
            try:
                yield
            finally:
                try:
                    await connection.execute("SELECT pg_advisory_unlock($1)", key)
                except Exception:  # noqa: BLE001 — 连接已坏时锁随会话释放
                    pass

    # ---- 沙箱后端：谁说了算 -----------------------------------------------------
    #
    # 归档在用户自己的卷上按实例分目录；这里记当前主人、只增不减的编号、最近确认的归档。
    # 新实例从 state_owner 那一代恢复；卷上的 OWNER 编号不小于新编号就说明这里丢过记录。

    async def get_runtime(self, user_id: str) -> Runtime:
        async with self.database.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT state, sandbox_id, template_id, state_epoch, state_owner, state_archive, lifecycle,
                       traffic_token_ciphertext, hermes_key_sha256
                FROM tenant_runtime WHERE user_id = $1
                """,
                user_id,
            )
        if row is None:
            return Runtime("stopped", "", "", 0, "", "", "")
        return Runtime(
            state=str(row["state"] or "stopped"),
            sandbox_id=str(row["sandbox_id"] or ""),
            template_id=str(row["template_id"] or ""),
            state_epoch=int(row["state_epoch"] or 0),
            state_owner=str(row["state_owner"] or ""),
            state_archive=str(row["state_archive"] or ""),
            lifecycle=str(row["lifecycle"] or ""),
            traffic_token=(
                self.cipher.decrypt(row["traffic_token_ciphertext"])
                if row["traffic_token_ciphertext"] is not None
                else ""
            ),
            hermes_key_sha256=str(row["hermes_key_sha256"] or ""),
        )

    async def next_epoch(self, user_id: str) -> int:
        """给下一台实例发编号：只增不减。"""
        async with self.database.acquire() as connection:
            value = await connection.fetchval(
                """
                UPDATE tenant_runtime SET state_epoch = state_epoch + 1
                WHERE user_id = $1 RETURNING state_epoch
                """,
                user_id,
            )
        return int(value or 0)

    async def record_sandbox(self, user_id: str, sandbox_id: str, template_id: str, epoch: int,
                             traffic_token: str = "") -> None:
        """建了一台实例：记到运行态（含流量令牌，加密），也记进历史表。"""
        async with self.database.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    UPDATE tenant_runtime
                    SET sandbox_id = $2, template_id = $3, lifecycle = '', traffic_token_ciphertext = $4,
                        hermes_key_sha256 = NULL
                    WHERE user_id = $1
                    """,
                    user_id,
                    sandbox_id,
                    template_id or None,
                    self.cipher.encrypt(traffic_token) if traffic_token else None,
                )
                await connection.execute(
                    """
                    INSERT INTO sandbox_history(sandbox_id, user_id, template_id, state_epoch)
                    VALUES($1, $2, $3, $4)
                    ON CONFLICT(sandbox_id) DO NOTHING
                    """,
                    sandbox_id,
                    user_id,
                    template_id or None,
                    epoch,
                )

    async def set_hermes_key(self, user_id: str, sandbox_id: str, key_sha256: str) -> None:
        """记下这台实例里的 hermes 是用哪把 key 起的。实例已经换了（sandbox_id 对不上）就不记。"""
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE tenant_runtime SET hermes_key_sha256 = $3 WHERE user_id = $1 AND sandbox_id = $2",
                user_id,
                sandbox_id,
                key_sha256,
            )

    async def set_state_owner(self, user_id: str, owner: str, archive: str, manifest: dict | None) -> None:
        """新实例恢复完成：它成为当前主人；顺手记下它恢复时用的那份归档。"""
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                UPDATE tenant_runtime
                SET state_owner = $2,
                    state_archive = COALESCE($3, state_archive),
                    state_manifest = COALESCE($4::jsonb, state_manifest),
                    state_synced_at = now()
                WHERE user_id = $1
                """,
                user_id,
                owner,
                archive or None,
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) if manifest else None,
            )

    async def set_state_archive(self, user_id: str, archive: str, manifest: dict | None) -> None:
        """sync / drain 成功：记下最近确认过的归档。"""
        if not archive:
            return
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                UPDATE tenant_runtime
                SET state_archive = $2, state_manifest = $3::jsonb, state_synced_at = now()
                WHERE user_id = $1
                """,
                user_id,
                archive,
                json.dumps(manifest or {}, ensure_ascii=False, separators=(",", ":")),
            )

    async def set_lifecycle(self, user_id: str, phase: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE tenant_runtime SET lifecycle = $2 WHERE user_id = $1",
                user_id,
                phase,
            )

    async def mark_sandbox_deleted(self, sandbox_id: str, reason: str) -> None:
        async with self.database.acquire() as connection:
            await connection.execute(
                """
                UPDATE sandbox_history SET deleted_at = now(), delete_reason = $2
                WHERE sandbox_id = $1 AND deleted_at IS NULL
                """,
                sandbox_id,
                reason,
            )

    async def tenants_with_sandbox(self) -> list[tuple[str, str, str]]:
        """(user_id, sandbox_id, state)，只含有实例记录的用户。"""
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                "SELECT user_id, sandbox_id, state FROM tenant_runtime WHERE sandbox_id IS NOT NULL ORDER BY user_id"
            )
        return [(row["user_id"], row["sandbox_id"], row["state"]) for row in rows]

    async def backup_candidates(self) -> list[str]:
        """建过实例（编号 > 0）的用户，卷上可能有归档；按用户 ID 排序，跑卷外副本用。"""
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                "SELECT user_id FROM tenant_runtime WHERE state_epoch > 0 ORDER BY user_id"
            )
        return [row["user_id"] for row in rows]

    async def long_idle_tenants(self, older_than_s: int) -> list[str]:
        """已暂停（stopped）且很久没活动、还占着一台实例的用户。"""
        cutoff = _utc_now() - timedelta(seconds=older_than_s)
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT user_id FROM tenant_runtime
                WHERE state = 'stopped' AND sandbox_id IS NOT NULL AND lifecycle = ''
                  AND last_activity_at < $1
                ORDER BY last_activity_at
                """,
                cutoff,
            )
        return [row["user_id"] for row in rows]

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

    # ---- 沙箱后端：定时任务叫醒 -------------------------------------------------

    async def set_next_cron(self, user_id: str, at: datetime | None) -> None:
        """实例停下时转发器报的最早下次执行时间；None = 没有待执行的定时任务。"""
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE tenant_runtime SET next_cron_at = $2 WHERE user_id = $1",
                user_id,
                at,
            )

    async def cron_due_tenants(self, within_s: int) -> list[tuple[str, datetime]]:
        """实例停着、定时任务快到点（或已过点）、还没为这个时间点叫醒过的有效用户，按到点先后排。"""
        cutoff = _utc_now() + timedelta(seconds=within_s)
        async with self.database.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT r.user_id, r.next_cron_at
                FROM tenant_runtime AS r
                JOIN users AS u ON u.user_id = r.user_id
                WHERE u.status = 'active' AND r.state = 'stopped' AND r.lifecycle = ''
                  AND r.next_cron_at IS NOT NULL AND r.next_cron_at <= $1
                  AND r.cron_woken_for IS DISTINCT FROM r.next_cron_at
                  -- 企业模式下被平台拦住（或已退出）的用户：叫醒了模型也调不通
                  AND NOT EXISTS (
                      SELECT 1 FROM enterprise_binding AS b
                      WHERE b.user_id = r.user_id AND b.access_status <> 'active'
                  )
                ORDER BY r.next_cron_at
                """,
                cutoff,
            )
        return [(row["user_id"], row["next_cron_at"]) for row in rows]

    async def mark_cron_woken(self, user_id: str, at: datetime) -> None:
        """这个时间点已经叫醒过（或叫不醒、放弃了），不再为它叫。"""
        async with self.database.acquire() as connection:
            await connection.execute(
                "UPDATE tenant_runtime SET cron_woken_for = $2 WHERE user_id = $1",
                user_id,
                at,
            )

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
