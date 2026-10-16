"""Which picture and video tools this profile has, and how to say so.

The UniAI toolkit (元景 MCP) is the generator and image search 数字员工 used.
It reaches a profile as an ordinary ``mcp_servers`` entry — ``UniAI-Toolkit``
from the desktop account setup, ``yuanjing`` in the web build, ``1`` in old
数字员工 configs — so the slot finds it there by name or by its URL and names
its tools the way Hermes registers them (``mcp__<server>__<tool>``).

``config.yaml`` may still pin names by hand, which wins over detection::

    uniwork_kits:
      media:
        image_tool: image_generate   # empty string: not connected
        video_tool: ""
        search_tool: ""

Host notes and the PPT picture rules read this when a session starts or a turn
is built. This module never calls a generator. An open conversation keeps the
system prompt it already cached; the next session picks up a new name.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

DEFAULT_IMAGE_TOOL = "image_generate"
UNIAI_SERVER_NAMES = ("UniAI-Toolkit", "yuanjing", "1")
_UNIAI_URL_MARK = "ai-yuanjing.com/app/mcp-server"
UNIAI_IMAGE = "txt2img_generate"
UNIAI_VIDEO = "txt2vid_generate"
UNIAI_SEARCH = "image_search"


@dataclass(frozen=True)
class MediaSlot:
    image_tool: str = DEFAULT_IMAGE_TOOL
    video_tool: str = ""
    search_tool: str = ""
    server: str = ""  # the MCP server the names came from, "" when none

    @property
    def via_mcp(self) -> bool:
        return any(name.startswith("mcp__") for name in (self.image_tool, self.video_tool, self.search_tool))


def mcp_tool(server: str, leaf: str) -> str:
    """The name Hermes registers an MCP tool under (``tools.mcp_tool``)."""
    return f"mcp__{re.sub(r'[^A-Za-z0-9_]', '_', server)}__{leaf}"


def leaf(tool_name: str) -> str:
    """``image_search`` for ``mcp__UniAI_Toolkit__image_search``; plain names stay."""
    return str(tool_name or "").rsplit("__", 1)[-1]


def _is_off(entry: Mapping[str, Any]) -> bool:
    return entry.get("enabled") is False or str(entry.get("enabled")).strip().lower() in {"false", "0", "no", "off"}


def uniai_server(servers: Any) -> str:
    """The enabled ``mcp_servers`` key that is the UniAI toolkit, or ``""``."""
    if not isinstance(servers, Mapping):
        return ""
    for name, entry in servers.items():
        if not isinstance(entry, Mapping) or _is_off(entry):
            continue
        url = str(entry.get("url") or "")
        if str(name) in UNIAI_SERVER_NAMES or _UNIAI_URL_MARK in url:
            return str(name)
    return ""


def _text(raw: Mapping[str, object], key: str, default: str) -> str:
    if key not in raw:
        return default
    value = raw.get(key)
    return value.strip() if isinstance(value, str) else default


def _config() -> Mapping[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly

        return load_config_readonly() or {}
    except Exception:
        return {}


def _builtin_image_ready() -> bool:
    """Whether Hermes' own ``image_generate`` has a backend in this profile."""
    try:
        from tools.registry import registry

        entry = registry.get_entry(DEFAULT_IMAGE_TOOL)
        check = getattr(entry, "check_fn", None) if entry is not None else None
        return bool(entry) and (check is None or bool(check()))
    except Exception:
        return False


