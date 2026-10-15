"""验证 Entry 的 PostgreSQL 故障响应与租户模型 Key 同步行为。"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import AsyncMock, call

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from entry.app import database_error_middleware
from entry.config import Settings
from entry.db import Database, DatabaseUnavailable
from entry.tenants import CredentialSyncError, Tenant, TenantManager


@dataclass
class _Response:
    status: int
    body: str = "{}"

    async def __aenter__(self) -> _Response:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    async def text(self) -> str:
        return self.body


class _Http:
    def __init__(self, statuses: list[int]):
        self.statuses = statuses
        self.calls: list[dict] = []

    def put(self, url: str, **kwargs) -> _Response:
        self.calls.append({"url": url, **kwargs})
        return _Response(self.statuses.pop(0))


class _FailingAcquire:
    async def __aenter__(self):
        raise ConnectionRefusedError("database-secret-detail")

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class _FailingPool:
    def acquire(self) -> _FailingAcquire:
        return _FailingAcquire()


@pytest.mark.asyncio
async def test_api_key_sync_uses_existing_env_endpoint_and_deduplicates() -> None:
    settings = Settings(key_env_name="PLATFORM_MODEL_KEY")
    http = _Http([200, 200])
    manager = TenantManager(settings, None, None, http)  # type: ignore[arg-type]
    tenant = Tenant("user-a", "user-a", "172.20.0.8", "container-token")

    await manager._sync_api_key(tenant, "key-one")
    await manager._sync_api_key(tenant, "key-one")
    await manager._sync_api_key(tenant, "key-two")

    assert len(http.calls) == 2
    assert http.calls[0]["url"] == "http://172.20.0.8:9121/api/env"
    assert http.calls[0]["json"] == {"key": "PLATFORM_MODEL_KEY", "value": "key-one"}
    assert http.calls[0]["headers"]["X-Hermes-Session-Token"] == "container-token"
    assert http.calls[0]["headers"]["Host"] == "127.0.0.1:9120"


@pytest.mark.asyncio
async def test_api_key_sync_failure_is_not_marked_and_retries() -> None:
    settings = Settings(key_env_name="PLATFORM_MODEL_KEY")
    http = _Http([500, 200])
    manager = TenantManager(settings, None, None, http)  # type: ignore[arg-type]
    tenant = Tenant("user-a", "user-a", "172.20.0.8", "container-token")

    with pytest.raises(CredentialSyncError):
        await manager._sync_api_key(tenant, "key-one")
    await manager._sync_api_key(tenant, "key-one")

    assert len(http.calls) == 2


@pytest.mark.asyncio
async def test_tenant_start_failure_restores_stopped_state() -> None:
    """容器启动失败后回写 stopped，并保留原始异常。"""
    settings = Settings()
    docker = SimpleNamespace(
        ensure_network=AsyncMock(),
        connect_network=AsyncMock(),
        ensure_volume=AsyncMock(return_value=False),
        inspect_container=AsyncMock(
            return_value={"Config": {"Image": settings.image}, "State": {"Running": False}}
        ),
        start_container=AsyncMock(side_effect=RuntimeError("start failed")),
    )
    store = SimpleNamespace(
        ensure_tenant_token=AsyncMock(return_value="container-token"),
        get_tenant_context=AsyncMock(
            return_value=SimpleNamespace(api_key="", endpoint=None, catalog=[])
        ),
        set_tenant_state=AsyncMock(),
        write_audit=AsyncMock(),
    )
    manager = TenantManager(settings, docker, store, None)  # type: ignore[arg-type]

    with pytest.raises(RuntimeError, match="start failed"):
        await manager.ensure_running("user-a")

    assert store.set_tenant_state.await_args_list == [
        call("user-a", "starting"),
        call("user-a", "stopped"),
    ]


@pytest.mark.asyncio
async def test_database_error_middleware_returns_sanitized_503() -> None:
    async def broken(request: web.Request) -> web.Response:
        raise DatabaseUnavailable("database-secret-detail")

    app = web.Application(middlewares=[database_error_middleware])
    app.router.add_get("/broken", broken)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.get("/broken")
        payload = await response.json()
    finally:
        await client.close()

    assert response.status == 503
    assert payload == {"error": "database_unavailable"}
    assert "database-secret-detail" not in str(payload)


@pytest.mark.asyncio
async def test_database_acquire_wraps_connection_refused() -> None:
    database = Database("postgresql://unused")
    database._pool = _FailingPool()  # type: ignore[assignment]

    with pytest.raises(DatabaseUnavailable, match="暂时不可用"):
        async with database.acquire():
            pass
