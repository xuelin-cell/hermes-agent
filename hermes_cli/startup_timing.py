"""Startup stage timing for the backend process.

The stage log lines carry wall-clock timestamps, but nothing said how much of a
launch happened *before* the first one — that gap (interpreter start, imports,
plugin discovery) could only be guessed. These marks give every stage one
comparable number.

The baseline is captured at import time, so the earliest importer pulls this in
first (``hermes_cli/main.py``). Marks taken before logging is configured are
buffered and replayed by :func:`flush` once ``setup_logging`` has run —
otherwise the earliest marks would be dropped by a logger that has no handler
yet.
"""

import logging
import time
from typing import Any, Dict, List, Tuple

# Captured at import: the earliest point this process controls. Interpreter
# startup before it is measured through the process start time instead.
_BASELINE = time.monotonic()

_log = logging.getLogger("hermes_cli.startup")
_buffer: List[Tuple[float, str, Dict[str, Any]]] = []
_seen: set[str] = set()
_flushed = False


def _process_elapsed_s() -> float:
    """Seconds since this process started, or None when it cannot be determined."""
    try:
        import psutil

        return max(0.0, time.time() - psutil.Process().create_time())
    except Exception:
        return -1.0


def _format(stage: str, elapsed: float, fields: Dict[str, Any]) -> str:
    detail = "".join(f" {key}={value}" for key, value in fields.items())
    process_elapsed = _process_elapsed_s()
    if process_elapsed >= 0:
        return f"[startup] {stage} at +{process_elapsed:.2f}s since process start{detail}"

    return f"[startup] {stage} at +{elapsed:.2f}s since python start{detail}"


def mark(stage: str, **fields: Any) -> None:
    """Record one startup stage.

    Buffered until :func:`flush` so a mark taken before logging is configured is
    not lost.
    """
    elapsed = time.monotonic() - _BASELINE
    if _flushed:
        _log.info(_format(stage, elapsed, fields))

        return

    _buffer.append((elapsed, stage, fields))


def mark_once(stage: str, **fields: Any) -> None:
    """Record a stage only the first time it is reached in this process."""
    if stage in _seen:
        return

    _seen.add(stage)
    mark(stage, **fields)


def flush() -> None:
    """Replay the buffered marks through the logger (call after logging is up)."""
    global _flushed

    _flushed = True
    for elapsed, stage, fields in _buffer:
        _log.info(_format(stage, elapsed, fields))
    _buffer.clear()
