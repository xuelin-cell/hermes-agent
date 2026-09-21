"""为 Entry 多租户测试提供隔离的模块导入路径和数据库夹具。"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import pytest
import pytest_asyncio


ENTRY_ROOT = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "entry"
if str(ENTRY_ROOT) not in sys.path:
    sys.path.insert(0, str(ENTRY_ROOT))


_LOCAL_ADMIN_DSN = "postgresql://hermes_entry:hermes-local-dev@127.0.0.1:15432/postgres"


def _database_url(dsn: str, database: str) -> str:
    parts = urlsplit(dsn)
    return urlunsplit((parts.scheme, parts.netloc, f"/{database}", parts.query, parts.fragment))


@pytest_asyncio.fixture
async def postgres_database_url() -> str:
    """为每个测试创建独立数据库；本机未启动测试 PostgreSQL 时跳过。"""
    try:
        admin = await asyncpg.connect(_LOCAL_ADMIN_DSN, timeout=2)
    except (OSError, asyncpg.PostgresError) as exc:
        pytest.skip(f"本地 PostgreSQL 未启动: {type(exc).__name__}")
    database = f"hermes_mt_test_{uuid.uuid4().hex}"
    await admin.execute(f'CREATE DATABASE "{database}"')
    await admin.close()
    try:
        yield _database_url(_LOCAL_ADMIN_DSN, database)
    finally:
        admin = await asyncpg.connect(_LOCAL_ADMIN_DSN, timeout=2)
        await admin.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        await admin.close()
