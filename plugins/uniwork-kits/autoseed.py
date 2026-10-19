"""Install the bundled kits and experts into an account by itself.

The desktop installer carries the packages 数字员工 keeps in the gitcode
config repo (``plugins/uniwork-bundled/``): the build copies that directory to
``bundled/`` next to this module. When the backend starts, the packages are
seeded into the default profile's home the same way ``hermes kit seed`` does
it — a new account gets every kit and expert once (about 20 s for 39
packages, no model calls thanks to the shipped trigger table), later starts
only compare fingerprints, and an app update reinstalls just the packages whose
bytes changed. Uninstalling stays a user action: nothing here removes a
package, and one the user uninstalled is not put back — ``.bundled-seeded.json``
remembers which built-ins this account has already had.

It runs on a background thread so the backend answers at once, once per
process, and only in the default profile's own backend (an expert's backend
loads the plugin API too, and skips). A lock file still keeps two processes —
say two app windows, or a CLI seed — from installing at the same time.

A developer checkout without ``bundled/`` can point at a directory with
``uniwork_kits.bundled_dir`` in the default profile's ``config.yaml``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from . import store

logger = logging.getLogger(__name__)

BUNDLED_DIR = Path(__file__).with_name("bundled")
LOCK_NAME = ".seed.lock"
SEEDED_NAME = ".bundled-seeded.json"
STALE_LOCK_S = 15 * 60

_lock = threading.Lock()
_started: set[str] = set()
_thread: Optional[threading.Thread] = None
_state: Dict[str, Any] = {
    "ran": False, "running": False, "name": "", "done": 0, "total": 0,
    "installed": 0, "unchanged": 0, "failed": [], "error": "",
}


def bundled_dir(home: Path) -> Optional[Path]:
    """Where the bundled packages are: the configured directory, else ``bundled/``."""
    try:
        with store.scoped_home(home):
            from hermes_cli.config import load_config_readonly

            section = (load_config_readonly() or {}).get("uniwork_kits") or {}
        configured = str(section.get("bundled_dir") or "").strip() if isinstance(section, dict) else ""
    except Exception:
        configured = ""
    if configured:
        path = Path(os.path.expandvars(os.path.expanduser(configured)))
        return path if path.is_dir() else None
    return BUNDLED_DIR if BUNDLED_DIR.is_dir() else None


def status() -> Dict[str, Any]:
    """What the kits page shows while the bundled packages go in."""
    with _lock:
        return {**_state, "failed": list(_state["failed"])}


def start(home: Path) -> bool:
    """Seed the bundled packages into *home*'s default profile on a background thread.

    Returns whether a run was started. Nothing happens in an expert's own
    backend (*home* is a named profile), without a bundled directory, or when
    this process already ran for that home.
    """
    root = store.root_home(Path(home))
    if root.resolve() != Path(home).resolve():
        return False
    key = str(root.resolve())
    directory = bundled_dir(root)
    global _thread
    with _lock:
        if directory is None or key in _started:
            return False
        _started.add(key)
        # Running from the moment it is started, so the first status poll
        # cannot read "idle" before the thread gets going.
        _state.update(ran=True, running=True, name="", done=0, total=0, installed=0, unchanged=0, failed=[], error="")
        _thread = threading.Thread(target=_run, args=(root, directory), name="uniwork-kits-seed", daemon=True)
    _thread.start()
    return True


def _set(**changes: Any) -> None:
    with _lock:
        _state.update(changes)


def _run(root: Path, directory: Path) -> None:
    lock = store.imported_root(root) / LOCK_NAME
    if not _acquire(lock):
        logger.info("[uniwork-kits] another backend is installing the bundled kits; skipped")
        _set(running=False)
        return
    try:
        from . import seed

        def progress(name: str, done: int, total: int) -> None:
            _set(name=name, done=done, total=total)

        record = store.imported_root(root) / SEEDED_NAME
        seeded = _load_seeded(record)
        present = set(store.load_index(root).get("plugins") or {})
        items = seed.seed(root, directory, progress=progress, removed=seeded - present)
        _save_seeded(record, seeded | {item.name for item in items if item.name and item.status in ("installed", "unchanged")})
        installed = [item.name for item in items if item.status == "installed"]
        failed = [f"{item.name or item.path}：{item.detail}" for item in items if item.status in ("failed", "unreadable")]
        unchanged = sum(1 for item in items if item.status == "unchanged")
        _set(installed=len(installed), unchanged=unchanged, failed=failed, done=len(installed) + len(failed))
        if installed or failed:
            logger.info("[uniwork-kits] bundled kits: %d installed, %d failed", len(installed), len(failed))
        for line in failed:
            logger.warning("[uniwork-kits] bundled package not installed: %s", line)
    except Exception as exc:  # the backend keeps running; the page shows the error
        logger.warning("[uniwork-kits] installing the bundled kits failed", exc_info=True)
        _set(error=str(exc))
    finally:
        _set(running=False, name="")
        _release(lock)


def _load_seeded(record: Path) -> set[str]:
    try:
        names = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    return {str(name) for name in names} if isinstance(names, list) else set()


def _save_seeded(record: Path, names: set[str]) -> None:
    temp = record.with_suffix(".tmp")
    temp.write_text(json.dumps(sorted(names), ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(temp, record)


def _acquire(lock: Path) -> bool:
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        if time.time() - lock.stat().st_mtime > STALE_LOCK_S:
            lock.unlink()  # a backend that died mid-install
    except OSError:
        pass
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"pid": os.getpid(), "at": time.time()}, fh)
    return True


def _release(lock: Path) -> None:
    try:
        lock.unlink()
    except OSError:
        pass
