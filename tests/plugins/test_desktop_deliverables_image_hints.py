"""看不到图的主模型：Hermes 的 vision_analyze 看图提示换成元景写法；上传提醒的看图规则按主模型分开。"""

import copy
from xml.etree import ElementTree

import pytest

from tests.plugins.test_desktop_deliverables_fallback import delivery  # noqa: F401
from tests.plugins.test_desktop_deliverables_uploads import uploads  # noqa: F401

TOOL = "mcp__UniAI_Toolkit__analyze_image"
HIDDEN = {"agent": {"disabled_toolsets": ["vision"]}}


@pytest.fixture
def hints(uploads, monkeypatch):  # noqa: F811
    """接了元景看图工具、vision 工具组被关掉的桌面账号；配置可在用例里换。"""
    from fallback_delivery import image_hints as module

    uploads.state.tools.add(TOOL)
    config = {"value": HIDDEN}
    monkeypatch.setattr(module, "settings", lambda: config["value"])
    (rewrite,) = uploads.middleware["llm_request"]
    uploads.hints, uploads.config, uploads.rewrite = module, config, rewrite
    return uploads


def attached(image):
    """用 Hermes 自己的函数生成桌面附图消息，Hermes 改写法时这里会跟着失败。"""
    from tui_gateway.server import _build_image_ref_message

    return _build_image_ref_message("分析图片", [str(image)])


def test_desktop_image_hint_names_the_uniai_tool_and_keeps_the_path(hints):
    """附图提示换成元景工具全名和 image_url_or_oss_path，路径和用户文字不变，原请求不被改动。"""
    image = hints.home / "猫 咪.png"
    image.write_bytes(b"png")
    request = {"model": "glm-5.2", "messages": [
        {"role": "system", "content": "vision_analyze 说明"},
        {"role": "user", "content": attached(image)},
    ]}
    before = copy.deepcopy(request)
    result = hints.rewrite(request=request, platform="desktop", model="glm-5.2")
    text = result["request"]["messages"][1]["content"]
    assert f"[The user attached an image: {image.name}]" in text
    assert f"[看这张图请用元景的 {TOOL}：image_url_or_oss_path 填 {image}，prompt 写要问的问题]" in text
    assert "vision_analyze" not in text and text.endswith("分析图片")
    assert result["request"]["messages"][0] == before["messages"][0]
    assert request == before


def test_mixed_content_and_switched_model_note_are_rewritten(hints):
    """图文混排消息里的文字段也换；中途换成看不到图的模型后补的“细看”一句同样换掉。"""
    note = (
        "[The user attached an image. Here's what it contains:\n一只猫]"
        "\n[If you need a closer look, use vision_analyze with image_url: https://x.cn/a.png]"
    )
    request = {"messages": [{"role": "user", "content": [
        {"type": "text", "text": note},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
    ]}]}
    parts = hints.rewrite(request=request, platform="desktop")["request"]["messages"][0]["content"]
    assert parts[0]["text"].endswith(
        f"[需要细看时用元景的 {TOOL}：image_url_or_oss_path 填 https://x.cn/a.png，prompt 写要问的问题]"
    )
    assert parts[1] == request["messages"][0]["content"][1]


def test_hint_is_kept_when_vision_works_or_uniai_is_missing(hints):
    """其他消息渠道、vision_analyze 配了看图模型能真看、或没接元景看图工具时，原样不动。"""
    image = hints.home / "a.png"
    image.write_bytes(b"png")
    request = {"messages": [{"role": "user", "content": attached(image)}]}
    assert hints.rewrite(request=request, platform="telegram") is None
    assert hints.rewrite(request=request, platform="wecom_callback") is None
    hints.config["value"] = {"auxiliary": {"vision": {"provider": "openrouter", "model": "qwen-vl"}}}
    assert hints.rewrite(request=request, platform="desktop") is None
    hints.config["value"] = HIDDEN
    hints.state.tools.discard(TOOL)
    assert hints.rewrite(request=request, platform="desktop") is None
    # 助手消息里的同样文字不是 Hermes 的附图提示，不动。
    hints.state.tools.add(TOOL)
    assistant = {"messages": [{"role": "assistant", "content": attached(image)}]}
    assert hints.rewrite(request=assistant, platform="desktop") is None


@pytest.mark.parametrize(
    ("sees", "config", "expected", "absent"),
    [
        (False, HIDDEN, "要看懂图片内容，用该工具箱的 analyze_image。", "直接看"),
        (True, HIDDEN, "消息里附带的图片你能直接看到，直接看，不要再调用工具看图。只给了路径", "要看懂图片内容"),
        (True, {}, "消息里附带的图片你能直接看到，直接看，不要再调用工具看图。", "analyze_image"),
    ],
)
def test_upload_reminder_look_rule_follows_the_main_model(hints, monkeypatch, sees, config, expected, absent):
    """看不到图的走元景；能看图的直接看附图，vision 关着时只给路径的图才用元景，开着时交给 vision_analyze。"""
    seen = []
    monkeypatch.setattr(hints.hints, "main_model_sees", lambda model="": seen.append(model) or sees)
    hints.config["value"] = config
    result = hints.hooks["pre_llm_call"][-1](session_id="s", user_message="看图", model="deepseek-v4.1-flash")
    text = ElementTree.fromstring(result["context"]).text
    assert expected in text and absent not in text.split("不要写代码上传。")[1]
    assert seen == ["deepseek-v4.1-flash"]


@pytest.mark.parametrize("outcome", ["seen", "unseen", "error"])
@pytest.mark.parametrize("platform", ["weixin", "feishu", "wecom", "dingtalk", "uniagentgate"])
def test_gateway_vision_notes_are_rewritten_for_delivery_platforms(hints, monkeypatch, platform, outcome):
    """用网关自己的预先看图生成三种写法：都换成元景看图，路径不带看清时多出的“ ~”。"""
    import asyncio
    import json

    import tools.vision_tools as vision
    from gateway.run_inbound import GatewayInboundMixin

    # hints.home 是附件目录，它的上一级才是账号 Home。
    image = hints.home.parent / "cache" / "images" / "img_微信 图.jpg"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"jpg")

    async def analyze(**_):
        """按用例返回网关预先看图的成功、看不清或直接出错。"""
        if outcome == "error":
            raise RuntimeError("vision down")
        return json.dumps({"success": outcome == "seen", "analysis": "一只猫"})

    monkeypatch.setattr(vision, "vision_analyze_tool", analyze)
    text = asyncio.run(GatewayInboundMixin._enrich_message_with_vision(None, "把它做成视频", [str(image)]))
    assert "vision_analyze" in text
    request = {"messages": [{"role": "user", "content": text}]}
    rewritten = hints.rewrite(request=request, platform=platform)["request"]["messages"][0]["content"]
    assert "vision_analyze" not in rewritten and rewritten.endswith("把它做成视频")
    assert f"image_url_or_oss_path 填 {image}，prompt" in rewritten
