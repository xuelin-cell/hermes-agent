"""经原版状态与附件入口验证低打扰策略，不连接真实消息平台。"""

from importlib import import_module
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import SendResult
from gateway.run import _send_or_update_status_coro
from gateway.warning_notifications import warning_notifications_enabled
from hermes_cli.config import get_config_path, require_readable_config_before_write
from plugins.platforms.dingtalk.adapter import DingTalkAdapter
from plugins.platforms.feishu.adapter import FeishuAdapter
from plugins.platforms.wecom.adapter import WeComAdapter
from plugins.platforms.weixin import DesktopWeixinAdapter

policy = import_module("plugins.desktop-messaging.dashboard.presentation")
ADAPTERS = [
    (Platform.WEIXIN, DesktopWeixinAdapter),
    (Platform.DINGTALK, DingTalkAdapter),
    (Platform.FEISHU, FeishuAdapter),
    (Platform.WECOM, WeComAdapter),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ADAPTERS)
@pytest.mark.parametrize("quiet", [True, False])
async def test_status_is_silent_only_in_quiet_adapter(platform, adapter_type, quiet):
    """真实网关状态分发只静默受管平台；相同英文作为普通回复必须原样送出。"""
    adapter = adapter_type(PlatformConfig(extra={"desktop_quiet": quiet}))
    receipt = SendResult(success=True, message_id="receipt")
    adapter.send = AsyncMock(return_value=receipt)
    metadata = {"thread_id": "thread", "_interim_send": True}
    text = "Waiting for another session to release the model."
    result = await _send_or_update_status_coro(adapter, "chat", "lease", text, metadata)
    assert result.success
    if quiet:
        adapter.send.assert_not_awaited()
        assert result.message_id is None
    else:
        adapter.send.assert_awaited_once_with("chat", text, metadata=metadata)
        assert result is receipt
    adapter.send.reset_mock()
    await adapter.send("chat", text, metadata=metadata)
    adapter.send.assert_awaited_once_with("chat", text, metadata=metadata)


@pytest.mark.asyncio
@pytest.mark.parametrize("platform,adapter_type", ADAPTERS)
async def test_profile_policy_preserves_media_and_reports_failure_in_chinese(
    platform, adapter_type, tmp_path, monkeypatch
):
    """A→B→A 真实配置隔离；诊断隐藏不丢附件、附言、失败结果或其它平台设置。"""
    untouched = None
    for account in ("a", "b", "a"):
        home = tmp_path / account
        home.mkdir(exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        path = get_config_path()
        if not path.exists():
            path.write_text(
                "# keep\ndisplay: {suppress_warning_notifications: false}\n",
                encoding="utf-8",
                newline="\n",
            )
        if account == "b":
            untouched = path.read_bytes()
        else:
            policy.prepare_presentation({platform.value})
        config = require_readable_config_before_write(path)
        quiet = account == "a"
        assert warning_notifications_enabled(platform) is not quiet
        assert config["display"]["suppress_warning_notifications"] is False
        for other in ("gui", "uniagentgate", "telegram"):
            assert warning_notifications_enabled(other)
        if untouched is not None:
            assert (tmp_path / "b/config.yaml").read_bytes() == untouched

        adapter = adapter_type(PlatformConfig(extra={"desktop_quiet": quiet}))
        adapter.send = AsyncMock(
            return_value=SendResult(success=True, message_id="notice")
        )
        await adapter.emit_warning("chat", "I seem to be stuck.")
        assert adapter.send.await_count == (0 if quiet else 1)
        adapter.send.reset_mock()
        attachment = home / "sample.bin"
        attachment.write_bytes(b"fixture")
        metadata = {"thread_id": "thread", "_interim_send": True}

        # 成功降级仍执行原平台方法，不调用网络，只替换最终上传边界。
        if platform == Platform.WEIXIN:
            adapter._send_file_result = AsyncMock(return_value=SendResult(success=True))
            for caption in (None, "English caption"):
                await adapter.send_voice("chat", str(attachment), caption=caption)
                args = adapter._send_file_result.await_args.args
                assert args[2] == (
                    caption or ("" if quiet else "[voice message as attachment]")
                )
                assert (
                    adapter._send_file_result.await_args.kwargs["force_file_attachment"]
                    is True
                )
        if platform == Platform.FEISHU:
            adapter._download_remote_document = AsyncMock(
                return_value=(str(attachment), "sample.gif")
            )
            adapter.send_document = AsyncMock(return_value=SendResult(success=True))
            for caption in (None, "English caption"):
                await adapter.send_animation(
                    "chat",
                    "https://example.invalid/sample.gif",
                    caption=caption,
                    metadata=metadata,
                )
                sent = adapter.send_document.await_args.kwargs
                assert (
                    sent["file_path"] == str(attachment)
                    and sent["metadata"] == metadata
                )
                expected = (
                    caption
                    if quiet
                    else "[GIF downgraded to file]"
                    + (f"\n{caption}" if caption else "")
                )
                assert sent["caption"] == expected

        # 使用原版媒体分发，验证失败不会因诊断静默而被当作成功。
        failure = SendResult(success=False, error="fixture upload rejected")
        adapter.send_document = AsyncMock(return_value=failure)
        event = SimpleNamespace(source=SimpleNamespace(chat_id="chat"))
        results = []
        await adapter._deliver_media_attachments(
            event,
            [(str(attachment), False)],
            [],
            force_document_attachments=False,
            human_delay=0,
            metadata=metadata,
            record_delivery=results.append,
        )
        assert results == [failure]
        adapter.send.assert_awaited_once()
        args, kwargs = adapter.send.await_args
        content = args[1] if len(args) > 1 else kwargs["content"]
        assert ("附件未能发送" if quiet else "Couldn't deliver") in content
        assert str(home) not in content and "fixture upload rejected" not in content
        assert kwargs["metadata"] == metadata
        adapter.send.reset_mock()

        # 不支持的媒体沿原版返回失败，附言保留；外层仅补一次中文失败提示。
        if quiet and platform == Platform.DINGTALK:
            result = await adapter.send_voice(
                "chat", str(attachment), caption="caption", metadata=metadata
            )
            assert not result.success
            adapter.send.assert_awaited_once_with(
                "chat", "caption", reply_to=None, metadata=metadata
            )
            adapter.send.reset_mock()
            results = []
            await adapter._deliver_media_attachments(
                event,
                [(str(attachment), True)],
                [],
                force_document_attachments=False,
                human_delay=0,
                metadata=metadata,
                record_delivery=results.append,
            )
            assert len(results) == 1 and not results[0].success
            adapter.send.assert_awaited_once_with(
                "chat", "⚠️ 附件未能发送，请稍后重试。", metadata=metadata
            )

        if quiet:
            # 连失败提示也无法送达时不阻断后续附件，不改写上传失败结果。
            for notice_outcome in (
                SendResult(success=False, error="offline"),
                RuntimeError("offline"),
            ):
                adapter.send = AsyncMock(side_effect=[notice_outcome, notice_outcome])
                results = []
                await adapter._deliver_media_attachments(
                    event,
                    [(str(attachment), False)],
                    [str(attachment)],
                    force_document_attachments=False,
                    human_delay=0,
                    metadata=metadata,
                    record_delivery=results.append,
                )
                assert results == [failure, failure] and adapter.send.await_count == 2
