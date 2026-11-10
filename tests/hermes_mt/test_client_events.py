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
from entry.sso import SsoIdentity, parse_networks

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
async def test_limits_are_per_session_and_the_ip_is_the_client_behind_the_gateway(caplog) -> None:
    """所有请求都经 .116 转发：按直连地址限频就是全体用户共用一份额度，日志里也全是网关地址。"""
    now = [0.0]

    def identity_of(request):
        sid = request.headers.get("X-Test-Sid", "")
        return SsoIdentity(uid=f"u-{sid}", account_type="personal", tenant_id="", sid=sid) if sid else None

    events = ClientEvents(identity_of, lambda: parse_networks("192.168.212.0/24"), clock=lambda: now[0])
    client = await _client(events)
    caplog.set_level(logging.INFO, logger="entry.client")

    async def send(sid: str, state: str) -> None:
        await client.post("/agents/api/__entry/client-event", data=json.dumps({"type": "link", "state": state}),
                          headers={"X-Real-IP": "192.168.212.116", "X-Test-Sid": sid,
                                   # 最左边是客户端自己带的（可伪造），往右是网关追加的真实来源和网关自己
                                   "X-Forwarded-For": "6.6.6.6, 123.127.62.1, 192.168.212.116"})
    try:
        for _ in range(ClientEvents.PER_MINUTE + 5):
            await send("aaaaaa111", "closed")
        await send("bbbbbb222", "closed")  # 同一网关、同一办公室出口，另一个会话不受影响
        now[0] = 61.0
        await send("aaaaaa111", "restored")
    finally:
        await client.close()

    lines = [record.getMessage() for record in caplog.records if record.name == "entry.client"]
    assert len(lines) == ClientEvents.PER_MINUTE + 2
    assert sum("sid=bbbbbb" in line for line in lines) == 1
    assert all("ip=123.127.62.1 " in line for line in lines)
    assert "sid=aaaaaa" in lines[-1] and "限频丢了 5 条" in lines[-1]
