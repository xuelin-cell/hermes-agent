"""Ephemeral client capabilities follow an accepted turn, never its prompt/history."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from threading import RLock

_current = ContextVar('execution_metadata', default=None)
_active: dict[str, tuple[str, dict]] = {}
_completed: dict[tuple[str, str], float] = {}
_lock = RLock()


def current_metadata() -> dict:
    from hermes_constants import get_hermes_home
    value = _current.get()
    return dict(value[0]) if value and value[1] == str(get_hermes_home().resolve()) else {}


def active_for(capability: str, session_id: str) -> bool:
    with _lock:
        return any(sid == session_id and capability in metadata.values() for sid, metadata in _active.values())


def completed_for(capability: str, session_id: str) -> bool:
    import time
    with _lock:
        return _completed.get((capability, session_id), 0) > time.monotonic()


@contextmanager
def execution_scope(metadata: dict | None, session_id: str, home: str | None = None):
    import secrets
    from pathlib import Path
    from hermes_constants import get_hermes_home
    values = dict(metadata or {})
    identity = secrets.token_hex(16)
    with _lock:
        if values:
            _active[identity] = (session_id, values)
    token = _current.set((values, str(Path(home).resolve() if home else get_hermes_home().resolve())))
    try:
        yield
    finally:
        _current.reset(token)
        with _lock:
            _active.pop(identity, None)
            # A fast turn can finish between two control-channel polls. Keep a bounded
            # completion tombstone so it cannot look like a never-started authorization.
            import time
            for value in values.values():
                _completed[(value, session_id)] = time.monotonic() + 900
            while len(_completed) > 1024:
                _completed.pop(next(iter(_completed)))
