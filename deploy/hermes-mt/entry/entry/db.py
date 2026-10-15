"""管理 Entry 的 PostgreSQL 连接池、健康检查和有序迁移。"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import asyncpg


_MIGRATION_LOCK_ID = 4_836_928_117_024_069_208
DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


class DatabaseUnavailable(RuntimeError):
    """PostgreSQL 当前无法建立连接或完成查询。"""


class Database:
    """持有 Entry 唯一的 PostgreSQL 连接池。"""

    def __init__(
        self,
        dsn: str,
        *,
        min_size: int = 1,
        max_size: int = 10,
        command_timeout_s: int = 30,
        migrations_dir: Path = DEFAULT_MIGRATIONS_DIR,
    ):
        if not dsn:
            raise ValueError("缺少 MT_DATABASE_URL，Entry 无法启动")
        if min_size < 1 or max_size < min_size:
            raise ValueError("PostgreSQL 连接池大小配置无效")
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self._command_timeout_s = command_timeout_s
        self._migrations_dir = migrations_dir
        self._pool: asyncpg.Pool | None = None

    @property
    def pool(self) -> asyncpg.Pool:
        """返回已连接的连接池，避免在未启动时悄悄创建连接。"""
        if self._pool is None:
            raise RuntimeError("PostgreSQL 连接池尚未启动")
        return self._pool

    async def connect(self) -> None:
        """建立连接池并在开始监听前完成数据库迁移。"""
        self._pool = await asyncpg.create_pool(
            dsn=self._dsn,
            min_size=self._min_size,
            max_size=self._max_size,
            command_timeout=self._command_timeout_s,
        )
        try:
            await self._run_migrations()
        except Exception:
            await self.close()
            raise

    async def close(self) -> None:
        """关闭连接池；允许启动失败后的重复清理。"""
        pool, self._pool = self._pool, None
        if pool is not None:
            await pool.close()

    async def ping(self) -> bool:
        """检查数据库是否能执行请求，不吞掉调用方需要处理的错误。"""
        async with self.acquire() as connection:
            return await connection.fetchval("SELECT TRUE") is True

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[asyncpg.Connection]:
        """提供带类型的连接获取入口。"""
        try:
            async with self.pool.acquire() as connection:
                yield connection
        except (
            asyncpg.PostgresConnectionError,
            asyncpg.InterfaceError,
            asyncio.TimeoutError,
            OSError,
        ) as exc:
            raise DatabaseUnavailable("PostgreSQL 暂时不可用") from exc

    async def _run_migrations(self) -> None:
        paths = sorted(self._migrations_dir.glob("*.sql"))
        if not paths:
            raise RuntimeError(f"没有找到 PostgreSQL 迁移文件: {self._migrations_dir}")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("SELECT pg_advisory_xact_lock($1)", _MIGRATION_LOCK_ID)
                await connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version TEXT PRIMARY KEY,
                        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                applied = {
                    row["version"]
                    for row in await connection.fetch("SELECT version FROM schema_migrations")
                }
                for path in paths:
                    version = path.stem
                    if version in applied:
                        continue
                    await connection.execute(path.read_text(encoding="utf-8"))
                    await connection.execute(
                        "INSERT INTO schema_migrations(version) VALUES($1)",
                        version,
                    )
