"""Check a deck when a tool writes it, before the user sees it.

数字员工 measured every ``.pptx`` at ``PresentToUser`` and answered with the
defect list instead of delivering it. Hermes has no delivery tool, so the
check rides on the tool result that wrote the deck (``transform_tool_result``):
any ``.pptx`` the call's arguments, its output or a script it ran names,
measured again only when its bytes changed. A failing deck is moved aside
(``.pptx.building``) so the desktop never cards it. Two bounces per request,
as 数字员工 did; after that only the layout-judgment kinds
(``deck_geometry.JUDGMENT_KINDS``) ride along and the deck goes through,
because a heuristic that can trap a conversation is worse than the defect.
Certain errors — PowerPoint can't open it, program values or template tokens
on a slide, every text piled at one point — stay back until fixed.

Generated pictures get one review per request, kits only (an expert carries
its own picture rules): the prompts this request generated from, and how many
「AI 生成」 captions the deck has. Which picture came from which generation
cannot be read from the file, so this asks once and then lets go.
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import deck_geometry, deck_support, deck_timing, delivery, media_slot, turns

# 做 PPT 时附给模型的写法规则：一次调用写出 20 页的整份脚本，生成十来分钟后会超时作废（2026-10-20 实测
# 白等了 597 秒），退回修改时也容易整份重写。分份写，每份两三分钟，改哪页只动哪一份。
# 限的是每份的大小，不是公共部分的内容：公共版式写不下就拆成几份，否则模型会在各页里各写一套版式，风格散掉。
# 推理强度「中」时，动手前的长思考加上大段输出仍会超时（同日实测公共文件又白等 595 秒），所以要求直接写文件。
# 曾经让 10 页以上派子代理同时写分页，2026-10-20/21 实测反而慢：父任务要把每页内容写进派活说明（1～2.5 万字、
# 2.5～6.7 分钟），再等子任务 4～6 分钟把同样的内容改写成代码，比自己直接写分页多花 6～9 分钟，所以去掉了。
# 行距单位和图表小数格式是 pptxgenjs 最常见的两个坑（同日实测整份 20 页文字叠成一团、图上 18.6 标成 19），
# 宿主的版面检查会拦，但事先说一句比退回改一轮便宜。addText 传错参数会让构建直接崩（10-23 七龙珠为此读了四遍
# pptxgenjs 源码、再整份重写），patch 过的文件整份重写会被覆写保护拒掉、白写一遍，同理事先说。
# 图标：模型自己用几何形状拼图标，10-23 学生笔记本在动手前光推演十几个图标就想了十来分钟、写了 8KB 的 icons.js；
# 宿主带一套 Lucide 矢量图标（pptx_icons/），一行调用一个，颜色大小随意，版式仍由模型自己设计。
# 正文最小字号和箭头里的字：同日两份稿正文都只有 9～10 磅，箭头里的「618」被缺口切成「18」；检查拦这些要多退回一轮，写法里说更省时间。
# 字符串数组传给 addText 同样会崩（同日七龙珠）；模型为找 pptxgenjs 翻到上一轮会话的目录、照搬了同题旧稿（同日笔记本），
# 所以写明就地 npm install、只在本次工作目录里读写。
# 分批构建：每写完一个分页文件就构建一次，问题在前几页就改掉，不会在后面的页里重犯、最后整份返工；打回次数因此按页计。
# 通过后最多自己看一轮图：10-23 养猫 20 页第 11 分钟就通过了自检，之后自己转图片、反复微调又花了 10 分钟。
# node -e / python -c 会被当成内联脚本送去安全确认，多数时候自动放行，偶尔要人点（10-23 哈利·波特干等 301 秒后被拒，
# 之后又花一大段思考纠结要不要停下等用户），所以让它写成文件再运行。
# .cjs：桌面版里插件在 apps/desktop/ 下面，那里的 package.json 声明了 ES 模块，.js 会被当成 ES 模块、require 报错
#（10-23 哈利·波特构建失败一次，模型自己复制一份到工作目录才绕过去）。


def _icon_names() -> str:
    """宿主图标的全部名字，用空格隔开；数据文件读不到时返回空。"""
    try:
        return " ".join(json.loads((Path(__file__).with_name("pptx_icons") / "lucide.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return ""


_ICON_NAMES = _icon_names()
BUILD_RULES = (
    "PPT 生成脚本分几份写，不要在一次调用里写出整份：\n"
    "1. 配色、字体、页面尺寸放 theme.js，公共函数复用下述宿主文件；layouts.js 只写本次需要的自由设计。"
    "哪一份写不下就再拆一份，不要为了变短删减版式。\n"
    "2. 分页按章节每 4～5 页一个文件（slides_1.js、slides_2.js……），每个文件导出一个函数，往同一个演示文稿里加页。\n"
    "3. 写一个很短的 build.js，依次调用已经写好的分页文件、保存 .pptx。每写完一个分页文件就运行一次 build.js，"
    "宿主会马上检查已写好的这几页，有问题当场改（同一类问题改公共函数），再写下一个分页文件；"
    "全部页写完、最后一次构建通过后才交付。\n"
    "每个文件控制在约 200 行、8KB 以内，直接写进文件，不要先在思考里把整份代码打一遍草稿：单次输出太长会超时作废。"
    "分页文件自己按顺序写，不要派子任务去写。\n"
    "pptxgenjs 两个常见的坑：行距按倍数设用 lineSpacingMultiple（lineSpacing 的单位是磅，写 1.2 会让几行字叠成一团）；"
    "图表数值带小数时设 dataLabelFormatCode（如 '0.0'），否则图上的数字会被取整。"
    "文字要放进自己的框里；圆里的数字对准圆心；表格各行加起来不要高出表格外框；"
    "同一排等宽的小标签里不要塞进明显更长的字；不要把 {{标题}}、%DATE% 这种没替换的记号留在页面上。\n"
    "addText 的第一个参数只能是字符串，或 [{ text, options }] 这样的数组（数组里每一项都必须是对象，不能直接放字符串）；"
    "位置和样式放第二个参数，数字先转成字符串。fontSize 的单位是磅（如 14），不要写成英寸小数（0.2 会让 PowerPoint 打不开）。"
    "pptxgenjs 在这次的工作目录里 npm install pptxgenjs 装上（几秒钟）；只在这次的工作目录里读写，"
    "不要去翻工作区里别的文件夹，那是别的对话的。"
    "不要用 node -e、python -c 这类命令行内联脚本试代码、查环境或量图片：它们会触发安全确认，没人点就干等 5 分钟后被拒。"
    "要试就写成小文件再用 node / python 运行；搜来的图结果里已经标了宽×高，直接用。"
    "已经用 patch 改过的文件，要整份重写前先 read_file 读一遍（宿主不许整份覆盖没完整读过的文件，会白写一遍）；只改几行就继续用 patch。\n"
    "正文字号不小于 12 磅，只有图片来源、页脚这类注释小字可以更小；字多放不下就精简文字，不要缩小字号。"
    "箭头（chevron）、五边形（homePlate）里的字，左侧留出约形状高度一半的内边距，避开缺口和尖角。\n"
    "宿主自检通过后，最多自己看一轮渲染图（挑最容易出问题的几页），有明显问题才改，改完就交付；"
    "不要反复渲染、反复微调。\n"
    + deck_support.BUILD + "\n" + (
        "图标用公共函数返回的 h.addIcon，不要自己用形状拼："
        "h.addIcon(slide, '名字', { x, y, size, color }) 画一个（size 是边长英寸，color 六位十六进制），"
        "颜色、大小、放在什么底色上都由你按版式定。可用的名字：" + _ICON_NAMES + "。"
        if _ICON_NAMES
        else ""
    )
)

# 每一页最多为观感问题退回两次（按页计，见 _triage）；确定的错（打不开、程序值、模板记号等）不受这个次数限制。
MAX_BOUNCES = 2
# 这一轮开始前就写好、之后没再动过的 PPT 不查：模型列目录或读旧脚本时会提到工作区里以前的文件，
# 查它们既白占退回次数，又把模型引去改不相干的文件。留两分钟余量给时钟误差和刚交付的上一轮。
STALE_BEFORE_TURN_S = 120
_MAX_DECK_BYTES = 80 * 1024 * 1024
_PROMPT_SHOWN_CHARS = 60
_PROMPTS_LISTED = 8
# Paths are found by their suffix and read back to a delimiter — never with a
# pattern that repeats a path segment. The earlier ``(?:[^\s]+[\\/])+`` form
# backtracked exponentially on a long path without the suffix: a ``find`` over
# node_modules (16 levels deep) hung the tool result, and the conversation, for
# good (2026-10-14).
_DECK_SUFFIX_RE = re.compile(r"\.pptx(?![A-Za-z0-9_])", re.IGNORECASE)
_SCRIPT_SUFFIX_RE = re.compile(r"\.(?:js|mjs|cjs|py)(?![A-Za-z0-9_])", re.IGNORECASE)
_HARD_STOPS = "\"'\n\r\t<>|`*?"
_SOFT_STOPS = " (){}[],;=:"
_MAX_SCAN = 400_000
_DECK_WORK_RE = re.compile(r"\.pptx\b|pptxgenjs|python-pptx|from\s+pptx\s+import", re.IGNORECASE)
# 退回时到生成脚本里找问题文字所在的行：只看这些后缀、最多读这么多个文件。
_QUOTED_RE = re.compile(r"「([^」]{4,})」")
_LOCATE_SUFFIXES = (".js", ".mjs", ".cjs", ".py")
_LOCATE_MAX_FILES = 40


def check_pptx(path: Path) -> List[str]:
    """检查一份 PPT 的问题清单；文件读不开时也只算一条问题，不抛异常。"""
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        return [f"文件读不开：{exc}"]
    return [str(item) for item in deck_geometry.measure(data).problems]


def is_deck_work(args: object) -> bool:
    """这次工具调用是不是在生成或修改 PPT（提到 .pptx、pptxgenjs 或 python-pptx）。"""
    try:
        flat = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        flat = str(args)
    return bool(_DECK_WORK_RE.search(flat or ""))


def format_generated_review(prompts: List[str], ai_labels: int, *, watermarked: bool = False) -> str:
    """交付前对本次请求生成的配图做一次核对提示：列出生成时的提示词，说明成品里有几处「AI 生成」标注。

    watermarked：图是 UniAI 生成的，右下角自带水印，算作 AI 生成标注，不再要求另加小字，只提醒别裁掉、盖住水印。
    """
    shown = [
        f"  {i}. {p[:_PROMPT_SHOWN_CHARS]}{'…' if len(p) > _PROMPT_SHOWN_CHARS else ''}"
        for i, p in enumerate(prompts[:_PROMPTS_LISTED], 1)
    ]
    if len(prompts) > _PROMPTS_LISTED:
        shown.append(f"  ……另有 {len(prompts) - _PROMPTS_LISTED} 次")
    labels = (
        "成品里现在一处「AI 生成」都没有。" if ai_labels == 0
        else f"成品里找到 {ai_labels} 处「AI 生成」，确认每张用上的生成图都有。"
    )
    label_line = (
        f"- 生成图右下角自带「{media_slot.UNIAI_WATERMARK}」水印，算作 AI 生成标注，不用再加小字；"
        "确认水印没有被裁掉或盖住，页码、图注、文字没有压在上面。"
        if watermarked else f"- 放进 PPT 的每张生成图，正下方要有一行小字「AI 生成」。{labels}"
    )
    return "\n".join([
        f"交付前核对生成图（这次请求生成了 {len(prompts)} 次，每次请求只核对这一回）：",
        *shown,
        "- 画的是真实存在的具体产品、品牌 IP、logo、真人、地标、事件的，换成搜到的真图；"
        "本来就没有照片的（古人、未发布产品）可以保留，图下标「示意图" + ("」。" if watermarked else "（AI 生成）」。"),
        label_line,
        "需要改的改好后重新生成；核对下来都没问题（或生成的图一张没用），直接交付，不会再拦。",
    ])


def _signature(path: Path) -> Optional[Tuple[int, int]]:
    """文件的（大小, 修改时间），用来判断上次检查之后有没有变；读不到返回 None。"""
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


def _key(path: Path) -> str:
    """同一个文件的统一写法（真实路径、Windows 下不分大小写），用作记录的键。"""
    try:
        return os.path.normcase(str(path.resolve()))
    except OSError:
        return os.path.normcase(str(path))


def annotate(tool_name: str, args: object, result: str, turn: Optional[turns.Turn] = None) -> Optional[str]:
    """检查这次调用写出的 PPT，把结论接在工具结果后面；返回 None 表示原样不动。

    每次请求为观感问题最多退回两次，之后带着清单放行，因为靠估算的检查一旦误判就会把对话卡死；
    确定的错一直退回到改好。字节没变的文件不重复检查。
    """
    turn = turn or turns.Turn(session_id="")
    paths = _pptx_paths(args, result if isinstance(result, str) else str(result or ""), turns.session_cwd(turn))
    refused: List[str] = []
    passed: List[str] = []
    released: List[str] = []
    labels = 0
    for path in paths:
        key = _key(path)
        signature = _signature(path)
        if signature is None or turn.measured.get(key) == signature:
            continue  # unchanged since the last report: nothing new to say
        if turn.started and signature[1] / 1e9 < turn.started - STALE_BEFORE_TURN_S:
            continue  # an older deck this request only mentioned, not one it wrote
        turn.measured[key] = signature
        if signature[0] > _MAX_DECK_BYTES:
            continue
        try:
            report = deck_geometry.measure(path.read_bytes())
        except OSError as exc:
            refused.append(f"{path.name}\n文件读不开：{exc}")
            continue
        labels += report.ai_labels
        if report.ok:
            deck_timing.checked(turn, pages=report.slides, held=False)
            _drop_held(path)
            passed.append(f"{path.name}\n{report.as_text()}")
            continue
        folders = _script_folders(args, result, turns.session_cwd(turn), path)
        report = _with_locations(report, folders)
        to_fix, _settled = _triage(report.problems, turn.page_bounces)
        deck_timing.checked(turn, pages=report.slides, held=bool(to_fix))
        if not to_fix:
            _drop_held(path)
            released.append(
                f"{path.name} 剩下的观感问题所在的页都已经退回过 {MAX_BOUNCES} 次，可以交给用户，"
                f"同时在回复里简单说明还剩这些：\n{report.as_text()}"
            )
            continue
        for page in {item.slide for item in to_fix if item.kind in deck_geometry.JUDGMENT_KINDS}:
            turn.page_bounces[page] = turn.page_bounces.get(page, 0) + 1
        # 已经退回够次数的那几页不再要求改，只列这次要改的，免得模型又去整份重排。
        report = dataclasses.replace(report, problems=to_fix)
        held = _hold_back(path)
        where = (
            f"已从交付位置挪开（{held.name}）。" if held != path
            else "文件正被别的程序占用，没能挪开；回复里不要写它的路径或 MEDIA 行。"
        )
        note = (
            f"{path.name}\n{report.as_text()}\n"
            f"这份还不能给用户，{where}"
            f"按上面的改法改生成脚本，改的是一类问题就改公共函数，不要逐条挪、不要整份重写。"
            f"改完仍生成到原来的路径 {path}，覆盖这一份，不要另存第二份。"
        )
        hint = _script_coord_hint(folders)
        if any(item.kind == "text_unplaced" for item in report.problems) and hint:
            note += "\n" + hint
        refused.append(note)
    if not (refused or passed or released):
        return None

    review = ""
    if (passed or released) and not refused and turn.generated and not turn.reviewed:
        turn.reviewed = True
        review = format_generated_review(
            list(turn.generated), labels, watermarked=media_slot.watermarked(media_slot.load_slot()),
        )

    parts: List[str] = []
    if refused:
        turn.bounces += 1
        parts.append(
            "没有交付：宿主在写入后做了版面自检，这份 PPT 还不能给用户。"
            "工作稿已经挪开，对话里不要写它的 MEDIA 行。"
            "下面每一类问题都要改掉，改法写在各类后面；同一类出在很多页，改生成脚本里的公共函数，不要逐条挪。"
            "用 patch 改对应的几行，不要重写整个脚本。改完重新生成到同一路径，宿主会再查一遍。"
            "自检通过之前不要交给用户。"
        )
        parts.extend(refused)
    elif review:
        parts.append("先别交付：" + review)
    parts.extend(released)
    parts.extend(passed)
    if not refused and not review:
        # 分批构建时每批都会走到这里：没写完的接着写，最后一次构建通过才交付。
        parts.append("还有分页没写完就接着写，全部写完、最后一次构建通过后再交付。" + delivery.deck_line(turn.platform))
    body = result if isinstance(result, str) else str(result or "")
    return body.rstrip() + "\n\n" + "\n\n".join(parts)


def _script_coord_hint(folders: List[Path]) -> str:
    """写文字的函数没把坐标传进去时，指出是哪个文件。"""
    names = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for script in sorted(folder.glob("*.js")):
            try:
                text = script.read_text(encoding="utf-8")
            except OSError:
                continue
            body = re.search(r"function txt\b[\s\S]{0,900}", text)
            if body and "addText" in body.group(0) and not re.search(r"\bx\s*:", body.group(0)):
                names.append(script.name)
    if not names:
        return "去生成脚本里找 function txt，把 x、y 写进 addText。"
    return "坐标没传进去的函数在 " + "、".join(names) + "。只改这些 txt，把 o.x、o.y 写进 addText。"


def _triage(problems, page_bounces: Dict[int, int]) -> Tuple[tuple, tuple]:
    """把问题分成这次要改的和可以带着交付的。

    确定的错一直要改。观感问题按页计数：同一页已经退回 MAX_BOUNCES 次就不再要求改，新写的页重新计数。
    按页而不是按请求计数，是因为分批构建时前几批就会用掉次数，后面新写的页的问题会被直接放过。
    整份层面的问题（页码为 0，如合并后的「第 2、3、4 页都……」）算作一页。
    """
    to_fix, settled = [], []
    for item in problems:
        if item.kind in deck_geometry.JUDGMENT_KINDS and page_bounces.get(item.slide, 0) >= MAX_BOUNCES:
            settled.append(item)
        else:
            to_fix.append(item)
    return tuple(to_fix), tuple(settled)


def _drop_held(path: Path) -> None:
    """这份已经能交付：删掉之前挪开的旧工作稿，免得工作区里留两份。"""
    try:
        path.with_name(path.name + ".building").unlink(missing_ok=True)
    except OSError:
        pass


def _hold_back(path: Path) -> Path:
    """有问题的稿先挪成非 pptx，避免桌面把它当成已交付的文件。挪不动就留在原地。"""
    held = path.with_name(path.name + ".building")
    try:
        if held.exists():
            held.unlink()
        path.replace(held)
    except OSError:
        return path
    return held


def _walk(value: Any, found: List[str]) -> None:
    """把参数里的所有字符串（包括嵌套的字典和列表）收集出来。"""
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            _walk(item, found)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _walk(item, found)


def candidates(text: str, suffix_re: "re.Pattern[str]") -> List[str]:
    """找出以指定后缀结尾的字符串，往回读到分隔符为止。

    每处命中给出两个候选：读到引号类字符（带空格的路径），和读到空格或括号（不带空格的路径）。只做一遍线性扫描，不会回溯；以前的正则在很长的路径上会指数级回溯，把对话卡死过。
    """
    text = (text or "")[:_MAX_SCAN]
    out: List[str] = []
    hard = soft = -1
    position = 0
    for match in suffix_re.finditer(text):
        for index in range(position, match.start()):
            char = text[index]
            if char in _HARD_STOPS:
                hard = soft = index
            elif char in _SOFT_STOPS and not (char == ":" and index >= 1 and text[index - 1].isalpha()
                                              and (index < 2 or not text[index - 2].isalnum())):
                soft = index
        position = match.start()
        for start in dict.fromkeys((soft + 1, hard + 1)):
            token = text[start:match.end()].strip()
            if token and token not in out:
                out.append(token)
    return out


_CD_RE = re.compile(r"(?:^|&&|;|\|\||\n)\s*(?:cd|pushd|Set-Location)\s+(?:/d\s+)?(\"[^\"\r\n]+\"|'[^'\r\n]+'|[^\s;&|]+)")
_GIT_BASH_DRIVE_RE = re.compile(r"^/([A-Za-z])(/|$)")


def local_dir(raw: str) -> Optional[Path]:
    """命令里写的目录：展开环境变量，Git Bash 的 /c/... 换成 C:/...；不是已存在的目录返回 None。"""
    text = os.path.expandvars(raw.strip().strip('"').strip("'"))
    if os.name == "nt":
        text = _GIT_BASH_DRIVE_RE.sub(lambda m: f"{m.group(1).upper()}:/", text)
    path = Path(os.path.expanduser(text))
    try:
        return path if path.is_dir() else None
    except (OSError, ValueError):
        return None


def command_dirs(args: object) -> List[Path]:
    """一条命令按顺序 cd 进过的目录。"""
    blobs: List[str] = []
    _walk(args, blobs)
    found: List[Path] = []
    for blob in blobs:
        for match in _CD_RE.finditer(blob[:_MAX_SCAN]):
            folder = local_dir(match.group(1))
            if folder is not None and folder not in found:
                found.append(folder)
    return found


def _existing(token: str, bases: List[Path]) -> Optional[Path]:
    """把一个路径片段当成文件找：绝对路径直接看，相对路径在各候选目录下找。"""
    text = os.path.expandvars(token)
    if os.name == "nt":
        text = _GIT_BASH_DRIVE_RE.sub(lambda m: f"{m.group(1).upper()}:/", text)
    path = Path(text)
    tries = [path] if path.is_absolute() else [base / path for base in bases]
    for candidate in tries:
        try:
            if candidate.is_file():
                return candidate
        except (OSError, ValueError):
            continue
    return None


def _from_text(text: str, bases: List[Path]) -> List[Path]:
    """从一段文字里找出真实存在的 .pptx 文件。"""
    found: List[Path] = []
    for token in candidates(text, _DECK_SUFFIX_RE):
        path = _existing(token, bases)
        if path is not None and path not in found:
            found.append(path)
    return found


def _scripts(text: str, bases: List[Path]) -> List[Path]:
    """从一段文字里找出跑过的脚本（js、py），太大的不读。"""
    found: List[Path] = []
    for token in candidates(text, _SCRIPT_SUFFIX_RE):
        path = _existing(token, bases)
        try:
            if path is not None and path.stat().st_size <= 200_000 and path not in found:
                found.append(path)
        except OSError:
            continue
    return found


def _script_folders(args: object, result: object, cwd: str, deck: Path) -> List[Path]:
    """生成这份 PPT 的脚本可能在的目录：这次跑的脚本所在目录，加上 PPT 自己所在的目录。"""
    blobs: List[str] = []
    _walk(args, blobs)
    blobs.append(result if isinstance(result, str) else str(result or ""))
    bases = command_dirs(args)
    folder = local_dir(cwd) if cwd else None
    if folder is not None and folder not in bases:
        bases.append(folder)
    found: List[Path] = []
    for blob in blobs:
        for script in _scripts(blob, bases):
            if script.parent not in found:
                found.append(script.parent)
    if deck.parent not in found:
        found.append(deck.parent)
    return found


def _source_lines(folders: List[Path]) -> List[Tuple[Path, List[str]]]:
    """这些目录里（不往子目录钻）的生成脚本，按行切好；太大的、太多的不读。"""
    sources: List[Tuple[Path, List[str]]] = []
    for folder in folders:
        try:
            entries = sorted(folder.iterdir())
        except OSError:
            continue
        for path in entries:
            if len(sources) >= _LOCATE_MAX_FILES:
                return sources
            try:
                if path.suffix.lower() in _LOCATE_SUFFIXES and path.is_file() and path.stat().st_size <= 200_000:
                    sources.append((path, path.read_text(encoding="utf-8", errors="ignore").splitlines()))
            except OSError:
                continue
    return sources


def _find_line(sample: str, sources: List[Tuple[Path, List[str]]]) -> Optional[str]:
    """一段页面文字最早出现在哪个脚本的第几行；太短的（「图片」「形状」这类占位名）不找。"""
    needle = sample.strip()[:12]
    if len(needle) < 4:
        return None
    for path, lines in sources:
        for number, line in enumerate(lines, 1):
            if needle in line:
                return f"{path.name} 第 {number} 行"
    return None


def _with_locations(report: "deck_geometry.DeckReport", folders: List[Path]) -> "deck_geometry.DeckReport":
    """给退回清单里带「原文」的问题标上它在生成脚本里的文件和行号，模型直接 patch 那一行，
    不用再把几个分页脚本重读一遍、想半天才找到位置（实测每轮修改要 1～4 分钟，大半花在找位置上）。找不到的照旧。"""
    sources = _source_lines(folders)
    if not sources:
        return report
    located = []
    for problem in report.problems:
        quoted = _QUOTED_RE.search(problem.detail)
        where = _find_line(quoted.group(1), sources) if quoted else None
        located.append(dataclasses.replace(problem, detail=f"{problem.detail}（脚本里在 {where}）") if where else problem)
    return dataclasses.replace(report, problems=tuple(located))


def _pptx_paths(args: object, result: str, cwd: str = "") -> List[Path]:
    """这次调用提到的 PPT：参数里、输出里，或它跑的脚本里写的。

    相对路径按命令 cd 进的目录和会话工作目录去找。模型跑 cd out && node gen.js 后只打印 xihu.pptx 的情况，以前会漏掉。
    """
    blobs: List[str] = []
    _walk(args, blobs)
    blobs.append(result)
    try:
        _walk(json.loads(result), blobs)
    except (ValueError, TypeError):
        pass
    bases = command_dirs(args)
    if cwd:
        folder = local_dir(cwd)
        if folder is not None and folder not in bases:
            bases.append(folder)
    found: List[Path] = []
    for blob in blobs:
        for path in _from_text(blob, bases):
            if path not in found:
                found.append(path)
        for script in _scripts(blob, bases):
            try:
                body = script.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for path in _from_text(body, [script.parent, *bases]):
                if path not in found:
                    found.append(path)
    return found
