"""Handing finished files to the user the way the chat window shows them.

数字员工's ``PresentToUser`` put a card in the conversation. The Hermes desktop
does the same for a ``MEDIA:<absolute path>`` line: preview and download for
any file, inline for pictures, audio and video (the desktop platform hint says
so). Packages still say ``PresentToUser`` / ``present_files``; the host rules
translate that into this line.

Models still write 「已保存到 C:\\…」 often enough, so the final reply gets a
safety net (``transform_llm_output``): files this request wrote and the reply
names, with no card yet, get a ``MEDIA:`` line appended. Only on the desktop —
the CLI and TUI print the tag literally. The net changes what the user sees
now; the stored transcript keeps the model's own words, so the instruction is
still the real fix.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable, List, Optional

from . import turns

MEDIA_PLATFORMS = frozenset({"desktop"})
DELIVERABLE_EXTENSIONS = (
    "pptx", "ppt", "docx", "doc", "xlsx", "xls", "csv", "pdf", "md", "html", "htm",
    "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov", "webm", "mp3", "wav", "m4a", "zip",
)
_MAX_CARDS = 8
_CLOCK_SLACK_S = 2.0
_EXT = "|".join(DELIVERABLE_EXTENSIONS)
_CJK = "\u4e00-\u9fff"
_STOP = r"\s\"'<>|*?`" + "，。；：！？、（）()【】" + r"\[\]{}"
# A root that starts a local path. Never ``//`` (URLs, UNC): stat on a UNC
# name can wait on the network.
_ROOT = r"(?<![\w:/\\.])(?:[A-Za-z]:[\\/]|~[\\/]|/(?![/\\]))"
_ABSOLUTE_RE = re.compile(_ROOT + "[^" + _STOP + "]+?" + r"\.(?:" + _EXT + r")(?![A-Za-z0-9])", re.IGNORECASE)
_DIR_RE = re.compile(_ROOT + "[^" + _STOP + "]+")
_LOOKS_ABSOLUTE_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|~[\\/]|/(?![/\\]))")
_ENDS_DELIVERABLE_RE = re.compile(r"\.(?:" + _EXT + r")$", re.IGNORECASE)
_TICKED_RE = re.compile(r"`([^`\n]+)`")
_BARE_RE = re.compile(
    r"(?<![\w./\\-])([\w" + _CJK + r"][\w" + _CJK + r".-]*\.(?:" + _EXT + r"))(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_MEDIA_RE = re.compile(r"MEDIA:\s*(`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)")
_LINK_RE = re.compile(r"\]\(\s*<?([^)>\n]+)>?\s*\)")
_TRAILING = ".,;:!?" + "，。；：！？、"


def instruction(platform: str) -> str:
    """The delivery line for *platform*, said in the host's words."""
    if platform in MEDIA_PLATFORMS:
        return (
            "- 交付文件写好后，在回复里每个文件单独一行写 `MEDIA:<绝对路径>`（例：`MEDIA:C:/Users/me/报告.docx`），"
            "对话里会出现可预览、可下载的文件卡片；只写目录或文件名不会出卡片。"
            "包里说的 PresentToUser / present_files 在这里就是这样写。"
        )
    return (
        "- 交付文件写好后，按本平台的发文件方式交给用户；平台不能发文件时在回复里写出每个文件的完整路径。"
        "包里说的 PresentToUser / present_files 在这里就是这样做，不要声称已弹出文件卡片。"
    )


# The expert rule before 2026-10-14 said there were no file cards. A session's
# system prompt is frozen when it starts, and a bot keeps one forever-chat, so
# those chats carry the old line for good. They get a correction on each turn's
# user message instead (cache-safe: it rides the API copy of this turn only).
_OLD_RULE_MARK = "不要声称已弹出文件卡片"
_frozen: dict = {}


def frozen_prompt_contains(home: Path, session_id: str, needle: str) -> bool:
    """Whether *session_id*'s stored system prompt in *home* contains *needle*.

    Read-only; remembered per session because a stored prompt never changes.
    A session not written yet reads as ``False`` and is asked again next turn.
    """
    key = (str(home), str(session_id), needle)
    if not session_id:
        return False
    if key in _frozen:
        return _frozen[key]
    import sqlite3

    db = Path(home) / "state.db"
    if not db.is_file():
        return False
    try:
        con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=1.0)
        try:
            row = con.execute(
                "SELECT COALESCE(sp.prompt, s.system_prompt) FROM sessions s "
                "LEFT JOIN system_prompts sp ON sp.hash = s.system_prompt_hash WHERE s.id = ?",
                (str(session_id),),
            ).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return False
    if not row or not row[0]:
        return False
    _frozen[key] = needle in row[0]
    return _frozen[key]


