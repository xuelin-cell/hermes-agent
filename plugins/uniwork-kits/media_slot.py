"""The one place a colleague turns picture and video tools on.

``config.yaml``::

    uniwork_kits:
      media:
        image_tool: image_generate   # empty string: not connected
        video_tool: ""                # Hermes tool name, filled in later
        search_tool: ""               # real-photo search tool name, filled in later

Host notes and the PPT picture reminder read this when a session starts or a
turn is built. This module never calls a generator. An open conversation keeps
the system prompt it already cached; the next session picks up a new name.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

DEFAULT_IMAGE_TOOL = "image_generate"


@dataclass(frozen=True)
class MediaSlot:
    image_tool: str = DEFAULT_IMAGE_TOOL
    video_tool: str = ""
    search_tool: str = ""


def _text(raw: Mapping[str, object], key: str, default: str) -> str:
    if key not in raw:
        return default
    value = raw.get(key)
    return value.strip() if isinstance(value, str) else default


def load_slot(raw: Optional[Mapping[str, object]] = None) -> MediaSlot:
    """Resolve the slot. Pass *raw* in tests; otherwise read ``uniwork_kits.media``."""
    if raw is None:
        try:
            from hermes_cli.config import load_config_readonly

            section = (load_config_readonly() or {}).get("uniwork_kits") or {}
            media = section.get("media") if isinstance(section, dict) else None
            raw = media if isinstance(media, dict) else {}
        except Exception:
            raw = {}
    return MediaSlot(
        image_tool=_text(raw, "image_tool", DEFAULT_IMAGE_TOOL),
        video_tool=_text(raw, "video_tool", ""),
        search_tool=_text(raw, "search_tool", ""),
    )


def media_note(slot: Optional[MediaSlot] = None) -> str:
    """One host-note line. Tool names come from the slot, never from a package."""
    slot = slot or load_slot()
    image = f"生图工具是 `{slot.image_tool}`。" if slot.image_tool else "生图还没有接入。"
    video = f"生视频工具是 `{slot.video_tool}`。" if slot.video_tool else "生视频还没有接入。"
    return (
        "- 专家包里的 ImageGen / gen_image / image_gen、VideoGen 按当前接入处理："
        f"{image}{video}"
        "工具列表里没有对应工具，或调用失败时，给出设计说明（尺寸、构图、文案），不要声称已经生成。\n"
    )


def picture_rules(slot: Optional[MediaSlot] = None) -> str:
    """Decision procedure for a deck. Does not claim a picture was produced."""
    slot = slot or load_slot()
    if slot.search_tool:
        factual = (
            f"· 会（具体产品、品牌、logo、真人、地标、软件界面、科普细节）→ 用 `{slot.search_tool}` 找真图。"
            "剪影、线稿、简笔画、同人图都不算原版。本来就没有照片的先搜画像或官方图，没有再考虑生成，并标「示意图（AI 生成）」；"
            "只是没搜到就换关键词，还没有就这页少放一张，不许用生成图顶替，也不要写「此处放图」。"
        )
    else:
        factual = (
            "· 会（具体产品、品牌、logo、真人、地标、软件界面、科普细节）→ 真图搜索还没有接入。"
            "这页少放一张，不许用生成图顶替，也不要写「此处放图」。"
        )
    if slot.image_tool:
        atmosphere = (
            f"· 不会（公版虚构、风格插画、概念、背景、封面、泛泛的场景）→ 用 `{slot.image_tool}`，标「AI 生成」。"
            "迪士尼等版权角色不生成。"
        )
    else:
        atmosphere = "· 不会（风格、背景、概念）→ 生图还没有接入。写下尺寸、构图和文案，不要声称已经生成。"
    return (
        "PPT 配图原则（每放一张图都按顺序想）：\n"
        "1. 用户指定了来源或画风、给了素材、或说不要图 → 照用户的来。\n"
        "2. 数据、流程、路线、关系、图标、印章、页码 → 用代码画（图表、形状）。"
        "地图：用户没要就用区域卡片；用户要地图就用自然资源部标准地图原图，不裁不改，不许自己画或生成。\n"
        "3. 画面图先问：观众会把画面里的样子当成真实信息吗？\n"
        f"{factual}\n"
        f"{atmosphere}\n"
        "4. 整套画风开工前定一次。搜来的图在下方写来源（不清楚写「图片来源：网络」）；生成的画面标「AI 生成」。"
        "人物、产品、场景不要用色块拼。\n"
        "例：Labubu → 真图；水墨风孙悟空 → 可生成的气氛图；李白 → 先找古画像；海外市场分布 → 区域卡片。"
    )
