"""What a summoned expert must know about this host, as cache-safe prompt sections.

UniClaw injects these rules on every model call (``plugin_experts.make_reminder``).
Hermes forbids mutating a live conversation's context, so here they become
``register_system_prompt_section`` blocks: rendered once per new session, keyed
by the session's ``profile_name``, empty for any profile that is not an
installed expert. Source texts: UniClaw ``plugin_experts.py`` (HOST_NOTES,
SHARED_HOST_NOTES, EXPERT_DELIVERY_CHECKS, DELIVERY_SELF_CHECK,
ASK_BEFORE_WORKING, WORKING_STYLE), condensed and rewritten for Hermes tool
names. Hermes caps every plugin's sections at 8,000 characters in total, so
keep the sum of the three sections well below that.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import delivery, media_slot, store

# Skills from another package a given expert keeps (UniClaw EXPERT_COMPANION_SKILLS).
# equity-research keeps the data CLI only; the kit's catch-all
# ``finance-research--finance-analysis`` would take the turn away from the
# expert's own research skills.
COMPANION_SKILLS: Dict[str, Tuple[str, ...]] = {
    "equity-research": ("finance-research--westock-data",),
}


def localized(value: object, lang: str = "zh") -> str:
    """A display string from a ``{zh, en}`` manifest field, or a plain string."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in (lang, "zh", "en"):
            text = value.get(key)
            if isinstance(text, str) and text.strip():
                return text.strip()
        for text in value.values():
            if isinstance(text, str) and text.strip():
                return text.strip()
    return ""


# ── persona tool names ──────────────────────────────────────────────────────

# Only identifiers that cannot be ordinary words. ``Read`` / ``Write`` / ``Bash``
# also name WorkBuddy tools but read as prose too often to rewrite blindly.
_FIXED_RENAMES: Tuple[Tuple[str, str], ...] = (
    ("AskUserQuestion", "clarify"),
    ("WebSearch", "web_search"),
    ("WebFetch", "web_extract"),
    ("TodoWrite", "todo"),
)
_MCP_PREFIX_RE = re.compile(r"mcp__([A-Za-z0-9_-]+)__")
# Named so the receipt can say what has no Hermes counterpart yet.
_ALWAYS_UNMAPPED = ("PresentToUser", "present_files", "ToolSearch")
_MEDIA_PLUGINS = frozenset({
    "douyin-strategist",
    "wechat-official-account-expert",
    "xiaohongshu-operations-expert",
})


def _renames(slot: media_slot.MediaSlot) -> List[Tuple[str, str]]:
    pairs = list(_FIXED_RENAMES)
    if slot.image_tool:
        pairs.extend((("ImageGen", slot.image_tool), ("gen_image", slot.image_tool), ("image_gen", slot.image_tool)))
    if slot.video_tool:
        pairs.append(("VideoGen", slot.video_tool))
    return pairs


def rewrite_persona(text: str, slot: Optional[media_slot.MediaSlot] = None) -> Tuple[str, List[str], List[str]]:
    """Rewrite WorkBuddy tool names in a lead persona to Hermes names.

    Image and video names come from :func:`media_slot.load_slot`. An empty
    video tool leaves ``VideoGen`` unmapped so the receipt says it is not
    connected yet. Returns ``(text, changes, unmapped)``.
    """
    slot = slot or media_slot.load_slot()
    changes: List[str] = []
    for old, new in _renames(slot):
        pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(old)}(?![A-Za-z0-9_])")
        text, count = pattern.subn(new, text)
        if count:
            changes.append(f"{old} → {new}（{count} 处）")

    mcp_changed = 0

    def _mcp(match: "re.Match[str]") -> str:
        nonlocal mcp_changed
        server = match.group(1)
        safe = re.sub(r"[^A-Za-z0-9_]", "_", server)
        if safe != server:
            mcp_changed += 1
        return f"mcp__{safe}__"

    text = _MCP_PREFIX_RE.sub(_mcp, text)
    if mcp_changed:
        changes.append(f"MCP 工具名里服务名的 - 换成 _（{mcp_changed} 处，Hermes 的命名规则）")
    unmapped_names = list(_ALWAYS_UNMAPPED)
    if not slot.image_tool:
        unmapped_names.extend(("ImageGen", "gen_image", "image_gen"))
    if not slot.video_tool:
        unmapped_names.append("VideoGen")
    unmapped = [name for name in unmapped_names if re.search(rf"(?<![A-Za-z0-9_]){name}(?![A-Za-z0-9_])", text)]
    return text, changes, unmapped


