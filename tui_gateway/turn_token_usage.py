"""Display-only turn totals derived from Hermes' provider usage counters."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_COUNTERS = {
    "input_tokens": "session_prompt_tokens",
    "output_tokens": "session_completion_tokens",
    "total_tokens": "session_total_tokens",
    "cache_read_tokens": "session_cache_read_tokens",
    "cache_write_tokens": "session_cache_write_tokens",
}


def token_usage_snapshot(agent) -> dict[str, int] | None:
    values = {key: getattr(agent, attr, None) for key, attr in _COUNTERS.items()}
    if any(type(value) is not int or value < 0 for value in values.values()):
        return None
    return values


def turn_token_delta(before: dict[str, int] | None, agent) -> dict[str, int] | None:
    after = token_usage_snapshot(agent)
    if before is None or after is None:
        return None
    delta = {key: after[key] - before[key] for key in _COUNTERS}
    # A reset is not consumption, and absent provider usage must not become a zero badge.
    if any(value < 0 for value in delta.values()) or delta["total_tokens"] <= 0:
        return None
    return delta


def persist_turn_token_usage(agent, messages, receipt: dict | None, usage: dict) -> None:
    """Address only this turn's committed closing assistant row, including partial replies."""
    if not receipt or not isinstance(messages, list) or not messages:
        return
    last = messages[-1]
    row_id = last.get("_row_id")
    if (last.get("role") != "assistant" or last.get("tool_calls")
            or row_id not in receipt["row_ids"]):
        return
    db = getattr(agent, "_session_db", None)
    if db is None:
        return
    try:
        if db.set_message_turn_token_usage(agent.session_id, row_id, usage):
            last["display_metadata"] = {**(last.get("display_metadata") or {}), "turn_token_usage": usage}
    except Exception:
        logger.warning("Could not persist turn token usage", exc_info=True)
