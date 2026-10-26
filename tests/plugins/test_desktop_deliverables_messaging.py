"""消息平台复用桌面的本机成品交付：下载、去链接、补附件引用，并经网关原版流程发出附件。"""

import asyncio
import json
import os

import pytest

from tests.plugins.desktop_deliverables_generated_fixture import run_scenario
from tests.plugins.desktop_deliverables_http_fixture import serving
from tests.plugins.test_desktop_deliverables_downloads import call
from tests.plugins.test_desktop_deliverables_fallback import begin, delivery, finish  # noqa: F401


def start(plugin, platform="weixin", session="s", turn="t", message=""):
    """按网关的参数开始一轮消息会话。"""
    return plugin.before_turn(
        session_id=session, turn_id=turn, task_id=session, platform=platform, user_message=message
    )


def reply(plugin, text, platform="weixin", session="s", turn="t"):
    """按网关的参数结束一轮，返回插件改写后的回复；不改时为 None。"""
    return plugin.transform(session_id=session, turn_id=turn, platform=platform, response_text=text)


def dispatch(text, platform):
    """把回复交给网关原版的拆附件、路径检查和分派流程，记录平台发送方法实际收到的内容。"""
    from gateway.config import Platform, PlatformConfig
    from gateway.platforms.base import BasePlatformAdapter, SendResult
    from gateway.platforms.event import MessageEvent, MessageType
    from gateway.session import SessionSource, build_session_key

    sent = []

    class Recorder(BasePlatformAdapter):
        """只记录发送调用，不连接真实平台。"""

        async def connect(self, *, is_reconnect=False):
            """无需连接。"""
            return True

        async def disconnect(self):
            """无需断开。"""

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            """记录文字消息。"""
            sent.append(("text", content))
            return SendResult(success=True, message_id="text")

        async def send_typing(self, chat_id, metadata=None):
            """不显示输入状态。"""

        async def get_chat_info(self, chat_id):
            """返回最简会话信息。"""
            return {"id": chat_id}

        async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
            """记录图片附件。"""
            sent.append(("image", str(image_path)))
            return SendResult(success=True, message_id="image")

        async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
            """记录视频附件。"""
            sent.append(("video", str(video_path)))
            return SendResult(success=True, message_id="video")

        async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
            """记录语音附件。"""
            sent.append(("voice", str(audio_path)))
            return SendResult(success=True, message_id="voice")

        async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None,
                                metadata=None, **kwargs):
            """记录文件附件。"""
            sent.append(("document", str(file_path)))
            return SendResult(success=True, message_id="document")

    async def hold_typing(_chat_id, interval=2.0, metadata=None, stop_event=None):
        """保持输入状态直到本轮结束。"""
        if stop_event is not None:
            await stop_event.wait()

    async def handler(_event):
        """把插件改写后的回复作为本轮结果交给网关。"""
        return text

    adapter = Recorder(PlatformConfig(enabled=True, token="fake-token"), Platform(platform))
    adapter._keep_typing = hold_typing
    adapter.set_message_handler(handler)
    event = MessageEvent(
        text="生成", message_type=MessageType.TEXT, message_id="m",
        source=SessionSource(platform=Platform(platform), chat_id="chat", chat_type="dm"),
    )
    asyncio.run(adapter._process_message_background(event, build_session_key(event.source)))
    return sent


@pytest.mark.parametrize("platform,kind,method", [
    ("weixin", "image", "image"),
    ("feishu", "video", "video"),
    ("wecom", "video", "video"),
    ("dingtalk", "image", "image"),
    ("weixin", "audio", None),
])
def test_message_generation_is_downloaded_and_sent_as_attachment(tmp_path, platform, kind, method):
    """真实模型循环、工具、下载和持久化后，回复只说“完成了”也补上附件；网关发出附件，文字里没有路径和链接。"""
    receipt = run_scenario(tmp_path, kind, platform=platform)
    assert receipt["text"].count("MEDIA:") == 1 and receipt["url"] not in receipt["text"]
    sent = dispatch(receipt["text"], platform)
    files = [item for item in sent if item[0] != "text"]
    assert [path for _, path in files] == [receipt["path"]]
    assert method is None or files[0][0] == method
    assert all("MEDIA:" not in body and receipt["path"] not in body for kind, body in sent if kind == "text")


@pytest.mark.parametrize("platform,kind", [("dingtalk", "video"), ("telegram", "image"), ("wecom_callback", "image")])
def test_other_message_cases_keep_their_original_link_behavior(tmp_path, platform, kind):
    """钉钉视频、其他平台和企业微信回调模式不下载，原链接留在工具结果里，不补附件。"""
    receipt = run_scenario(tmp_path, kind, platform=platform)
    assert "MEDIA:" not in receipt["text"]