# ── rule texts ──────────────────────────────────────────────────────────────

HOST_NOTES: Dict[str, str] = {
    "equity-research": (
        "- 加载本专家的技能写全名，例如 `equity-research--initiating-coverage`、"
        "`equity-research--long-short-pitch`。研究流程用本专家自己的技能，不要改走金融套件的总入口。\n"
        "- 行情、财报、公告这类数字用伴随技能 `finance-research--westock-data` 取数。"
        "不要加载 `finance-research--finance-analysis`（当前不可用，那是套件总入口）；"
        "westock-data 正文若写「先加载 finance-analysis」，忽略，直接查数。\n"
    ),
    "douyin-strategist": (
        "- 加载本专家的技能写全名，例如 `douyin-strategist--humanizer`；humanizer、anti-distill "
        "不会自动运行，需要时再显式加载。\n"
        "- 热点、竞品只能用 `web_search` 查公开网页，结论注明「公开网页信息 + 分析判断，"
        "不是抖音创作者后台或巨量算数数据」。\n"
        "- 没有抖音后台数据和接口：不要编造播放量、完播率等账号数据，需要时请用户提供。\n"
    ),
    "wechat-official-account-expert": (
        "- 加载本专家的技能写全名，例如 `wechat-official-account-expert--wechat-article-search`。\n"
        "- `search_wechat.js` 需要 Node 和 cheerio；缺 cheerio 时在单独的工作目录里 `npm install cheerio`。"
        "跑不起来时改用 `web_search`（限定 mp.weixin.qq.com），不要用浏览器爬取。\n"
        "- 文风画像和选题大纲给出后，用 `clarify` 请用户确认，确认前不写正文。\n"
        "- 推送草稿箱需要环境变量 `WECHAT_APPID`、`WECHAT_SECRET`（配置在本专家 profile 的 .env 里）；"
        "不要让用户在对话里发送 AppID、AppSecret。缺少时交付排版好的 HTML 和草稿 JSON，"
        "并说明需要到公众号后台发布。缺 jq 时用 Python 解析 JSON 代替。\n"
        "- 公众号封面必须是 900×383；推送草稿时 `thumb_media_id` 必填，要先把封面上传为永久素材拿到 media_id。\n"
    ),
    "long-manuscript-expert": (
        "- 加载本专家的技能写全名，例如 `long-manuscript-expert--long-manuscript-core`。\n"
        "- 没有 WorkBuddy 工作区、`present_files`、workspace 事务或包内 `expert-tools.mjs` / "
        "`prose-gate.mjs` 运行时。写文件用 `write_file`，核对用 `read_file` 读回到文件末尾；"
        "不要声称这些 WorkBuddy 能力已执行。脚本不可达时做逐句来源自查。\n"
        "- 包里的「本次WorkBuddy任务」按「本次对话实际可见或可读的材料」理解。\n"
    ),
    "xiaohongshu-operations-expert": (
        "- 加载本专家的技能写全名，例如 `xiaohongshu-operations-expert--xiaohongshu`。\n"
        "- 查登录、搜笔记、看详情、发布、评论需要本机小红书 MCP（`http://127.0.0.1:18060/mcp`）。"
        "工具全名形如 `mcp__xiaohongshu_mcp__check_login_status`：工具列表里没有时在 `tool_search` 的目录里找，"
        "用 `tool_describe` 取参数后 `tool_call` 调用；目录里也没有就说明本机小红书服务尚未接入，策略和文案照常做。"
        "禁止用浏览器、网页抓取或 `web_extract` 代替账号操作。\n"
        "- 要用账号时先调 `check_login_status`，已登录就直接往下做；确认未登录才调一次 "
        "`get_login_qrcode`，按它返回的原话回复用户。不要为确认图片重复调用，每调一次上一张就作废；"
        "只有二维码过期或用户说扫不上时才再调一次，并说明是新的一张。\n"
        "- 发布前先定可见范围：`visibility` 支持「公开可见」「仅自己可见」「仅互关好友可见」，"
        "不传就是公开；用户没说就先问。话题标签用 `tags` 参数传，不要写进正文。\n"
        "- 做起号或运营方案前问清赛道、账号阶段、核心目标、内容形式（已说过的不再问）；"
        "策略方案先用 `web_search` 查当下公开资料，注明来源和日期。\n"
    ),
}

