"""页面报来的事件写成一行入口日志（entry/client_events.py）：刷新原因、启动耗时、连接断开。

用来定位"用着用着重启""自动切回企业"：日志要能和入口的新会话行对上（会话 ID 前 6 位、来源 IP），
又不能被页面写坏格式、塞进整个会话 ID，或者被刷爆。
"""

from __future__ import annotations

import json
import logging

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from entry.client_events import ClientEvents
from entry.sso import SsoIdentity

CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


async def _client(events: ClientEvents) -> TestClient:
    app = web.Application()
    app.router.add_post("/agents/api/__entry/client-event", events.handle)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


async def _send(client: TestClient, body, ip: str = "123.127.62.1") -> int:
    data = body if isinstance(body, (bytes, str)) else json.dumps(body)
    response = await client.post("/agents/api/__entry/client-event", data=data,
                                 headers={"X-Real-IP": ip, "User-Agent": CHROME, "Content-Type": "application/json"})
    return response.status


@pytest.mark.asyncio
async def test_each_event_is_one_traceable_line_that_the_page_cannot_bend(caplog) -> None:
    identity = SsoIdentity(uid="587030ca-d506", account_type="personal", tenant_id="", sid="997b1e0123456789secret")
    client = await _client(ClientEvents(lambda request: identity))
    caplog.set_level(logging.INFO, logger="entry.client")
    try:
        statuses = [
            await _send(client, {"type": "reload", "reason": "sid-changed", "from": "personal/997b1e",
                                 "to": "enterprise/425f63", "page_s": 540.4, "visible": True,
                                 "note": "a b=c\nfake=line", "nested": {"x": 1}, "Bad-Key": 1}),
            await _send(client, {"type": "anything-else", "reason": "x"}),
            await _send(client, b"not json"),
            await _send(client, {"type": "boot", "pad": "x" * 5000}),
        ]
    finally:
        await client.close()

    assert statuses == [204, 204, 204, 204]  # 页面不用管结果
    lines = [record.getMessage() for record in caplog.records if record.name == "entry.client"]
    assert len(lines) == 1
    line = lines[0]
    assert line.startswith("client reload who=personal:587030ca-d506 sid=997b1e ip=123.127.62.1 ua=Chrome/131/Win ")
    assert "secret" not in line  # 只留会话 ID 前 6 位
    assert "reason=sid-changed from=personal/997b1e to=enterprise/425f63 page_s=540 visible=1" in line
    assert "note=a_b_c_fake_line" in line and "\n" not in line
    assert "nested" not in line and "Bad-Key" not in line


@pytest.mark.asyncio
async def test_one_address_cannot_flood_the_log_and_the_drop_is_reported(caplog) -> None:
    now = [0.0]
    client = await _client(ClientEvents(lambda request: None, clock=lambda: now[0]))
    caplog.set_level(logging.INFO, logger="entry.client")
    try:
        for _ in range(ClientEvents.PER_MINUTE + 5):
            await _send(client, {"type": "link", "state": "closed"})
        await _send(client, {"type": "link", "state": "closed"}, ip="10.0.0.9")  # 别的地址不受影响
        now[0] = 61.0
        await _send(client, {"type": "link", "state": "restored"})
    finally:
        await client.close()

    lines = [record.getMessage() for record in caplog.records if record.name == "entry.client"]
    assert len(lines) == ClientEvents.PER_MINUTE + 2
    assert sum("ip=10.0.0.9" in line for line in lines) == 1
    assert lines[-1].startswith("client link who=-") and "限频丢了" in lines[-1]
