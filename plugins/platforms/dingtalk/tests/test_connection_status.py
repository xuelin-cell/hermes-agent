"""钉钉连接状态只依据 Stream 握手，不以创建客户端代替成功。"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import PlatformConfig
from plugins.platforms.dingtalk import adapter as dt


@pytest.mark.asyncio
async def test_stream_status_tracks_handshake_disconnect_and_recovery(monkeypatch):
    """执行正式适配器生命周期，以受控套接字模拟 SDK 连接状态。"""
    from websockets.protocol import State

    client = SimpleNamespace(websocket=None, start=AsyncMock(), register_callback_handler=MagicMock())
    hold = asyncio.Event()
    client.start.side_effect = hold.wait
    monkeypatch.setattr(dt, "DINGTALK_STREAM_AVAILABLE", True)
    monkeypatch.setattr(dt, "HTTPX_AVAILABLE", True)
    monkeypatch.setattr(dt, "CARD_SDK_AVAILABLE", False)
    monkeypatch.setattr(dt, "dingtalk_stream", SimpleNamespace(
        Credential=lambda *a: None, DingTalkStreamClient=lambda *a: client,
        ChatbotMessage=SimpleNamespace(TOPIC="fixture"),
    ))
    monkeypatch.setattr(dt.httpx, "AsyncClient", lambda **kw: AsyncMock())
    adapter = dt.DingTalkAdapter(PlatformConfig(extra={"client_id": "fixture", "client_secret": "secret"}))
    monkeypatch.setattr(adapter, "_wire_plugin_handlers", lambda *a: None)
    states = []
    monkeypatch.setattr(adapter, "_write_runtime_status_safe", lambda context, **kw: states.append(kw["platform_state"]))
    assert await adapter.connect()
    try:
        assert adapter.send_path_degraded
        assert states == ["retrying"]
        client.websocket = SimpleNamespace(state=State.OPEN, close=AsyncMock())
        await asyncio.sleep(0.6)
        assert states[-1] == "connected"
        client.websocket.state = State.CLOSED
        await asyncio.sleep(0.6)
        assert states[-1] == "retrying"
        client.websocket = SimpleNamespace(state=State.OPEN, close=AsyncMock())
        await asyncio.sleep(0.6)
        assert states[-1] == "connected"
    finally:
        await adapter.disconnect()
    assert states[-1] == "disconnected"
    count = len(states)
    await asyncio.sleep(0.6)
    assert len(states) == count


@pytest.mark.asyncio
async def test_real_sdk_and_local_websocket_handshake_reconnect(monkeypatch):
    """真实 SDK 连接本机随机端口，第二次握手完成前必须显示重连中。"""
    from websockets.asyncio.server import serve

    if not dt.DINGTALK_STREAM_AVAILABLE:
        pytest.skip("独立测试环境未安装仓库固定版本的 dingtalk-stream")
    accepted, reconnecting, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    sockets = []
    attempts = 0

    async def handshake(connection, request):
        """第二次握手等待测试放行，真实套接字尚未进入 OPEN。"""
        nonlocal attempts
        attempts += 1
        if attempts > 1:
            reconnecting.set()
            await release.wait()

    async def receive(socket):
        """仅维持连接，不发送消息或调用模型。"""
        sockets.append(socket)
        accepted.set()
        await socket.wait_closed()

    async def wait_state(expected):
        """有界等待生产观察器发布新状态。"""
        async with asyncio.timeout(3):
            while not states or states[-1] != expected:
                await asyncio.sleep(0.05)

    states = []
    monkeypatch.setattr(dt, "CARD_SDK_AVAILABLE", False)
    adapter = dt.DingTalkAdapter(PlatformConfig(extra={"client_id": "fixture", "client_secret": "secret"}))
    monkeypatch.setattr(adapter, "_wire_plugin_handlers", lambda *a: None)
    monkeypatch.setattr(adapter, "_write_runtime_status_safe", lambda context, **kw: states.append(kw["platform_state"]))
    async with serve(receive, "127.0.0.1", 0, process_request=handshake) as server:
        port = server.sockets[0].getsockname()[1]
        assert await adapter.connect()
        monkeypatch.setattr(adapter._stream_client, "open_connection", lambda: {
            "endpoint": f"ws://127.0.0.1:{port}", "ticket": "fixture",
        })
        try:
            assert states == ["retrying"]
            await asyncio.wait_for(accepted.wait(), 3)
            await wait_state("connected")
            await sockets[0].close()
            await asyncio.wait_for(reconnecting.wait(), 3)
            await wait_state("retrying")
            release.set()
            await wait_state("connected")
        finally:
            release.set()
            await adapter.disconnect()
        assert states[-1] == "disconnected"
