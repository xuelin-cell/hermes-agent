"""The host's own tool hooks: picture rules, image landing, deck checks.

Package hooks (a kit's ``PreToolUse`` commands) live in :mod:`package_hooks`;
these are what 数字员工's middlewares did around every tool call, keyed on the
session's current request (:mod:`turns`).

Everything here only adds to the current turn — a tool result about to be
appended, or a call answered without running — so the cached prefix is never
touched.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Optional

from . import deck_check, delivery, image_landing, media_slot, turns

logger = logging.getLogger(__name__)

PPT_KITS = ("pptx", "ppt-writer")
_GENERATOR_LEAVES = frozenset({media_slot.UNIAI_IMAGE, media_slot.DEFAULT_IMAGE_TOOL})


def is_ppt_skill(tool_name: str, args: Any) -> bool:
    """``skill_view`` of a skill from a PPT kit (``pptx--pptx``, ``ppt-writer--create-ppt`` …)."""
    if tool_name != "skill_view" or not isinstance(args, dict):
        return False
    name = str(args.get("name") or args.get("skill") or "")
    return any(name.startswith(f"{kit}--") for kit in PPT_KITS)


def _is_expert_home() -> bool:
    try:
        from hermes_constants import get_hermes_home

        from . import router

        return router.is_expert_home(Path(get_hermes_home()))
    except Exception:
        return False


def _pictures_enabled() -> bool:
    from . import router

    return router.pictures_enabled()


def _generated_prompt(tool_name: str, args: Any, result: str) -> Optional[str]:
    if media_slot.leaf(tool_name) not in _GENERATOR_LEAVES or not isinstance(args, dict):
        return None
    lowered = result.lower()
    if '"error"' in lowered[:200] or not any(mark in lowered for mark in ("http", ".png", ".jpg", ".jpeg", ".webp")):
        return None
    return " ".join(str(args.get("prompt") or "").split())


def picture_rules(platform: str) -> str:
    return media_slot.picture_rules(delivery=delivery.deck_line(platform))


def on_pre_tool_call(
    tool_name: str = "", args: Any = None, session_id: str = "", turn_id: str = "", task_id: str = "", **_: Any,
) -> Optional[Dict[str, str]]:
    """Answer a repeated or over-budget image search without calling the MCP."""
    try:
        if not image_landing.is_image_search(tool_name):
            return None
        turn = turns.current(session_id, turn_id, task_id)
        answer = image_landing.before_search(turn, args)
        return {"action": "block", "message": answer} if answer else None
    except Exception:
        logger.warning("[uniwork-kits] image search budget failed", exc_info=True)
        return None


def on_transform_tool_result(
    tool_name: str = "",
    args: Any = None,
    result: Any = "",
    session_id: str = "",
    turn_id: str = "",
    task_id: str = "",
    **_: Any,
) -> Optional[str]:
    """Add what the host knows to a tool result. ``None`` leaves it alone."""
    try:
        turn = turns.current(session_id, turn_id, task_id)
        original = result if isinstance(result, str) else str(result or "")
        text = original
        ppt_skill = is_ppt_skill(tool_name, args)
        kit_side = not _is_expert_home()  # 数字员工: picture rules and landing are for kits only
        if kit_side and (ppt_skill or deck_check.is_deck_work(args)):
            turn.deck = True
        prompt = _generated_prompt(tool_name, args, text)
        if prompt is not None and kit_side:
            turn.generated.append(prompt)
        if image_landing.is_image_search(tool_name):
            text = image_landing.after_search(turn, args, text) or text
        if ppt_skill and kit_side and not turn.rules_shown and _pictures_enabled():
            turn.rules_shown = True
            text = text.rstrip() + "\n\n" + picture_rules(turn.platform)
        checked = deck_check.annotate(tool_name, args, text, turn)
        if checked is not None:
            text = checked
        return text if text != original else None
    except Exception:
        logger.warning("[uniwork-kits] tool result hook failed", exc_info=True)
        return None
