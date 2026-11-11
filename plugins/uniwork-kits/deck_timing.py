"""Local PPT-only request timings through existing observer hooks.

No text/arguments/URLs are retained. Foreground start/end bound the records, so
background review with the same session id cannot inflate the user's latency.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_active = OrderedDict()


@dataclass
class Timing:
    started: float
    attempts: dict = field(default_factory=dict)
    api_ms: float = 0
    tool_ms: float = 0
    errors: int = 0


def _key(session_id, turn_id):
    from hermes_constants import hermes_home_key

    return hermes_home_key(), str(session_id), str(turn_id)


def _emit(key, event, **fields):
    # The profile's normal logger owns file routing. Never serialize the hook payload.
    logger.info("[ppt-timing] %s", json.dumps({"event": event, "session_id": key[1],
                "turn_id": key[2], **fields}, ensure_ascii=False))


def begin(session_id, turn_id):
    from hermes_cli.config import load_config_readonly

    section = load_config_readonly().get("uniwork_kits") or {}
    if isinstance(section, dict) and section.get("ppt_timing", True) is False:
        return
    key = _key(session_id, turn_id)
    with _lock:
        if key in _active:
            return
        _active[key] = Timing(time.monotonic())
        while len(_active) > 256:
            _active.popitem(last=False)
    _emit(key, "start")


def on_pre_api_request(session_id="", turn_id="", api_request_id="", retry_count=0, **_):
    with _lock:
        state = _active.get(_key(session_id, turn_id))
        if state is not None:
            state.attempts[api_request_id] = retry_count


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _api(event, *, session_id="", turn_id="", api_request_id="", started_at=None,
         ended_at=None, first_chunk_at=None, api_duration=None, usage=None, model="", error=None, **_):
    key = _key(session_id, turn_id)
    duration = _number(api_duration)
    first = _number(first_chunk_at)
    start, end = _number(started_at), _number(ended_at)
    wait = (first - start) * 1000 if first is not None and start is not None and end is not None and start <= first <= end else None
    ms = round(duration * 1000, 2) if duration is not None and duration >= 0 else None
    tokens = {k: v for k, v in (usage or {}).items()
              if k in ("input_tokens", "prompt_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens") and _number(v) is not None}
    with _lock:
        state = _active.get(key)
        if state is None or api_request_id not in state.attempts:
            return
        retry = state.attempts.pop(api_request_id)
        state.api_ms += ms or 0
        state.errors += int(event == "api_error")
    _emit(key, event, request_id=api_request_id, retry_count=retry, model=model,
          started_at=start, ended_at=end, duration_ms=ms,
          first_chunk_wait_ms=round(wait, 2) if wait is not None else None,
          after_first_chunk_ms=round(max(0, ms - wait), 2) if wait is not None and ms is not None else None,
          usage=tokens, error_type=(error or {}).get("type") if isinstance(error, dict) else None)


def on_post_api_request(**kwargs):
    _api("api", **kwargs)


def on_api_request_error(**kwargs):
    _api("api_error", **kwargs)


def _category(tool_name, args):
    name = tool_name.rsplit("__", 1)[-1]
    if name != "terminal":
        return {"write_file": "file_io", "patch": "file_io", "analyze_image": "vision",
                "txt2img_generate": "imagegen", "image_edit": "imagegen", "image_search": "image_search",
                "skill_view": "skill_read"}.get(name, "other")
    command = str((args or {}).get("command", "")) if isinstance(args, dict) else ""
    rules = ((r"commons_images\.py", "photo_fetch"), (r"check\.cjs", "helper_check"),
             (r"node\s+[^\n]*build\.[cm]?js", "build"), (r"npm\s+install", "dependency_setup"),
             (r"soffice|render|pdftoppm", "render"), (r"markitdown", "extract_text"))
    return next((label for pattern, label in rules if re.search(pattern, command, re.I)), "terminal")


def on_post_tool_call(session_id="", turn_id="", tool_name="", tool_call_id="", args=None, duration_ms=None, status="", **_):
    key = _key(session_id, turn_id)
    ms = _number(duration_ms)
    with _lock:
        state = _active.get(key)
        if state is None:
            return
        state.tool_ms += ms or 0
        elapsed = round((time.monotonic() - state.started) * 1000)
    ended = time.time()
    category = "native_" + str((args or {}).get("action", "unknown")) if tool_name == "TencentPpt" else _category(tool_name, args)
    _emit(key, "tool", tool_call_id=tool_call_id, category=category,
          started_at=ended - ms / 1000 if ms is not None else None, ended_at=ended,
          duration_ms=ms, status=status, elapsed_ms=elapsed)


def checked(turn, *, pages, held):
    key = _key(turn.session_id, turn.turn_id)
    with _lock:
        state = _active.get(key)
        if state is None:
            return
        elapsed = round((time.monotonic() - state.started) * 1000)
    _emit(key, "check", pages=pages, held=held, elapsed_ms=elapsed)


def on_post_llm_call(session_id="", turn_id="", **_):
    key = _key(session_id, turn_id)
    with _lock:
        state = _active.pop(key, None)
    if state is not None:
        _emit(key, "end", wall_ms=round((time.monotonic() - state.started) * 1000),
              api_ms=round(state.api_ms, 2), tool_ms=round(state.tool_ms, 2),
              api_errors=state.errors, unfinished_attempts=len(state.attempts))
