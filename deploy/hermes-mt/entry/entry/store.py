"""入口自己的服务面状态：用户、会话、租户运行态、审计。

V0 用 SQLite（stdlib），表结构照隔壁方案说明 §3.16 的五张表设计，
后续换 PostgreSQL 时只需换这一层。**不存对话**——对话永远在各用户卷上的 state.db。
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    phone_hash TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    display TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    upstream_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tenant_runtime (
    user_id TEXT PRIMARY KEY,
    container_token TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'none',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    event TEXT NOT NULL,
    detail TEXT
);
"""


@dataclass
class Session:
    sid: str
    user_id: str
    expires_at: int


class Store:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(SCHEMA)
        self._migrate()
        self._lock = threading.Lock()

    def _migrate(self) -> None:
        """补列。``CREATE TABLE IF NOT EXISTS`` 对已存在的表是空操作，新列不会自己长出来。"""
        for table, column, ddl in (("users", "display", "TEXT"),):
            have = {r[1] for r in self._db.execute(f"PRAGMA table_info({table})")}
            if column not in have:
                self._db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    # ---- users / sessions -------------------------------------------------
    @staticmethod
    def _mask_phone(phone: str) -> str:
        """给界面看的名字：手机号中间四位打码。**不存明文手机号**，只存这个和哈希。"""
        digits = "".join(c for c in phone if c.isdigit())
        if len(digits) >= 11:
            return f"{digits[:3]}****{digits[-4:]}"
        return digits[:2] + "****" if digits else ""

    def upsert_user(self, user_id: str, phone: str = "") -> None:
        now = int(time.time())
        phone_hash = hashlib.sha256(phone.encode()).hexdigest() if phone else None
        display = self._mask_phone(phone) or None
        with self._lock:
            self._db.execute(
                "INSERT INTO users(user_id, phone_hash, created_at, last_login_at, display) VALUES(?,?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET last_login_at=excluded.last_login_at, "
                "phone_hash=COALESCE(excluded.phone_hash, users.phone_hash), "
                "display=COALESCE(excluded.display, users.display)",
                (user_id, phone_hash, now, now, display),
            )

    def display_name(self, user_id: str) -> str:
        with self._lock:
            row = self._db.execute("SELECT display FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return (row[0] if row and row[0] else "") or ""

    def create_session(self, user_id: str, ttl_s: int, upstream_expires_at_ms: int | None = None) -> Session:
        now = int(time.time())
        expires_at = now + ttl_s
        if upstream_expires_at_ms:
            # 不让我们的会话活得比上游 JWT 久（留 5 分钟余量给时钟漂移）
            expires_at = min(expires_at, upstream_expires_at_ms // 1000 - 300)
        sid = secrets.token_urlsafe(32)
        with self._lock:
            self._db.execute(
                "INSERT INTO sessions(sid, user_id, created_at, expires_at, upstream_expires_at) VALUES(?,?,?,?,?)",
                (sid, user_id, now, expires_at, upstream_expires_at_ms),
            )
        return Session(sid=sid, user_id=user_id, expires_at=expires_at)

    def get_session(self, sid: str) -> Session | None:
        if not sid:
            return None
        now = int(time.time())
        with self._lock:
            row = self._db.execute(
                "SELECT s.sid, s.user_id, s.expires_at FROM sessions s JOIN users u ON u.user_id = s.user_id "
                "WHERE s.sid = ? AND s.expires_at > ? AND u.status = 'active'",
                (sid, now),
            ).fetchone()
        return Session(*row) if row else None

    def delete_session(self, sid: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE sid = ?", (sid,))

    def purge_expired_sessions(self) -> int:
        with self._lock:
            cur = self._db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
        return cur.rowcount

    # ---- tenant runtime ----------------------------------------------------
    def get_tenant_token(self, user_id: str) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT container_token FROM tenant_runtime WHERE user_id = ?", (user_id,)).fetchone()
        return row[0] if row else None

    def ensure_tenant_token(self, user_id: str) -> str:
        existing = self.get_tenant_token(user_id)
        if existing:
            return existing
        token = secrets.token_hex(32)
        now = int(time.time())
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO tenant_runtime(user_id, container_token, state, created_at, last_seen_at) VALUES(?,?,?,?,?)",
                (user_id, token, "none", now, now),
            )
        return self.get_tenant_token(user_id) or token

    def set_tenant_state(self, user_id: str, state: str) -> None:
        with self._lock:
            self._db.execute("UPDATE tenant_runtime SET state = ? WHERE user_id = ?", (state, user_id))

    def touch_tenant(self, user_id: str) -> None:
        with self._lock:
            self._db.execute("UPDATE tenant_runtime SET last_seen_at = ? WHERE user_id = ?", (int(time.time()), user_id))

    def idle_tenants(self, older_than_s: int, exclude: set[str] | None = None) -> list[str]:
        """闲置到可以回收的租户。``exclude`` 是当前还挂着 ws 连接的用户。

        ★ 判活用「有没有连接」而不是「最后一帧多久前」：用户把页面开着但没说话时
        ws 是静默的，按帧算会被判成闲置、把他的容器停掉，页面当场掉线。
        """
        cutoff = int(time.time()) - older_than_s
        with self._lock:
            rows = self._db.execute(
                "SELECT user_id FROM tenant_runtime WHERE state = 'running' AND last_seen_at < ?", (cutoff,)
            ).fetchall()
        blocked = exclude or set()
        return [r[0] for r in rows if r[0] not in blocked]

    def all_tenant_states(self) -> list[tuple[str, str, int]]:
        with self._lock:
            rows = self._db.execute("SELECT user_id, state, last_seen_at FROM tenant_runtime").fetchall()
        return [(r[0], r[1], r[2]) for r in rows]

    # ---- audit ----------------------------------------------------------------
    def audit(self, user_id: str | None, event: str, detail: str = "") -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO audit(ts, user_id, event, detail) VALUES(?,?,?,?)",
                (int(time.time()), user_id, event, detail[:500]),
            )
