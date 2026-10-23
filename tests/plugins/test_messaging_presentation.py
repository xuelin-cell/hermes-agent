"""消息展示边界：真实通知入口与平台方法，不连接外部平台。"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import SendResult
from gateway.run_notifications import GatewayNotificationsMixin
from gateway.run_turn import GatewayTurnMixin
from plugins.platforms.dingtalk.adapter import DingTalkAdapter
from plugins.platforms.feishu.adapter import FeishuAdapter
from plugins.platforms.wecom.adapter import WeComAdapter
from plugins.platforms.weixin import DesktopWeixinAdapter

ADAPTERS = [
    (Platform.DINGTALK, DingTalkAdapter),
    (Platform.FEISHU, FeishuAdapter),
    (Platform.WECOM, WeComAdapter),
]
ALL_ADAPTERS = ADAPTERS + [(Platform.WEIXIN, DesktopWeixinAdapter)]


def home_notice(platform):
    """构造当前核心发送的完整教程，避免宽泛关键词过滤。"""
    return (
        f"📬 No home channel is set for {platform.value.title()}. "
        "A home channel is where Hermes delivers cron job results and cross-platform "
        "messages.\n\nType /sethome to make this chat your home channel, or ignore to skip."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ADAPTERS)
async def test_home_notice_uses_dedicated_interface_without_filtering_normal_replies(
    platform, adapter_type
):
    """经真实网关通知入口隐藏教程；普通回复即使逐字引用教程也照常发送。"""
    adapter = adapter_type(
        PlatformConfig(extra={"desktop_quiet": True, "notice_delivery": "private"})
    )
    adapter.send = AsyncMock(return_value=SendResult(success=True))
    source = SimpleNamespace(
        platform=platform, chat_id="fixture-chat", user_id="fixture-user"
    )
    metadata = {"thread_id": "fixture-thread"}
    runner = SimpleNamespace(
        _delivery_adapter_for=lambda _: adapter,
        _thread_metadata_for_source=lambda _: metadata,
        config=GatewayConfig(),
        async_session_store=SimpleNamespace(
            has_any_sessions=AsyncMock(return_value=True)
        ),
    )
    runner._deliver_platform_notice = (
        GatewayNotificationsMixin._deliver_platform_notice.__get__(runner)
    )
    tutorial = home_notice(platform)
    await GatewayTurnMixin._hmwa_first_contact_notes(runner, source, [], [])
    adapter.send.assert_not_awaited()
    await adapter.send(source.chat_id, tutorial, metadata=metadata)
    adapter.send.assert_awaited_once_with(source.chat_id, tutorial, metadata=metadata)
    adapter.send.reset_mock()
    failure = "⚠️ Something went wrong. Use /retry."
    await GatewayNotificationsMixin._deliver_platform_notice(runner, source, failure)
    assert adapter.send.await_args.kwargs["content"] == failure


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ADAPTERS)
async def test_non_desktop_notice_and_near_match_are_not_hidden(platform, adapter_type):
    """未启用桌面策略的适配器与非目标通知继续沿用原发送方法。"""
    adapter = adapter_type(PlatformConfig())
    adapter.send = AsyncMock(return_value=SendResult(success=True))
    await adapter.send_private_notice("chat", "user", home_notice(platform))
    adapter.send.assert_awaited_once()
    adapter.send.reset_mock()
    adapter.config.extra["desktop_quiet"] = True
    await adapter.send_private_notice(
        "chat", "user", "用户引用：" + home_notice(platform)
    )
    assert adapter.send.await_args.kwargs["content"].startswith("用户引用：")


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ALL_ADAPTERS)
async def test_chinese_clarify_preserves_real_multiselect_and_typed_resolution(
    platform, adapter_type
):
    """真实澄清注册、中文多选说明及文本作答不改变问题内容和原版解析。"""
    from tools import clarify_gateway as clarify

    adapter = adapter_type(PlatformConfig(extra={"desktop_quiet": True}))
    adapter.send = AsyncMock(return_value=SendResult(success=True))
    entry = clarify.register(
        "fixture-clarify",
        f"fixture-{platform.value}",
        "Choose English code",
        ["A", "B"],
        True,
    )
    try:
        await adapter.send_clarify(
            "chat", entry.question, entry.choices, entry.clarify_id, entry.session_key
        )
        text = adapter.send.await_args.kwargs["content"]
        assert "可多选" in text and "Choose English code" in text and "1. A" in text
        clarify.resolve_text_response_for_session(entry.session_key, "1, 2")
        assert entry.event.is_set() and entry.response == '["A", "B"]'
    finally:
        clarify.wait_for_response(entry.clarify_id, 0.01)


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ALL_ADAPTERS)
@pytest.mark.parametrize("choice", ["once", "always", "cancel"])
async def test_chinese_reset_confirm_uses_registered_core_actions(
    platform, adapter_type, choice
):
    """不自动批准，中文说明仍驱动原登记的动作；重复回答不会再次执行。"""
    from tools import slash_confirm

    adapter = adapter_type(PlatformConfig(extra={"desktop_quiet": True}))
    adapter.send = AsyncMock(return_value=SendResult(success=True))
    handler = AsyncMock(return_value="original-result")
    key = f"fixture-{platform.value}"
    slash_confirm.register(key, "fixture-confirm", "new", handler)
    result = await adapter.send_slash_confirm(
        "chat", "Confirm", "original prompt", key, "fixture-confirm"
    )
    assert result.success and handler.await_count == 0
    text = adapter.send.await_args.kwargs["content"]
    assert "请确认 /new" in text and all(
        command in text for command in ["/approve", "/always", "/cancel"]
    )
    assert (
        await slash_confirm.resolve(key, "fixture-confirm", choice) == "original-result"
    )
    handler.assert_awaited_once_with(choice)
    assert await slash_confirm.resolve(key, "fixture-confirm", choice) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ALL_ADAPTERS)
async def test_approval_choices_preserve_safety_and_native_feishu_card(
    platform, adapter_type
):
    """受限选项不增加权限；原生命令、按钮动作和飞书审批登记沿用原版。"""
    adapter = adapter_type(PlatformConfig(extra={"desktop_quiet": True}))
    adapter.send = AsyncMock(return_value=SendResult(success=True))
    if platform == Platform.FEISHU:
        adapter._client = object()
        adapter._send_interactive_card = AsyncMock(
            return_value=SendResult(success=True)
        )
    assert adapter._exec_approval_actions(
        allow_permanent=True, allow_session=False, smart_denied=False
    ) == [("仅本次允许", "once", "primary"), ("拒绝", "deny", "danger")]
    assert [
        a[1]
        for a in adapter._exec_approval_actions(
            allow_permanent=True, allow_session=True, smart_denied=True
        )
    ] == ["once", "deny"]
    result = await adapter.send_exec_approval(
        "chat", "echo 'English 用户引用'", "session", allow_session=False
    )
    assert result.success
    if platform == Platform.FEISHU:
        card = adapter._send_interactive_card.await_args.args[1]
        assert (
            "需要你确认" in str(card)
            and "approve_once" in str(card)
            and "approve_always" not in str(card)
        )
        assert (
            adapter._send_interactive_card.await_args.kwargs["state_map"]
            is adapter._approval_state
        )
    else:
        text = adapter.send.await_args.kwargs["content"]
        assert "echo 'English 用户引用'" in text and "秒内未确认则不会执行" in text
        assert "/approve always" not in text and "/deny" in text


def test_weixin_real_discovery_and_reload_preserve_native_protocol_and_dependencies():
    """真实发现、延迟注册和重载微信；协议、媒体、typing 与依赖探测不替换。"""
    from gateway.platform_registry import platform_registry
    from gateway.platforms.weixin import WeixinAdapter, check_weixin_requirements
    from hermes_cli.plugins import PluginManager

    manager = PluginManager()
    for force in [False, True]:
        manager.discover_and_load(force=force)
        entry = platform_registry.get("weixin")
        assert entry and entry.check_fn is check_weixin_requirements
        adapter = platform_registry.create_adapter(
            "weixin", PlatformConfig(token="fixture", extra={"account_id": "fixture"})
        )
        assert isinstance(adapter, DesktopWeixinAdapter)
        for method in [
            "connect",
            "disconnect",
            "send",
            "send_image_file",
            "send_document",
            "send_typing",
            "stop_typing",
        ]:
            assert getattr(type(adapter), method) is getattr(WeixinAdapter, method)


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ALL_ADAPTERS)
@pytest.mark.parametrize("mode", ["steer", "interrupt", "queue"])
async def test_busy_ack_off_still_processes_input_without_replaying_successful_steer(
    platform, adapter_type, mode, monkeypatch
):
    """走真实忙碌入口，静默只影响回执；追加、打断与队列输入仍按原规则处理。"""
    from unittest.mock import MagicMock
    from gateway.platforms.base import SessionSource, build_session_key
    from gateway.platforms.event import MessageEvent, MessageType
    from tests.gateway.test_busy_session_ack import _make_adapter, _make_runner

    runner, _ = _make_runner()
    runner._busy_input_mode = mode
    source = SessionSource(
        platform=platform,
        chat_id="fixture-chat",
        chat_type="dm",
        user_id="fixture-user",
    )
    event = MessageEvent(
        text="补充要求 English", source=source, message_type=MessageType.TEXT
    )
    key = build_session_key(source)
    adapter = _make_adapter(platform.value)
    runner.adapters[platform] = adapter
    agent = MagicMock()
    agent.steer.return_value = True
    runner._running_agents[key] = agent
    monkeypatch.setenv("HERMES_GATEWAY_BUSY_ACK_ENABLED", "false")
    assert await runner._handle_active_session_busy_message(event, key)
    adapter._send_with_retry.assert_not_awaited()
    if mode == "steer":
        assert agent.steer.call_args.args[0].endswith(event.text)
        assert key not in adapter._pending_messages
    else:
        assert adapter._pending_messages[key].text == event.text
        if mode == "interrupt":
            agent.interrupt.assert_called_once_with(event.text)
