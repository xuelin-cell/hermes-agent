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

import json
import os
import re
from pathlib import Path
from typing import Any, List, Optional, Tuple

from . import deck_geometry, delivery, turns

MAX_BOUNCES = 2
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


def check_pptx(path: Path) -> List[str]:
    """Problems in *path*. An unreadable file yields one problem, not an exception."""
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        return [f"文件读不开：{exc}"]
    return [str(item) for item in deck_geometry.measure(data).problems]


def is_deck_work(args: object) -> bool:
    """Whether a tool call builds or edits a deck (.pptx / pptxgenjs / python-pptx)."""
    try:
        flat = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        flat = str(args)
    return bool(_DECK_WORK_RE.search(flat or ""))


def format_generated_review(prompts: List[str], ai_labels: int) -> str:
    """One-time check of this request's generated pictures."""
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
    return "\n".join([
        f"交付前核对生成图（这次请求生成了 {len(prompts)} 次，每次请求只核对这一回）：",
        *shown,
        "- 画的是真实存在的具体产品、品牌 IP、logo、真人、地标、事件的，换成搜到的真图；"
        "本来就没有照片的（古人、未发布产品）可以保留，图下标「示意图（AI 生成）」。",
        f"- 放进 PPT 的每张生成图，正下方要有一行小字「AI 生成」。{labels}",
        "需要改的改好后重新生成；核对下来都没问题（或生成的图一张没用），直接交付，不会再拦。",
    ])


def _signature(path: Path) -> Optional[Tuple[int, int]]:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


def _key(path: Path) -> str:
    try:
        return os.path.normcase(str(path.resolve()))
    except OSError:
        return os.path.normcase(str(path))


def annotate(tool_name: str, args: object, result: str, turn: Optional[turns.Turn] = None) -> Optional[str]:
    """Report on decks this call wrote. ``None`` leaves the tool result alone."""
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
        elif turn.bounces < MAX_BOUNCES:
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
        review = format_generated_review(list(turn.generated), labels)

    parts: List[str] = []
    if refused:
        turn.bounces += 1
        parts.append("没有交付：宿主在写入后做了版面自检，这份 PPT 还不能给用户。请按改法改文件，改完重新生成，宿主会再查一遍。")
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
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            _walk(item, found)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _walk(item, found)


def candidates(text: str, suffix_re: "re.Pattern[str]") -> List[str]:
    """Strings ending in a suffix *suffix_re* finds, read back to a delimiter.

    Each hit yields the span back to the last quote-like character (a path with
    spaces) and the span back to the last space or bracket (a bare path).
    Linear in the text; nothing here can backtrack.
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
    """A directory named in a command, with env vars expanded and ``/c/…`` read as ``C:/…``."""
    text = os.path.expandvars(raw.strip().strip('"').strip("'"))
    if os.name == "nt":
        text = _GIT_BASH_DRIVE_RE.sub(lambda m: f"{m.group(1).upper()}:/", text)
    path = Path(os.path.expanduser(text))
    try:
        return path if path.is_dir() else None
    except (OSError, ValueError):
        return None


def command_dirs(args: object) -> List[Path]:
    """Directories a shell command ``cd``s into, in order."""
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
    found: List[Path] = []
    for token in candidates(text, _DECK_SUFFIX_RE):
        path = _existing(token, bases)
        if path is not None and path not in found:
            found.append(path)
    return found


def _scripts(text: str, bases: List[Path]) -> List[Path]:
    found: List[Path] = []
    for token in candidates(text, _SCRIPT_SUFFIX_RE):
        path = _existing(token, bases)
        try:
            if path is not None and path.stat().st_size <= 200_000 and path not in found:
                found.append(path)
        except OSError:
            continue
    return found


def _pptx_paths(args: object, result: str, cwd: str = "") -> List[Path]:
    """Decks the call names: in its arguments, its output, or a script it ran.

    Relative names are read against the directories the command ``cd``s into
    and the session's working directory — a model that ran
    ``cd out && node gen.js`` and printed ``xihu.pptx`` was missed otherwise.
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
