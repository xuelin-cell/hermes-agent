"""Check a deck when a tool writes it, before the user sees it.

数字员工 measured every ``.pptx`` at ``PresentToUser`` and, at most twice per
request, answered with the defect list instead of delivering it. Hermes has no
delivery tool, so the check rides on the tool result that wrote the deck
(``transform_tool_result``): any ``.pptx`` the call's arguments, its output or
a script it ran names, measured again only when its bytes changed. Two bounces
per request; after that the report rides along and the deck goes through,
because a check that can trap a conversation is worse than the defect.

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
from typing import Any, List, Optional, Tuple

from . import deck_geometry, delivery, media_slot, turns

# 做 PPT 时附给模型的写法规则：一次调用写出 20 页的整份脚本，生成十来分钟后会超时作废（2026-10-20 实测
# 白等了 597 秒），退回修改时也容易整份重写。分份写，每份两三分钟，改哪页只动哪一份。
# 限的是每份的大小，不是公共部分的内容：公共版式写不下就拆成几份，否则模型会在各页里各写一套版式，风格散掉。
# 推理强度「中」时，动手前的长思考加上大段输出仍会超时（同日实测公共文件又白等 595 秒），所以要求直接写文件。
# 曾经让 10 页以上派子代理同时写分页，2026-10-20/21 实测反而慢：父任务要把每页内容写进派活说明（1～2.5 万字、
# 2.5～6.7 分钟），再等子任务 4～6 分钟把同样的内容改写成代码，比自己直接写分页多花 6～9 分钟，所以去掉了。
# 行距单位和图表小数格式是 pptxgenjs 最常见的两个坑（同日实测整份 20 页文字叠成一团、图上 18.6 标成 19），
# 宿主的版面检查会拦，但事先说一句比退回改一轮便宜。
BUILD_RULES = (
    "PPT 生成脚本分几份写，不要在一次调用里写出整份：\n"
    "1. 公共部分先写：配色、字体、页面尺寸放 theme.js，封面、章节页、正文页这类版式函数放 layouts.js，"
    "图标放 icons.js。哪一份写不下就再拆一份，不要为了变短删减版式。\n"
    "2. 分页按章节每 4～5 页一个文件（slides_1.js、slides_2.js……），每个文件导出一个函数，往同一个演示文稿里加页。\n"
    "3. 最后写一个很短的 build.js，依次调用它们、保存 .pptx，然后运行它。\n"
    "每个文件控制在约 200 行、8KB 以内，直接写进文件，不要先在思考里把整份代码打一遍草稿：单次输出太长会超时作废。"
    "分页文件自己按顺序写，不要派子任务去写。\n"
    "pptxgenjs 两个常见的坑：行距按倍数设用 lineSpacingMultiple（lineSpacing 的单位是磅，写 1.2 会让几行字叠成一团）；"
    "图表数值带小数时设 dataLabelFormatCode（如 '0.0'），否则图上的数字会被取整。"
)

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

    每次请求最多退回两次，之后连同问题一起放行，因为能把对话卡死的检查比问题本身更糟。字节没变的文件不重复检查。
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
            passed.append(f"{path.name}\n{report.as_text()}")
            continue
        report = _with_locations(report, _script_folders(args, result, turns.session_cwd(turn), path))
        if turn.bounces < MAX_BOUNCES:
            refused.append(f"{path.name}\n{report.as_text()}")
        else:
            released.append(
                f"{path.name} 这次请求已经退回 {MAX_BOUNCES} 次。可以交给用户，同时在回复里说明还剩这些问题：\n{report.as_text()}"
            )
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
        # 整份重写几十 KB 的生成脚本要好几分钟，还可能把没问题的页改坏；只改出问题的地方。
        parts.append(
            "没有交付：宿主在写入后做了版面自检，这份 PPT 还不能给用户。"
            "只改下面列出的那几处：用 patch 改生成脚本里对应的几行，不要重写整个脚本；"
            "某一页确实要大改，就只重写那一页的代码。改完重新生成，宿主会再查一遍。"
        )
        parts.extend(refused)
    elif review:
        parts.append("先别交付：" + review)
    parts.extend(released)
    parts.extend(passed)
    if not refused and not review:
        parts.append(delivery.deck_line(turn.platform))
    body = result if isinstance(result, str) else str(result or "")
    return body.rstrip() + "\n\n" + "\n\n".join(parts)


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
