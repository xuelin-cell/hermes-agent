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
        """这几个工具里是否有 MCP 工具（名字以 mcp__ 开头），有的话要提示模型怎么调用。"""
        return any(name.startswith("mcp__") for name in (self.image_tool, self.video_tool, self.search_tool))


UNIAI_WATERMARK = "联通元景大模型AI生成"


def watermarked(slot: MediaSlot) -> bool:
    """生图走 UniAI 的 txt2img：图的右下角自带「联通元景大模型AI生成」水印，算作 AI 生成标注（2026-10-20 定）。"""
    return slot.image_tool.endswith(f"__{UNIAI_IMAGE}")


def mcp_tool(server: str, leaf: str) -> str:
    """Hermes 注册 MCP 工具时用的全名：mcp__<服务器名>__<工具名>，服务器名里的特殊字符换成下划线。"""
    return f"mcp__{re.sub(r'[^A-Za-z0-9_]', '_', server)}__{leaf}"


def leaf(tool_name: str) -> str:
    """去掉 MCP 前缀，只留工具本名（如 mcp__UniAI_Toolkit__image_search → image_search）；普通名字原样返回。"""
    return str(tool_name or "").rsplit("__", 1)[-1]


def _is_off(entry: Mapping[str, Any]) -> bool:
    """这条 MCP 配置是否被关掉了（enabled 为 false 或类似写法）。"""
    return entry.get("enabled") is False or str(entry.get("enabled")).strip().lower() in {"false", "0", "no", "off"}


def uniai_server(servers: Any) -> str:
    """mcp_servers 里哪一条是已启用的元景（UniAI）工具箱，按名字或地址认；没有返回空字符串。"""
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
    """从手写配置里取一个工具名：没写用默认值，写了空字符串表示明确「未接入」。"""
    if key not in raw:
        return default
    value = raw.get(key)
    return value.strip() if isinstance(value, str) else default


def _config() -> Mapping[str, Any]:
    """读当前档案的配置；读失败当作空配置。"""
    try:
        from hermes_cli.config import load_config_readonly

        return load_config_readonly() or {}
    except Exception:
        return {}


def _builtin_image_ready() -> bool:
    """Hermes 自带的 image_generate 在这个档案里有没有可用的后端。"""
    try:
        from tools.registry import registry

        entry = registry.get_entry(DEFAULT_IMAGE_TOOL)
        check = getattr(entry, "check_fn", None) if entry is not None else None
        return bool(entry) and (check is None or bool(check()))
    except Exception:
        return False