def stale_rule_correction(home: Path, session_id: str, platform: str) -> str:
    """The per-turn correction for a desktop chat whose prompt still says no cards."""
    if platform not in MEDIA_PLATFORMS or not frozen_prompt_contains(home, session_id, _OLD_RULE_MARK):
        return ""
    return (
        "（宿主更正：本应用桌面版能在对话里显示文件卡片。交付文件时每个文件单独一行写 `MEDIA:<绝对路径>`，"
        "对话里会出现可预览、可下载的卡片；系统提示里「写明完整路径、不要声称已弹出文件卡片」那条已作废。）"
    )


def deck_line(platform: str) -> str:
    """The short version the PPT rules and the deck check end with."""
    if platform in MEDIA_PLATFORMS:
        return "做完把 .pptx 交给用户：回复里单独一行写 `MEDIA:<pptx 绝对路径>`，对话里会出现可预览、可下载的文件卡片。"
    return "做完在回复里写出 .pptx 的完整路径。"


def _unquote(token: str) -> str:
    token = token.strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "`\"'":
        token = token[1:-1]
    return token.strip().rstrip(_TRAILING)


def _key(path: Path) -> str:
    try:
        return os.path.normcase(str(path.resolve()))
    except OSError:
        return os.path.normcase(str(path))


def _expand(token: str) -> Path:
    return Path(os.path.expanduser(token))


def _already_carded(text: str) -> set:
    found = set()
    for match in _MEDIA_RE.finditer(text):
        found.add(_key(_expand(_unquote(match.group(1)))))
    for match in _LINK_RE.finditer(text):
        found.add(_key(_expand(_unquote(match.group(1)))))
    return found


def _named_paths(text: str) -> List[Path]:
    """Absolute paths the reply names, in order. A backticked span may hold spaces."""
    seen: List[str] = []
    for match in _TICKED_RE.finditer(text):
        inner = _unquote(match.group(1))
        if _ENDS_DELIVERABLE_RE.search(inner) and _LOOKS_ABSOLUTE_RE.match(inner):
            seen.append(inner)
    for match in _ABSOLUTE_RE.finditer(text):
        seen.append(_unquote(match.group(0)))
    return [_expand(item) for item in dict.fromkeys(seen)]


def _named_dirs(text: str, cwd: str) -> List[Path]:
    tokens = [_unquote(m.group(1)) for m in _TICKED_RE.finditer(text) if _LOOKS_ABSOLUTE_RE.match(_unquote(m.group(1)))]
    tokens += [_unquote(m.group(0)) for m in _DIR_RE.finditer(text)]
    dirs: List[Path] = []
    for token in tokens:
        candidate = _expand(token.rstrip("\\/"))
        try:
            if candidate.is_dir() and candidate not in dirs:
                dirs.append(candidate)
        except OSError:
            continue
    if cwd and Path(cwd).is_dir():
        dirs.append(Path(cwd))
    return dirs


def _bare_names(text: str) -> List[str]:
    names: List[str] = []
    for match in _BARE_RE.finditer(text):
        name = match.group(1).strip()
        if name and name not in names:
            names.append(name)
    return names


def _fresh(path: Path, since: float) -> bool:
    try:
        return path.is_file() and path.stat().st_mtime >= since - _CLOCK_SLACK_S
    except OSError:
        return False


def files_to_card(text: str, since: float, cwd: str = "") -> List[Path]:
    """Files written since *since* that *text* names and has not carded yet."""
    if not text:
        return []
    keys = set(_already_carded(text))
    picked: List[Path] = []

    def take(path: Path) -> None:
        key = _key(path)
        if key in keys or not _fresh(path, since):
            return
        keys.add(key)
        picked.append(path)

    for path in _named_paths(text):
        take(path)
    dirs = _named_dirs(text, cwd)
    for name in _bare_names(text):
        for folder in dirs:
            candidate = folder / name
            if candidate.is_file():
                take(candidate)
                break
    return picked[:_MAX_CARDS]


def media_line(path: Path) -> str:
    shown = str(path)
    return f"MEDIA:`{shown}`" if re.search(r"\s", shown) else f"MEDIA:{shown}"


def append_cards(text: str, paths: Iterable[Path]) -> Optional[str]:
    lines = [media_line(path) for path in paths]
    if not lines:
        return None
    return text.rstrip() + "\n\n" + "\n".join(lines)


def on_transform_llm_output(response_text: str = "", session_id: str = "", platform: str = "", **_: object) -> Optional[str]:
    """Card the files this request produced and the reply names. ``None`` leaves the reply alone."""
    try:
        turn = turns.peek(session_id)
        where = platform or (turn.platform if turn else "")
        if where not in MEDIA_PLATFORMS or turn is None or not turn.started:
            return None
        return append_cards(response_text, files_to_card(response_text, turn.started, turns.session_cwd(turn)))
    except Exception:
        return None