EXPERT_DELIVERY_CHECKS: Dict[str, str] = {
    "equity-research": (
        "- 财报口径以公司公告原文为准，写明币种和公告日期；折算数字标「折算口径」。"
        "已有更新的中报或季报时以它为最新实际。\n"
        "- 有公开股价和股本时至少用两种估值方法，列出关键假设，给出牛 / 基本 / 熊三种情景、"
        "评级、目标价和数据截至日期；DCF 终值占比超过 75% 要提示。"
        "没有公开股价或股本时，不要编每股价值和评级。\n"
    ),
    "wechat-official-account-expert": (
        "- 公众号文章必须有 900×383 封面；`thumb_media_id` 为空的草稿不能当作可推送。\n"
        "- 运营方案要有至少 4 周逐篇排期、不少于 20 个选题、关键词回复清单。\n"
    ),
    "douyin-strategist": (
        "- 热点、趋势、竞品都要标注「公开网页信息 + 分析判断」并附来源和日期。\n"
        "- 方案开头先对齐目标、预算和团队规模，写明「不做清单」，按人数和每周可用时间核算产能；"
        "零预算不要建议投流。\n"
    ),
    "xiaohongshu-operations-expert": (
        "- 起号或运营方案要有逐日发布日历、发布前检查清单、发布后数据诊断"
        "（按曝光、点击、互动、涨粉给出对应动作）。\n"
    ),
    "long-manuscript-expert": (
        "- 首轮必须有可编辑结构、至少一段可直接接着改的实质正文和恰好一个下一步；"
        "不得只交问题、计划、空模板或能力介绍。\n"
        "- 材料没有的号码、人数、制度不得写成已发生或已生效；只改授权范围，锁定段读回确认未改；"
        "写了文件必须读回到末尾再交付。\n"
    ),
}

SHARED_RULES = (
    "- 加载本专家的技能用当前技能列表里的全名（`插件名--技能名`），不要猜短名；列表里没有的技能不要加载。\n"
    "- 用户本轮写明的约束（不要搜索、不要登录、零预算、只改指定范围等）优先于技能包里的默认步骤；"
    "冲突时按用户约束做，并写明因此跳过了哪些步骤。\n"
    "- 一份技能或 reference 读到能开工就动手，不要反复「继续读剩余部分」。\n"
    "- 用脚本生成表格、文档或图表时一次写完整脚本再运行；同一脚本连续失败两次就收窄交付。"
    "缺可选库就换不依赖它的写法，不要中途 pip install。\n"
    "- 技能分多步时，只做用户这一句真正要的那份交付；同一任务内部连续做完，不要每一小步都停下来问。\n"
    "- 技能正文里的页数、字数下限不是硬指标；缺数据的图或章节跳过并标明，不要为凑数重跑。\n"
    "- 用 `delegate_task` 派子任务时，`goal` 只写当前步的产出和保存路径，`context` 放必要材料；"
    "不要把整份技能正文贴进去。派工结果是异步回来的。\n"
    "- 有平台像素要求、且图上必须有可读标题的封面：用 Python + Pillow 按尺寸画终稿；生图只用于无字底图。\n"
    "- 包里提到的 ToolSearch 对应本应用的 `tool_search`：MCP 工具不在工具列表里时，先 `tool_describe` 再 `tool_call`。\n"
)

ASK_BEFORE_WORKING = (
    "开工前判断要不要用 `clarify` 问用户：缺少会让交付方向完全不同、又无法合理假设的关键信息"
    "（领域、阶段、核心目标、可投入资源等）时，一次问完 1–4 个问题，拿到回答就开工。"
    "用户已给的信息、能合理假设并标明的缺口、简单明确的请求、用户说「直接做」时不问。"
    "专家包自己对提问另有规定时按专家包。\n"
)

WORKING_STYLE = (
    "需求确认后直接动手：工具调用之间不要重复复述需求，也不要反复预告「先加载…再…」。"
    "多步工作用 `todo` 跟踪，进入下一步或停下来等用户之前先更新它。\n"
)

DELIVERY_SELF_CHECK = (
    "交付文件、报告或带数据的结论前逐项自检，没通过先改；做不到的如实说明，不要跳过或假装做过：\n"
    "1. 关键数字、事实、引用都有来源和日期（或报告期）；同一指标有多期时以最新一期为准。\n"
    "2. 正文、表格、图表、摘要之间同一个数字一致，单位、币种、口径统一。\n"
    "3. 交付文件已实际写到磁盘并用工具读回确认完整；每个文件读回一轮即可。\n"
    "4. HTML 内联脚本抽出来用 `node --check` 检查；没有 node 时逐个检查括号引号配对，不要为检查去装 node。\n"
    "5. 没有真正生成的文件、图片或推送结果，不能说已完成；失败或跳过的步骤写明。\n"
    "6. 用户或材料没给的号码、人数、制度、后台指标，不写成已发生或已生效，标「材料未提供」。\n"
    "7. 用户给了人数或每周可用时间时，排期和产能用同一套算术；没给时不编产能数字。\n"
    "8. 回复里列出的文件都在磁盘上且已读回；已写成文件的全文不要在聊天里再贴一遍。\n"
    "9. 两份材料说法冲突时并排列出并标「未对齐」，不要选一边写成已确认。\n"
)