def load_slot(raw: Optional[Mapping[str, object]] = None, servers: Any = None) -> MediaSlot:
    """决定生图、生视频、搜图各用哪个工具。

    测试时传入 raw（uniwork_kits.media）和 servers（mcp_servers），否则从当前档案配置读。优先级：手写的名字 > 元景工具箱 > Hermes 自带的 image_generate（只有它有后端时才用，指一个调不通的生图工具会让模型来回绕圈）。
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
UNIAI_TIMEOUT_S = 1000  # 与桌面端写入的元景工具箱整体上限一致（对齐 UniWork 的翻译预算）
DEFAULT_KEY_ENV = "DESKTOP_MT_MAAS_API_KEY"


def uniai_entry(key_env: str) -> dict:
    """网页版和桌面版给元景工具箱写的那条 mcp_servers 配置。

    密钥留在 .env 里，地址里只写 ${变量名}，Hermes 连接时才展开。
    """
    return {"url": f"{UNIAI_URL}?key=${{{key_env}}}&client_id={UNIAI_CLIENT_ID}", "timeout": UNIAI_TIMEOUT_S}


def _env_names(home) -> set:
    """home 的 .env 里写了哪些变量名（只读名字，不读值）。"""
    from pathlib import Path

    path = Path(home) / ".env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    return {line.split("=", 1)[0].strip() for line in lines if "=" in line and not line.lstrip().startswith("#")}


def status_lines(home) -> list:
    """用人话说明这个档案的生图、搜图接入情况；绝不打印密钥。"""
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
    """把元景工具箱写进 home 的配置，保留用户已有的启用开关和工具筛选；密钥要用户自己写进 .env。"""
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
    """MCP 工具被 Tool Search 收起来、不在工具列表里时，告诉模型怎么找到并调用。"""
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
    """普通对话里用户要找图或生成图时，指向搜图或生图工具，避免模型改用网页搜索和终端下载。

    流程图、图表、截图这类用代码画或看图的请求不提示。
    """
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
    """给专家的一行宿主说明：包里提到的生图、生视频按当前接入的工具处理；工具名来自配置，不来自包。"""
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


def vision_ready() -> bool:
    """看图工具真能看到图：配了专门的看图模型，或者主模型已知能看图。能力未知时按看不到处理。

    看图工具默认交给主模型；主模型看不到时，它只会回「没有收到图片」，每次调用都白等十几秒。
    """
    try:
        from agent.image_routing import decide_image_input_mode
        from hermes_cli.config import load_config_readonly

        cfg = load_config_readonly() or {}
        aux = (cfg.get("auxiliary") or {}).get("vision") or {}
        if str(aux.get("provider") or "auto").strip().lower() not in ("", "auto") or aux.get("model") or aux.get("base_url"):
            return True
        model = cfg.get("model") or {}
        return decide_image_input_mode(str(model.get("provider") or ""), str(model.get("default") or ""), cfg) == "native"
    except Exception:
        return False


def picture_rules(slot: Optional[MediaSlot] = None, *, delivery: str = "", can_see: Optional[bool] = None) -> str:
    """做 PPT 时每张配图的判断顺序（来自数字员工的 image_companion，换成 Hermes 的工具名）。

    不声称已经生成了图片。delivery 是该平台的文件交付说明，放在最后。
    can_see 是看图工具能否真的看到图（默认按 vision_ready 判断）：看不到时不让模型看图核对，改靠搜索结果的标题和来源挑图。
    """
    slot = slot or load_slot()
    can_see = vision_ready() if can_see is None else can_see
    if slot.search_tool:
        search = (
            f"用 `{slot.search_tool}` 找真图（宿主会把搜到的图下载到本地，标出横图 / 竖图和来源）。"
        )
        missing = "只是没搜到 → 换关键词再搜，还没有就这页少放一张"
    else:
        search = "找真图（专门的搜图工具还没有接入）：" + _ELSEWHERE
        missing = "都找不到就这页少放一张"
    marked = watermarked(slot)
    if slot.image_tool:
        generate = f"用 `{slot.image_tool}`，size 选和画框相近的比例。迪士尼等版权角色要官方图，不生成。"
        no_photo = "先搜画像或官方渲染图，没有再生成，标「示意图」" + ("" if marked else "（AI 生成）")
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
        + ("核对图片时问「是不是原版形象」，不要只问「是不是这个角色」。" if can_see
           else "按搜索结果的标题、来源挑最像原版的那张。")
        + f"本来就没有照片的（古人、未发布产品）{no_photo}；"
        f"{missing}，不许用生成图顶替，也不要写「此处放图」。",
        "· 不会（公版虚构角色、风格插画、概念、背景、封面、泛泛的场景）→ " + generate,
        "4. 整套画风开工前定一次；统一靠相框和色调，不靠把真图换成生成图。",
        "标注：搜来的图正下方一行小字写来源（不清楚写「图片来源：网络」，英文 PPT 写 Image: …）；"
        + (f"生成图右下角自带「{UNIAI_WATERMARK}」水印，这就是 AI 生成标注，不用再加「AI 生成」小字："
           "别把水印裁掉或盖住（当背景用 cover 时留出右下角），页码、图注、文字也不要放在生成图的右下角。"
           if marked else "生成的画面图一律标「AI 生成」。")
        + "人物、产品、场景不要用色块拼。",
        "放图保持原比例：pptxgenjs 外层 w/h 写图片自己的尺寸（像素÷96），sizing 的 w/h 才是画框；"
        "主体图比例对不上用 contain 完整放下，只有通栏 / 出血背景图用 cover。",
        "宿主在 .pptx 写出后会自动检查图片拉伸和大幅裁切、元素出界、文字挤在一起或空着、内容缩在一角、"
        "PowerPoint 打不开的写法，不合格会退回"
        + ("；自己看图检查时只看内容对不对、观感好不好（配色、对比度、层次），不用写脚本或派子任务逐项复查这些。"
           if can_see else
           "，不用写脚本或派子任务逐项复查这些。当前模型看不到图片：不要对图片或幻灯片调用 `vision_analyze`，"
           "它只会回「没有收到图片」。"),
    ]
    hint = call_hint(slot)
    if hint:
        lines.append(hint)
    if delivery:
        lines.append(delivery)
    lines.append("例：Labubu → 搜图；水墨风孙悟空 → 生成；李白 → 先搜古画像；海外市场分布 → 区域卡片。")
    return "\n".join(lines)