def load_slot(raw: Optional[Mapping[str, object]] = None, servers: Any = None) -> MediaSlot:
    """Resolve the slot.

    Tests pass *raw* (``uniwork_kits.media``) and *servers* (``mcp_servers``).
    Otherwise both come from the active profile's config. A hand-written name
    wins; then the UniAI toolkit; Hermes' ``image_generate`` only when it has a
    backend, because naming a generator that fails sends the model in circles.
    """
    if raw is None or servers is None:
        cfg = _config()
        if raw is None:
            section = cfg.get("uniwork_kits") if isinstance(cfg, Mapping) else None
            media = section.get("media") if isinstance(section, Mapping) else None
            raw = media if isinstance(media, Mapping) else {}
        if servers is None:
            servers = cfg.get("mcp_servers") if isinstance(cfg, Mapping) else None
    server = uniai_server(servers)
    if server:
        image_default = mcp_tool(server, UNIAI_IMAGE)
        video_default = mcp_tool(server, UNIAI_VIDEO)
        search_default = mcp_tool(server, UNIAI_SEARCH)
    else:
        image_default = DEFAULT_IMAGE_TOOL if ("image_tool" in raw or _builtin_image_ready()) else ""
        video_default = search_default = ""
    return MediaSlot(
        image_tool=_text(raw, "image_tool", image_default),
        video_tool=_text(raw, "video_tool", video_default),
        search_tool=_text(raw, "search_tool", search_default),
        server=server,
    )


UNIAI_URL = "https://maas.ai-yuanjing.com/app/mcp-server/mcp"
UNIAI_CLIENT_ID = "UniWork"  # on the toolkit's allow-list; others are billed to the user's own key (1004)
UNIAI_TIMEOUT_S = 600
DEFAULT_KEY_ENV = "DESKTOP_MT_MAAS_API_KEY"


def uniai_entry(key_env: str) -> dict:
    """The ``mcp_servers`` entry the web and desktop builds write for the toolkit.

    The key stays in ``.env``: Hermes expands ``${VAR}`` when it connects.
    """
    return {"url": f"{UNIAI_URL}?key=${{{key_env}}}&client_id={UNIAI_CLIENT_ID}", "timeout": UNIAI_TIMEOUT_S}


def _env_names(home) -> set:
    from pathlib import Path

    path = Path(home) / ".env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    return {line.split("=", 1)[0].strip() for line in lines if "=" in line and not line.lstrip().startswith("#")}


def status_lines(home) -> list:
    """What *home* has for pictures, said for a person. Never prints a key."""
    from . import store

    with store.scoped_home(home):
        cfg = _config()
        slot = load_slot()
    servers = cfg.get("mcp_servers") if isinstance(cfg, Mapping) else None
    lines = []
    if slot.server:
        entry = servers.get(slot.server) if isinstance(servers, Mapping) else {}
        url = str((entry or {}).get("url") or "")
        refs = re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", url)
        missing = [name for name in refs if name not in _env_names(home)]
        lines.append(f"UniAI 工具箱：已接入，MCP 名 `{slot.server}`。")
        if missing:
            lines.append(f"  但 .env 里没有 {', '.join(missing)}，连接时会缺密钥。")
    else:
        lines.append("UniAI 工具箱：这个 profile 的 mcp_servers 里没有（UniAI-Toolkit / yuanjing / 元景地址都没找到）。")
    lines.append(f"生图：{slot.image_tool or '未接入'}")
    lines.append(f"搜图：{slot.search_tool or '未接入'}")
    lines.append(f"生视频：{slot.video_tool or '未接入'}")
    if slot.via_mcp:
        lines.append("这些是 MCP 工具，开着 Tool Search 时模型通过 tool_describe / tool_call 调用。新会话生效。")
    return lines


def connect_uniai(home, *, key_env: str = DEFAULT_KEY_ENV, name: str = "UniAI-Toolkit") -> str:
    """Write the toolkit entry into *home*'s config. The key itself goes in ``.env`` by hand."""
    from . import store

    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env or ""):
        raise ValueError(f"环境变量名不合法：{key_env!r}")
    entry = uniai_entry(key_env)
    with store.scoped_home(home):
        from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server

        current = _get_mcp_servers().get(name)
        if isinstance(current, dict):
            merged = {**current, **entry}  # keep the user's enabled flag and tool filters
            if merged == current:
                note = f"`{name}` 已经是这条配置，没有改。"
            elif _save_mcp_server(name, merged):
                note = f"已更新 `{name}` 的地址和超时，其他字段保留。"
            else:
                raise ValueError("Hermes 拒绝写入这台 MCP。")
        elif _save_mcp_server(name, entry):
            note = f"已把 `{name}` 写进这个 profile。"
        else:
            raise ValueError("Hermes 拒绝写入这台 MCP。")
    if key_env not in _env_names(home):
        note += f"还要在这个 profile 的 .env 里加一行 {key_env}=<元景套餐密钥>（不要贴在对话里）。"
    return note + "新会话才会连上。"