# ── sections ────────────────────────────────────────────────────────────────


def _home_for_profile(profile_name: str) -> Optional[Path]:
    try:
        from hermes_cli.profiles import get_profile_dir

        return Path(get_profile_dir(profile_name or "default"))
    except Exception:
        return None


def expert_for_session(session_info: Mapping[str, Any]) -> Optional[Tuple[str, Dict[str, Any]]]:
    """``(plugin, entry)`` when the session's profile is an installed expert."""
    home = _home_for_profile(str(session_info.get("profile_name") or "default"))
    if home is None:
        return None
    return store.self_expert(store.load_index(home))


def readiness(plugin: str, home: Optional[Path]) -> str:
    """What this machine still owes the expert. Names only, never secret values."""
    if plugin == "wechat-official-account-expert":
        import shutil

        node = "有" if shutil.which("node") else "没有"
        return (
            f"- 这台电脑上的 Node：{node}。cheerio 和 jq 不在这里安装；"
            "缺了就按上面的说明改用网页搜索或 Python。推送密钥只放在本专家 profile 的 .env。\n"
        )
    if plugin == "xiaohongshu-operations-expert" and home is not None:
        from . import xiaohongshu

        found = xiaohongshu.status(home)
        if found["present"]:
            return f"- 本机小红书程序在 `{found['binary']}`。还没写入 MCP 时运行 `hermes kit xiaohongshu attach`。\n"
        return (
            f"- 本机小红书程序还没放到 `{found['binary']}`。发布包在 `{found['download_url']}`。"
            "放好后运行 `hermes kit xiaohongshu attach`。策略和文案不依赖这个程序。\n"
        )
    return ""


def section_expert_specific(session_info: Mapping[str, Any]) -> str:
    found = expert_for_session(session_info)
    if not found:
        return ""
    plugin, _entry = found
    home = _home_for_profile(str(session_info.get("profile_name") or "default"))
    notes = HOST_NOTES.get(plugin, "")
    if plugin in _MEDIA_PLUGINS:
        notes = media_slot.media_note() + notes
    notes += readiness(plugin, home)
    checks = EXPERT_DELIVERY_CHECKS.get(plugin, "")
    if not notes and not checks:
        return ""
    parts = ["本专家运行在 Hermes（UniWork）里，和专家包原本面向的宿主有差异，按下面执行："]
    if notes:
        parts.append(notes.rstrip())
    if checks:
        parts.append("本专家的专项交付检查：\n" + checks.rstrip())
    return "\n".join(parts)


def identity_line(plugin: str, entry: Mapping[str, Any]) -> str:
    """The name users see on the expert's card is the one it answers to.

    Package personas sometimes call themselves something else (equity-research's
    persona says 研股股 while its card says 严估深); UniClaw pinned the card name
    every turn, here it is pinned once per session.
    """
    name = str(entry.get("display_name") or plugin)
    profession = str(entry.get("profession") or "")
    who = f"「{name}」" + (f"（{profession}）" if profession and profession != name else "")
    return f"你在本应用里的名字是{who}。人设正文里如果用了别的称呼，对用户自称时以这个名字为准。"


def section_expert_working(session_info: Mapping[str, Any]) -> str:
    found = expert_for_session(session_info)
    if not found:
        return ""
    return "\n".join(
        [
            identity_line(*found),
            "专家工作守则（适用于所有专家）：",
            SHARED_RULES.rstrip(),
            delivery.instruction(str(session_info.get("platform") or "")),
            ASK_BEFORE_WORKING.rstrip(),
            WORKING_STYLE.rstrip(),
        ]
    )


def section_expert_delivery(session_info: Mapping[str, Any]) -> str:
    if not expert_for_session(session_info):
        return ""
    return DELIVERY_SELF_CHECK.rstrip()


# Registered in id order; Hermes renders sections sorted by id.
SECTIONS = (
    ("uniwork-kits.expert.a-host", section_expert_specific),
    ("uniwork-kits.expert.b-working", section_expert_working),
    ("uniwork-kits.expert.c-delivery", section_expert_delivery),
)
