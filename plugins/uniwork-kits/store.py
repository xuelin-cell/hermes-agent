"""On-disk layout and the installer's own registry (``index.json``).

Every profile home that received a package carries::

    <home>/imported-plugins/index.json               this module's registry
    <home>/imported-plugins/<plugin>/<version>/      pristine package copy
    <home>/imported-plugins/<plugin>.receipt.txt     last install receipt
    <home>/skills/kits/<plugin>/                     package root documents
    <home>/skills/kits/<plugin>/skills/<skill>/      installed skills

Hermes core knows nothing about kits or experts; this registry is the only
record of which skills, MCP keys and env vars belong to which package, so
enable / disable / uninstall stay symmetric with install.
"""

from __future__ import annotations

import json
import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator

IMPORTED_DIRNAME = "imported-plugins"
KITS_DIRNAME = "kits"
INDEX_VERSION = 1


def imported_root(home: Path) -> Path:
    return home / IMPORTED_DIRNAME


def index_path(home: Path) -> Path:
    return imported_root(home) / "index.json"


def retained_dir(home: Path, plugin: str, version: str) -> Path:
    return imported_root(home) / plugin / version


def receipt_path(home: Path, plugin: str) -> Path:
    return imported_root(home) / f"{plugin}.receipt.txt"


def kit_root(home: Path, plugin: str) -> Path:
    return home / "skills" / KITS_DIRNAME / plugin


def load_index(home: Path) -> Dict[str, Any]:
    """The registry for *home*; an empty one when absent or unreadable."""
    try:
        data = json.loads(index_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict) or not isinstance(data.get("plugins"), dict):
        data = {"version": INDEX_VERSION, "plugins": {}}
    return data


def save_index(home: Path, data: Dict[str, Any]) -> None:
    from utils import atomic_json_write

    data["version"] = INDEX_VERSION
    imported_root(home).mkdir(parents=True, exist_ok=True)
    atomic_json_write(index_path(home), data)


def self_expert(index: Dict[str, Any]) -> tuple[str, Dict[str, Any]] | None:
    """The expert this home *is* (``self: true``), or ``None`` for a plain profile."""
    for name, entry in (index.get("plugins") or {}).items():
        if isinstance(entry, dict) and entry.get("kind") == "expert" and entry.get("self"):
            return name, entry
    return None


@contextmanager
def scoped_home(home: Path) -> Iterator[None]:
    """Run Hermes config / env helpers against *home* instead of the ambient one."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(home))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def is_within(parent: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
    except (OSError, ValueError):
        return False
    return True


def safe_rmtree(path: Path, home: Path) -> bool:
    """Remove *path* only when it is a real directory inside *home*.

    Symlinks are never followed: a link pointing outside the profile must not
    take the user's files with it.
    """
    if path.is_symlink():
        path.unlink()
        return True
    if not path.exists():
        return False
    if not is_within(home, path) or path.resolve() == home.resolve():
        raise RuntimeError(f"refusing to delete {path}: not inside {home}")
    shutil.rmtree(path)
    return True
