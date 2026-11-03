"""主模型看不到图时，把 Hermes 写给模型的 vision_analyze 看图提示换成元景 analyze_image。

Hermes 对看不到图的模型只发图片路径，附一行“用 vision_analyze 看、image_url 填路径”。桌面有元景套餐时
vision_analyze 被隐藏（或交给同样看不到图的主模型），模型改调元景 analyze_image 却照抄 image_url，
元景不认这个参数，当成没给图，甚至编出别的图的内容（10-22 实测）。这里只换这行提示，路径原样保留，
之后照常由上传中间件换成 ossPath。

看图模型发过图、之后换成看不到图的模型（或重启后从存档读回）时，消息里只剩附图路径和 Hermes
当场看图失败的说明；这两样也换成元景看图的写法，模型需要时自己去看，不预先替它看。
"""

import logging
import re

from . import uploads
from .background import DELIVERY_PLATFORMS

logger = logging.getLogger(__name__)
LEAF = "analyze_image"
# Hermes 原文：桌面附图的提示（tui_gateway/session_history.py），会话中途换成看不到图的模型后，
# 历史图片转成文字时补的一句（agent/vision_message_prep.py），以及消息网关预先看图后附的三种写法
# （gateway/run_inbound.py：看清了的路径后面多一个“ ~”，看不清和出错时让模型自己看）。
_HINTS = (
    (
        re.compile(r"\[Examine it with the vision_analyze tool using image_url: ([^\n]+?)\](?=\n|$)"),
        "[看这张图请用元景的 {tool}：image_url_or_oss_path 填 {path}，prompt 写要问的问题]",
    ),
    (
        re.compile(r"\[If you need a closer look, use vision_analyze with image_url: ([^\n]+?)(?: ~)?\](?=\n|$)"),
        "[需要细看时用元景的 {tool}：image_url_or_oss_path 填 {path}，prompt 写要问的问题]",
    ),
    (
        re.compile(
            r"\[The user sent an image but (?:I couldn't quite see it this time \(>_<\) You can try looking at it"
            r"|something went wrong when I tried to look at it~ You can try examining it) yourself"
            r" with vision_analyze using image_url: ([^\n]+?)\](?=\n|$)"
        ),
        "[用户发来一张图片，还没能看到内容。看这张图请用元景的 {tool}：image_url_or_oss_path 填 {path}，prompt 写要问的问题]",
    ),
)
# 会话中途换成看不到图的模型后，Hermes 每次请求前把历史图片交给看图模型重写成描述
# （agent/vision_message_prep.py）。桌面把文字模型写明不能看图后，这一步找不到看图模型、当场失败，
# 原文是“图片里有：<出错说明>”，模型会误以为图已经看过。出错说明来自 tools/vision_tools.py 的几种写法。
_FAILED_NOTE = re.compile(
    r"\[The (?:user|assistant|tool result) attached an image\. Here's what it contains:\n"
    r"(?:Image analysis failed|There was a problem with the request and the image could not be analyzed"
    r"|Insufficient credits or payment required|The vision API rejected the image"
    r"|[^\n]*? does not support vision or our request was not accepted)"
    r".*?\](?=\n|$)",
    re.S,
)
FAILED_NOTE = "[这里原有一张图片，当前模型看不到，也没能自动识别出内容]"
# 看图模型发图时每张图附的路径（agent/image_routing.py）；图片数据已不在消息里时，路径是唯一的线索。
_ATTACHED = re.compile(r"\[Image attached(?: at)?: ([^\n]+?)\](?=\n|$)")
ATTACHED_HINT = "[看这张图请用元景的 {tool}：image_url_or_oss_path 填 {path}，prompt 写要问的问题]"
_IMAGE_PARTS = {"image_url", "input_image"}
# 桌面和接通本机成品交付的消息平台改写；其他平台保持原样。
PLATFORMS = frozenset({"desktop", *DELIVERY_PLATFORMS})


def settings():
    """当前账号的配置；读不到时当作空配置。"""
    from hermes_cli.config import load_config_readonly

    return load_config_readonly() or {}


def vision_disabled(cfg):
    """Hermes 自带的 vision 工具组是否被关掉（桌面有元景套餐时会关）。"""
    agent = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    disabled = agent.get("disabled_toolsets") or []
    return "vision" in ([disabled] if isinstance(disabled, str) else disabled)


