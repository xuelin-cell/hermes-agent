"""微信展示插件在关闭原生通道前发送必要中文提醒，传输响应受控。"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import HomeChannel, Platform, PlatformConfig
from gateway.platform_registry import platform_registry
from gateway.run_adapters import GatewayAdapterLifecycleMixin
from hermes_cli.plugins import PluginManager
from plugins.platforms.weixin import DesktopWeixinAdapter

NOTICE = (
    "⚠️ 微信连接即将断开，正在处理的回复可能中断。"
    "连接恢复前，无法接收或回复新消息。请在 UniWork 中检查微信连接。"
)


@pytest.fixture
def transport(monkeypatch):
    """真实发现插件，只替换网络会话和轮询，保留原版连接、发送与断开实现。"""
    from gateway.platforms import weixin

    sessions = []

    def session(**_):
        """记录通道关闭顺序，不打开外部网络连接。"""
        result = SimpleNamespace(closed=False)

        async def close():
            """模拟 HTTP 通道完成关闭。"""
            result.closed = True

        result.close = close
        sessions.append(result)
        return result

    async def poll(_):
        """保留可取消的原生轮询任务，不请求真实微信。"""
        await asyncio.Event().wait()

    send = AsyncMock(return_value={"ret": 0})
    monkeypatch.setattr(weixin, "_new_session", session)
    monkeypatch.setattr(weixin.WeixinAdapter, "_poll_loop", poll)
    monkeypatch.setattr(weixin, "_send_message", send)
    return SimpleNamespace(send=send, sessions=sessions)


@pytest.mark.asyncio
async def test_disconnect_notice_uses_own_binding_once_and_rearms_after_connect(
    transport, tmp_path, monkeypatch
):
    """A→B→A 原生生命周期只通知本账号，重连后可再提示，并发断开只发一次。"""
    for account in ("a", "b", "a"):
        home = tmp_path / account
        home.mkdir(exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        PluginManager().discover_and_load(force=True)
        config = PlatformConfig(
            token=f"fixture-token-{account}",
            home_channel=HomeChannel(
                platform=Platform.WEIXIN, chat_id=f"owner-{account}", name="fixture"
            ),
            extra={"account_id": f"fixture-{account}", "desktop_quiet": True},
        )
        adapter = platform_registry.create_adapter("weixin", config)
        assert isinstance(adapter, DesktopWeixinAdapter)
        for reconnect in (False, True):
            transport.send.reset_mock()
            assert await adapter.connect(is_reconnect=reconnect)
            sending = adapter._send_session

            async def delivered(session, **kwargs):
                """提醒必须在原通道还打开时发送，目标和凭据均来自当前账号。"""
                assert session is sending and not session.closed
                assert kwargs["text"] == NOTICE
                assert kwargs["to"] == f"owner-{account}"
                assert kwargs["token"] == config.token
                await asyncio.sleep(0)
                return {"ret": 0}

            transport.send.side_effect = delivered
            await asyncio.gather(
                GatewayAdapterLifecycleMixin()._bounded_adapter_teardown(
                    adapter, Platform.WEIXIN
                ),
                adapter.disconnect(),
            )
            transport.send.assert_awaited_once()
            assert adapter._send_session is None and adapter._poll_task is None
            assert not adapter._running and all(
                session.closed for session in transport.sessions
            )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "unstarted",
        "not_quiet",
        "no_target",
        "wrong_platform",
        "closed",
        "failed",
        "raised",
        "timeout",
        "cancelled",
    ],
)
async def test_disconnect_skip_and_send_failure_always_preserve_native_cleanup(
    case, transport, tmp_path, monkeypatch
):
    """无有效通道或接收人不发；提醒失败、超时、取消仍关闭原生会话且不重复通知。"""
    from plugins.platforms.weixin import adapter as module

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    PluginManager().discover_and_load(force=True)
    adapter = platform_registry.create_adapter(
        "weixin",
        PlatformConfig(
            token="fixture-token",
            extra={"account_id": "fixture", "desktop_quiet": case != "not_quiet"},
            home_channel=None
            if case == "no_target"
            else HomeChannel(
                platform=Platform.FEISHU
                if case == "wrong_platform"
                else Platform.WEIXIN,
                chat_id="owner",
                name="fixture",
            ),
        ),
    )
    if case != "unstarted":
        assert await adapter.connect()
    if case == "closed":
        adapter._send_session.closed = True
    if case in ("failed", "raised"):
        adapter.send = AsyncMock(return_value=SimpleNamespace(success=False))
        if case == "raised":
            adapter.send.side_effect = RuntimeError("fixture failure")
    started = asyncio.Event()

    async def hanging(*_, **__):
        """通知悬挂时由自身超时或调用方取消，不能影响原生资源清理。"""
        started.set()
        await asyncio.Event().wait()

    if case in ("timeout", "cancelled"):
        transport.send.side_effect = hanging
        if case == "timeout":
            monkeypatch.setattr(module, "DISCONNECT_NOTICE_TIMEOUT", 0.02)
    task = asyncio.create_task(adapter.disconnect())
    if case == "cancelled":
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        await asyncio.wait_for(task, 3)
    await adapter.disconnect()
    assert adapter._send_session is None and adapter._poll_task is None
    assert not adapter._running and all(
        session.closed for session in transport.sessions
    )
    if case in ("unstarted", "not_quiet", "no_target", "wrong_platform", "closed"):
        transport.send.assert_not_awaited()
    elif case in ("failed", "raised"):
        adapter.send.assert_awaited_once()
    else:
        transport.send.assert_awaited_once()