@pytest.mark.parametrize("platform", ["weixin", "desktop"])
def test_background_result_is_attached_even_when_parent_reply_omits_it(tmp_path, platform):
    """后台完成后父会话模型没抄 MEDIA，插件仍按完成通知补上唯一一份。"""
    receipt = run_scenario(tmp_path, "background-video", platform=platform, echo=False)
    assert receipt["text"].count("MEDIA:") == 1


def test_message_turn_never_watches_folders_or_invalidates_desktop(delivery):  # noqa: F811
    """消息会话不加 .tmp 提醒、不扫描目录、不猜文件，也不让同一目录的桌面会话丢卡片。"""
    plugin, work = delivery
    begin(plugin, session="desktop")
    assert start(plugin) is None
    plugin.before_tool(tool_name="terminal", args={}, session_id="s", turn_id="t", tool_call_id="x")
    output = work / "报告.pdf"
    output.write_bytes(b"pdf")
    plugin.after_tool(
        tool_name="write_file", args={"path": str(output)}, status="ok", session_id="s", turn_id="t"
    )
    assert reply(plugin, f"写好了：{output}") is None
    assert str(output) in finish(plugin, session="desktop")


def test_message_downloads_drop_links_unless_too_large_to_attach(delivery, monkeypatch):  # noqa: F811
    """20MB 以内去掉链接只发附件；超过的保留链接兜底；两份成品都补成附件引用。"""
    plugin, work = delivery
    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    from fallback_delivery import downloads

    start(plugin)
    with serving() as (base, _requests):
        small = base + "/图.png?signature=private"
        data = json.loads(call(plugin, "mcp__server__txt2img_generate", json.dumps({"url": small})))
        assert "url" not in data and "signature=private" not in json.dumps(data)
        assert "附件" in data["delivery_note"] and "desktop_note" not in data
        monkeypatch.setattr(downloads, "ATTACH_BYTES", 4)
        large = base + "/片.mp4"
        data = json.loads(call(plugin, "mcp__server__txt2vid_generate", json.dumps({"url": large})))
        assert data["url"] == large and "超过 20MB" in data["delivery_note"]
    outputs = sorted((work / "outputs").iterdir())
    text = reply(plugin, "都好了。")
    assert text.startswith("都好了。") and all(text.count(f"MEDIA:{path}") == 1 for path in outputs)


@pytest.mark.parametrize("platform,tool", [("dingtalk", "txt2vid_generate"), ("telegram", "txt2img_generate")])
def test_message_results_outside_the_delivery_rules_are_untouched(delivery, monkeypatch, platform, tool):  # noqa: F811
    """钉钉视频和其他平台不下载，工具结果原样保留链接。"""
    plugin, _ = delivery
    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    start(plugin, platform=platform)
    with serving() as (base, requests):
        assert call(plugin, "mcp__server__" + tool, json.dumps({"url": base + "/a.mp4"})) is None
        assert not requests


def test_background_result_waits_for_its_notice_and_survives_an_interrupted_turn(delivery, tmp_path, monkeypatch):  # noqa: F811
    """完成通知前不提前补；完成那轮被打断后由下一轮补上且只补一次；别的会话、别的账号拿不到。"""
    plugin, work = delivery
    video = work / "outputs" / "生成视频.mp4"
    video.parent.mkdir()
    video.write_bytes(b"video")
    start(plugin, turn="submit", message="做个视频")
    plugin.background.remember_child(parent_session_id="s", child_session_id="child")
    assert reply(plugin, "已提交。", turn="submit") is None
    start(plugin, platform="subagent", session="child", turn="c")
    plugin.background.remember_results("child", [video])
    plugin.end_turn(session_id="child", turn_id="c")
    start(plugin, turn="chat", message="好了吗")
    assert reply(plugin, "还在生成。", turn="chat") is None
    # 完成通知那一轮被打断：网关丢弃回复，插件只收到这一轮的结束信号。
    start(plugin, turn="notice", message=f"[ASYNC DELEGATION COMPLETE]\n生成完成。\nMEDIA:{video}")
    plugin.end_turn(session_id="s", turn_id="notice", interrupted=True)
    start(plugin, session="other", turn="o", message=f"MEDIA:{video}")
    assert reply(plugin, "别的会话。", session="other", turn="o") is None
    home = os.environ["HERMES_HOME"]
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "account-b"))
    start(plugin, turn="b")
    assert reply(plugin, "另一个账号。", turn="b") is None
    monkeypatch.setenv("HERMES_HOME", home)
    start(plugin, turn="next", message="收到图片")
    assert reply(plugin, "收到图片。", turn="next") == f"收到图片。\n\nMEDIA:{video}"
    start(plugin, turn="after")
    assert reply(plugin, "好的。", turn="after") is None
