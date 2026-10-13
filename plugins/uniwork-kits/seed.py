"""Seed kits and experts from a directory of zips.

The directory is an argument. Nothing here names a machine path or a git
remote: the caller (or ``hermes kit seed <目录>``) decides where the archives
live. A zip is reinstalled only when its bytes changed. An empty directory,
or a zip that cannot be opened, does not remove anything already installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from . import installer, package, store


@dataclass
class SeedItem:
    status: str
    name: str = ""
    path: str = ""
    detail: str = ""

    def line(self) -> str:
        label = {
            "empty": "没有包",
            "unchanged": "未变化",
            "installed": "已安装",
            "failed": "失败",
            "unreadable": "读不出来",
        }.get(self.status, self.status)
        head = self.name or self.path or ""
        text = f"{label}  {head}".rstrip()
        if self.detail and self.status != "installed":
            text = f"{text}  {self.detail}"
        return text


def iter_archives(directory: Path) -> List[Path]:
    """Zips at the directory, under ``plugins/``, or one marketplace level down.

    Covered layouts, and nothing deeper:

    * ``<dir>/*.zip``
    * ``<dir>/plugins/*.zip``
    * ``<dir>/<marketplace>/plugins/*.zip``
    * ``<dir>/plugins/<marketplace>/plugins/*.zip``
    """
    directory = Path(directory)
    if not directory.is_dir():
        raise installer.KitError(f"不是目录：{directory}")
    patterns = ("*.zip", "plugins/*.zip", "*/plugins/*.zip", "plugins/*/plugins/*.zip")
    found: List[Path] = []
    seen: set[str] = set()
    for pattern in patterns:
        for path in sorted(directory.glob(pattern)):
            if not path.is_file():
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            found.append(path)
    return found


def avatars_beside(archive: Path) -> Optional[Path]:
    """``.../plugins/<name>.zip`` → ``.../avatars`` when that directory exists."""
    if archive.parent.name != "plugins":
        return None
    candidate = archive.parent.parent / "avatars"
    return candidate if candidate.is_dir() else None


def _identity(path: Path) -> tuple[str, str, str]:
    """``(name, digest, kind)`` of a package, or raise :class:`PackageError`."""
    with package.open_package(path) as (pristine, work, digest):
        plan = package.build_plan(pristine, work, digest)
        return plan.name, digest, plan.kind


def seed(
    home: Path,
    directory: Path,
    *,
    avatars_dir: Optional[Path] = None,
    generate_triggers: bool = True,
) -> List[SeedItem]:
    """Install new or changed archives. Same bytes are left alone.

    Enable flags, ``.env`` values, and a hand-edited expert ``SOUL.md`` stay
    as ``installer.install`` already keeps them. This function never uninstalls.
    """
    archives = iter_archives(directory)
    if not archives:
        return [SeedItem("empty", detail="目录里没有 zip，已装的套件和专家保持原样")]
    index = store.load_index(home).get("plugins") or {}
    items: List[SeedItem] = []
    for archive in archives:
        try:
            name, digest, kind = _identity(archive)
        except package.PackageError as exc:
            items.append(SeedItem("unreadable", path=archive.name, detail=str(exc)))
            continue
        if kind == "broken":
            items.append(SeedItem("unreadable", name=name, path=archive.name, detail="残包"))
            continue
        previous = index.get(name)
        if isinstance(previous, dict) and previous.get("digest") == digest:
            items.append(SeedItem("unchanged", name=name, path=archive.name))
            continue
        portraits = avatars_dir if avatars_dir is not None else avatars_beside(archive)
        receipt = installer.install(
            archive,
            home,
            triggers={},
            avatars_dir=portraits,
            generate_triggers=generate_triggers,
        )
        if receipt.ok:
            items.append(SeedItem("installed", name=receipt.plugin or name, path=archive.name))
            index = store.load_index(home).get("plugins") or index
        else:
            items.append(SeedItem("failed", name=name, path=archive.name, detail=receipt.error))
    return items
