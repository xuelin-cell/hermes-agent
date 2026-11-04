"""Display-only turn totals derived from Hermes' provider usage counters."""

from __future__ import annotations

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