def call_hint(slot: MediaSlot) -> str:
    """How to reach MCP tools that Tool Search keeps out of the tool list."""
    if not slot.via_mcp:
        return ""
    return (
        "这些 MCP 工具若不在工具列表里，就在 `tool_search` 的目录里：先用 `tool_describe` 取参数，"
        "再用 `tool_call` 按全名调用。不要因为工具列表里没看到就说工具不可用。"
    )


# Ordinary chats (not decks) that ask for a picture. Without a word about the
# UniAI tools a model reaches for web search and curl instead, because MCP
# tools sit behind Tool Search (Hermes, 2026-10-16: "搜三张西湖断桥的实景照片"
# went to web_search / web_extract and never touched image_search).
_PICTURE = r"(?:图片|照片|相片|实景图|配图|壁纸|插画|插图|海报|封面图?|头像|图)"
_DRAWN_BY_CODE = re.compile(
    r"流程图|架构图|结构图|示意图|思维导图|脑图|图表|饼图|柱状图|条形图|折线图|散点图|K线图|甘特图|时序图|拓扑图|"
    r"截图|看图|这张图|这幅图|图里|图中|识图|分析.{0,6}图"
)
_FIND_PICTURE = re.compile(rf"(?:搜|找|查|下载|来|给我|要)[^，。,.!?！？\n]{{0,12}}{_PICTURE}")
_MAKE_PICTURE = re.compile(rf"(?:生成|画|绘制|创作|设计|做)[^，。,.!?！？\n]{{0,12}}{_PICTURE}")


def picture_request_hint(text: str, slot: Optional[MediaSlot] = None) -> str:
    """Point a picture request in an ordinary chat at the search / generation tools."""
    if not text or _DRAWN_BY_CODE.search(text):
        return ""
    wants_found = bool(_FIND_PICTURE.search(text))
    wants_made = bool(_MAKE_PICTURE.search(text)) and not wants_found
    if not (wants_found or wants_made):
        return ""
    slot = slot or load_slot()
    if wants_found and slot.search_tool:
        line = (
            f"本轮要找现成的图片：用 `{slot.search_tool}` 搜图，它直接返回图片链接和来源。"
            "不要改用网页搜索、网页抓取或终端去下载网页上的图。"
        )
    elif wants_made and slot.image_tool:
        line = f"本轮要生成图片：用 `{slot.image_tool}` 生成，不要只给设计说明。"
    else:
        return ""
    return line + call_hint(slot)


def media_note(slot: Optional[MediaSlot] = None) -> str:
    """One host-note line. Tool names come from the slot, never from a package."""
    slot = slot or load_slot()
    image = f"生图工具是 `{slot.image_tool}`。" if slot.image_tool else "生图还没有接入。"
    video = f"生视频工具是 `{slot.video_tool}`。" if slot.video_tool else "生视频还没有接入。"
    return (
        "- 专家包里的 ImageGen / gen_image / image_gen、VideoGen 按当前接入处理："
        f"{image}{video}{call_hint(slot)}"
        "确实调不到或调用失败时，给出设计说明（尺寸、构图、文案），不要声称已经生成。\n"
    )


# Where a real picture may come from besides the search tool.  数字员工 sent a
# Disney deck to Wikipedia this way when search ran dry (disney#2, #7); a model
# told only 「没有就不配图」 shipped none at all (disney#4, 2026-09-30).
_ELSEWHERE = (
    "也可以从官网、官方新闻稿、维基百科 / Wikimedia Commons 这类可靠来源取原版图，下载到本地再放进 PPT"
    "（记下来源页，图下标注）；Unsplash / Pexels 这类图库只适合风景、氛围图。"
)


