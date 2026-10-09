"""入口的来源校验（写请求和 WebSocket 只接受本站页面）与命令行通道的路由。"""

from __future__ import annotations

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer, make_mocked_request

from entry.app import Entry, build_app, origin_allowed, origin_middleware
from entry.config import Settings


def _req(method: str = "POST", **headers: str) -> web.Request:
    return make_mocked_request(method, "/hermes/__hermes_backend/api/files", headers=headers)


@pytest.mark.parametrize(
    ("headers", "ok"),
    [
        ({}, True),  # 非浏览器客户端没有 Origin
        ({"Origin": "http://192.168.2.71:18081", "X-Forwarded-Host": "192.168.2.71:18081", "Host": "192.168.2.71"}, True),
        ({"Origin": "http://192.168.2.71:18080", "X-Forwarded-Host": "192.168.2.71:18081", "Host": "192.168.2.71"}, False),
        ({"Origin": "http://evil.example", "X-Forwarded-Host": "192.168.2.71:18081"}, False),
        ({"Origin": "null", "X-Forwarded-Host": "192.168.2.71:18081"}, False),  # 沙箱 iframe 里的预览页
        ({"Origin": "HTTP://Hermes.Example:443", "X-Forwarded-Host": "hermes.example:443"}, True),
        # nginx 还没升级、没有 X-Forwarded-Host：只比主机名，不至于把正常请求全拒了
        ({"Origin": "http://192.168.2.71:18081", "Host": "192.168.2.71"}, True),
        ({"Origin": "http://10.0.0.9:18081", "Host": "192.168.2.71"}, False),
    ],
)
def test_origin_allowed(headers: dict[str, str], ok: bool) -> None:
    assert origin_allowed(_req(**headers)) is ok


async def _probe_app(enabled: bool) -> TestClient:
    async def handler(request: web.Request) -> web.Response:
        return web.Response(text="ok")

    app = web.Application(middlewares=[origin_middleware(enabled)])
    app.router.add_route("*", "/x", handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


@pytest.mark.asyncio
async def test_middleware_blocks_cross_origin_writes_and_websockets_only() -> None:
    client = await _probe_app(True)
    try:
        bad = {"Origin": "http://192.168.2.71:18080", "X-Forwarded-Host": "192.168.2.71:18081"}
        good = {"Origin": "http://192.168.2.71:18081", "X-Forwarded-Host": "192.168.2.71:18081"}
        assert (await client.post("/x", headers=bad)).status == 403
        assert (await client.delete("/x", headers=bad)).status == 403
        assert (await client.get("/x", headers={**bad, "Upgrade": "websocket", "Connection": "Upgrade"})).status == 403
        assert (await client.get("/x", headers=bad)).status == 200  # 读请求不管
        assert (await client.post("/x", headers=good)).status == 200
        assert (await client.post("/x")).status == 200  # 没有 Origin
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_middleware_can_be_switched_off() -> None:
    client = await _probe_app(False)
    try:
        bad = {"Origin": "http://192.168.2.71:18080", "X-Forwarded-Host": "192.168.2.71:18081"}
        assert (await client.post("/x", headers=bad)).status == 200
    finally:
        await client.close()


def test_terminal_route_is_matched_before_the_catch_all_proxy() -> None:
    from cryptography.fernet import Fernet

    app = build_app(Settings(base_path="/hermes", credential_key=Fernet.generate_key().decode(),
                             database_url="postgresql://unused@127.0.0.1:1/unused"))  # 只建路由，不连库
    resources = [r.canonical for r in app.router.resources()]
    terminal = resources.index("/hermes/__hermes_backend/__mt_user/terminal")
    catch_all = resources.index("/hermes/__hermes_backend/{tail}")
    assert terminal < catch_all
    request = make_mocked_request("GET", "/hermes/__hermes_backend/__mt_user/terminal", app=app)
    # 用 resolve 看实际会进哪个处理函数
    import asyncio

    match = asyncio.run(app.router.resolve(request))
    assert match.handler.__name__ == Entry.terminal.__name__