def vision_tool_works(cfg):
    """vision_analyze 真能看到图：工具组开着，且单独配了看图模型（不然交给看不到图的主模型）。"""
    aux = ((cfg.get("auxiliary") or {}).get("vision") or {}) if isinstance(cfg.get("auxiliary"), dict) else {}
    explicit = isinstance(aux, dict) and (
        str(aux.get("provider") or "").strip().lower() not in ("", "auto")
        or bool(aux.get("model"))
        or bool(aux.get("base_url"))
    )
    return not vision_disabled(cfg) and explicit


def main_model_sees(model=""):
    """主模型能不能直接看图，与 Hermes 每轮决定是否把图片原样发给模型的判断一致；判断不了按看不到处理。"""
    try:
        from agent.auxiliary_client import _read_main_model, _read_main_provider
        from agent.image_routing import decide_image_input_mode

        return decide_image_input_mode(_read_main_provider(), model or _read_main_model(), settings()) == "native"
    except Exception:
        return False


def analyze_tool():
    """本账号连上的元景看图工具全名；没有时返回空串。"""
    return next(
        (name for name in (f"mcp__{server}__{LEAF}" for server in uploads.SERVERS) if uploads.has_tool(name)),
        "",
    )


def rewrite_text(text, tool, images_gone=False):
    """把文字里 Hermes 的 vision_analyze 看图提示换成元景写法，路径不动。

    images_gone 表示这条消息里已没有图片数据（中途换了看不到图的模型，或重启后从存档读回），
    这时看图失败的说明和附图路径也一并换掉，让模型需要时自己用元景看。
    """
    for pattern, template in _HINTS:
        text = pattern.sub(lambda match: template.format(tool=tool, path=match.group(1)), text)
    if images_gone:
        text = _FAILED_NOTE.sub(FAILED_NOTE, text)
        text = _ATTACHED.sub(lambda match: ATTACHED_HINT.format(tool=tool, path=match.group(1)), text)
    return text


def _mentions_images(text):
    """粗筛：文字里有 Hermes 写的看图提示、看图结果或附图路径时才值得逐条改写。"""
    return "vision_analyze" in text or "[Image attached" in text or "attached an image. Here's what" in text


def _user_texts(message):
    """用户消息里的文字段，纯文字和图文混排两种格式都取。"""
    if not isinstance(message, dict) or message.get("role") != "user":
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [part["text"] for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)]
    return []


def _rewrite_message(message, tool):
    """换掉一条用户消息里的提示；不用换时返回原对象，换时复制，不改 Hermes 自己的消息列表。"""
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        new = rewrite_text(content, tool, images_gone=True)
        return message if new == content else {**message, "content": new}
    if isinstance(content, list):
        # 图片还在的消息模型能直接看，附图路径不改；只换 Hermes 自己写的 vision_analyze 提示。
        gone = not any(isinstance(part, dict) and part.get("type") in _IMAGE_PARTS for part in content)
        parts = [
            {**part, "text": rewrite_text(part["text"], tool, images_gone=gone)}
            if isinstance(part, dict) and isinstance(part.get("text"), str) else part
            for part in content
        ]
        return message if parts == content else {**message, "content": parts}
    return message


def rewrite_request(*, request=None, platform="", **_):
    """llm_request 中间件：桌面和四个消息平台的会话发请求前改写看图提示。

    只在主模型看不到图（Hermes 加了这行提示）、vision_analyze 看不了图、且接了元景看图工具时改；
    图片数据已不在消息里的附图（中途换模型、重启后读回）也换成元景看图的写法。
    每次改出的文字相同，不影响提示缓存。
    """
    try:
        if platform not in PLATFORMS or not isinstance(request, dict):
            return None
        key = "messages" if isinstance(request.get("messages"), list) else "input"
        messages = request.get(key)
        if not isinstance(messages, list) or not any(
            _mentions_images(text) for message in messages for text in _user_texts(message)
        ):
            return None
        tool = analyze_tool()
        if not tool or vision_tool_works(settings()):
            return None
        changed = [_rewrite_message(message, tool) if _user_texts(message) else message for message in messages]
        if all(new is old for new, old in zip(changed, messages)):
            return None
        return {"request": {**request, key: changed}, "source": "desktop-deliverables", "reason": "image-hint"}
    except Exception:
        logger.warning("Image hint rewrite skipped", exc_info=True)
        return None