def picture_rules(slot: Optional[MediaSlot] = None, *, delivery: str = "") -> str:
    """Decision procedure for a deck (数字员工 ``image_companion``, Hermes tool names).

    Does not claim a picture was produced. *delivery* is the platform's
    file-delivery line, appended last.
    """
    slot = slot or load_slot()
    if slot.search_tool:
        search = (
            f"用 `{slot.search_tool}` 找真图（宿主会把搜到的图下载到本地，标出横图 / 竖图和来源）。"
        )
        missing = "只是没搜到 → 换关键词再搜，还没有就这页少放一张"
    else:
        search = "找真图（专门的搜图工具还没有接入）：" + _ELSEWHERE
        missing = "都找不到就这页少放一张"
    if slot.image_tool:
        generate = f"用 `{slot.image_tool}`，size 选和画框相近的比例。迪士尼等版权角色要官方图，不生成。"
        no_photo = "先搜画像或官方渲染图，没有再生成，标「示意图（AI 生成）」"
    else:
        generate = "生图还没有接入：改用代码画的简化图形、渐变或纹理底，不要声称已经生成。"
        no_photo = "先搜画像或官方渲染图，没有就用图形示意并写明是示意"
    lines = [
        "PPT 配图原则（每放一张图都按顺序想）：",
        "1. 用户指定了来源或画风、给了素材、或说不要图 → 照用户的来。",
        "2. 数据、流程、路线、关系、图标、印章、页码 → 用代码画（图表、形状）。"
        "地图：用户没要就用区域卡片表达分布，不画地理轮廓；用户要地图就用自然资源部标准地图（bzdt.ch.mnr.gov.cn）"
        "原图、不裁不改、标审图号，不许自己画或生成。",
        "3. 画面图先问：观众会把画面里的样子当成真实信息吗？",
        "· 会（具体产品、品牌 IP、logo、真人、地标、事件、软件界面、科普细节）→ " + search
        + "生成图会编造细节，当真就是误导，仿品牌形象还可能侵权。"
        "真图要看得出本来的样子：剪影、线稿、简笔画、玩具周边、同人图都不算；"
        "核对图片时问「是不是原版形象」，不要只问「是不是这个角色」。"
        f"本来就没有照片的（古人、未发布产品）{no_photo}；"
        f"{missing}，不许用生成图顶替，也不要写「此处放图」。",
        "· 不会（公版虚构角色、风格插画、概念、背景、封面、泛泛的场景）→ " + generate,
        "4. 整套画风开工前定一次；统一靠相框和色调，不靠把真图换成生成图。",
        "标注：搜来的图正下方一行小字写来源（不清楚写「图片来源：网络」，英文 PPT 写 Image: …）；"
        "生成的画面图一律标「AI 生成」。人物、产品、场景不要用色块拼。",
        "放图保持原比例：pptxgenjs 外层 w/h 写图片自己的尺寸（像素÷96），sizing 的 w/h 才是画框；"
        "主体图比例对不上用 contain 完整放下，只有通栏 / 出血背景图用 cover。",
        "宿主在 .pptx 写出后会自动检查图片拉伸和大幅裁切、元素出界、文字挤在一起或空着、内容缩在一角、"
        "PowerPoint 打不开的写法，不合格会退回；自己看图检查时只看内容对不对、观感好不好"
        "（配色、对比度、层次），不用写脚本或派子任务逐项复查这些。",
    ]
    hint = call_hint(slot)
    if hint:
        lines.append(hint)
    if delivery:
        lines.append(delivery)
    lines.append("例：Labubu → 搜图；水墨风孙悟空 → 生成；李白 → 先搜古画像；海外市场分布 → 区域卡片。")
    return "\n".join(lines)
