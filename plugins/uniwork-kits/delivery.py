"""Handing finished files to the user the way the chat window shows them.

数字员工's ``PresentToUser`` put a card in the conversation. The Hermes desktop
does the same for a ``MEDIA:<absolute path>`` line: preview and download for
any file, inline for pictures, audio and video (the desktop platform hint says
so). Packages still say ``PresentToUser`` / ``present_files``; the host rules
translate that into this line.

Finished-file observation belongs to ``desktop-deliverables``. This module
only keeps the expert and PPT delivery instructions.
"""

from __future__ import annotations

from pathlib import Path

MEDIA_PLATFORMS = frozenset({"desktop"})


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
