"""Seed kits and experts from a directory of zips.

The directory is an argument. Nothing here names a machine path or a git
remote: the caller (or ``hermes kit seed <目录>``) decides where the archives
live. A zip is reinstalled only when its bytes changed. An empty directory,
or a zip that cannot be opened, does not remove anything already installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Collection, Dict, List, Optional

from . import installer, package, store


@dataclass
class SeedItem:
    status: str
    name: str = ""
    path: str = ""
    detail: str = ""

    def line(self) -> str:
        """一行中文结果，给 hermes kit seed 的输出用。"""
        label = {
            "empty": "没有包",
            "unchanged": "未变化",
            "installed": "已安装",
            "failed": "失败",
            "unreadable": "读不出来",
            "removed": "用户已卸载，不装回",
        }.get(self.status, self.status)
        head = self.name or self.path or ""
        text = f"{label}  {head}".rstrip()
        if self.detail and self.status != "installed":
            text = f"{text}  {self.detail}"
        return text


def iter_archives(directory: Path) -> List[Path]:
    """找出目录里的 zip：目录本身、plugins/ 下，或往下一层市场目录里，不再更深。

    支持的结构：<dir>/*.zip、<dir>/plugins/*.zip、<dir>/<市场>/plugins/*.zip、<dir>/plugins/<市场>/plugins/*.zip；同一个文件只算一次。
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
    """zip 放在 .../plugins/ 下时，取旁边的 .../avatars 作为头像目录；没有就返回 None。"""
    if archive.parent.name != "plugins":
        return None
    candidate = archive.parent.parent / "avatars"
    return candidate if candidate.is_dir() else None


def _identity(path: Path) -> tuple[str, str, str]:
    """解开包得到（名字、指纹、类型）；读不出来时抛 PackageError。"""
    with package.open_package(path) as (pristine, work, digest):
        plan = package.build_plan(pristine, work, digest)
        return plan.name, digest, plan.kind


def seed(
    home: Path,
    directory: Path,
    *,
    avatars_dir: Optional[Path] = None,
    generate_triggers: bool = True,
    triggers: Optional[Dict[str, Any]] = None,
    progress: Optional[Callable[[str, int, int], None]] = None,
    removed: Collection[str] = (),
) -> List[SeedItem]:
    """安装新的或字节变了的包，字节相同的不动，也从不卸载；命令按旧写法转换的包例外，重装一次。

    启用开关、.env 里的值、用户手改过的专家 SOUL.md 都按 installer.install 的规则保留。触发词默认用插件自带的已校验表，新账号装这些包不调模型。progress 在每装一个包前收到（名字, 已完成, 总数）。removed 里的包如果已经不在了就不再装回（用户卸载过）；还装着的照常更新。
    """
    archives = iter_archives(directory)
    if not archives:
        return [SeedItem("empty", detail="目录里没有 zip，已装的套件和专家保持原样")]
    if triggers is None:
        triggers = installer.bundled_triggers()
    index = store.load_index(home).get("plugins") or {}
    # A zip's digest is the hash of its bytes, so an installed one is known
    # without unpacking it — this keeps the check on every start under a second.
    # 命令按旧写法转换的不算「已装好」，要重装一次（installer.COMMAND_FORMAT）。
    installed = {str(entry["digest"]): name for name, entry in index.items()
                 if isinstance(entry, dict) and entry.get("digest") and installer.commands_current(entry)}
    items: List[SeedItem] = []
    identified: List[tuple[Path, str, str, str]] = []
    for archive in archives:
        known = installed.get(package._digest_file(archive)) if archive.suffix.lower() == ".zip" else None
        if known:
            items.append(SeedItem("unchanged", name=known, path=archive.name))
            continue
        try:
            identified.append((archive, *_identity(archive)))
        except package.PackageError as exc:
            items.append(SeedItem("unreadable", path=archive.name, detail=str(exc)))
    # Kits first: an expert copies its companion skills out of an installed kit
    # (股票研报专家 needs finance-research's westock-data), so a kit that sorts
    # after the expert would be missing when the expert is installed.
    identified.sort(key=lambda item: item[3] == "expert")

    def verdict(name: str, digest: str, kind: str) -> str:
        """决定一个包怎么处理：残包、没变化、用户卸载过不装回，还是要装。"""
        if kind == "broken":
            return "unreadable"
        previous = index.get(name)
        if isinstance(previous, dict) and previous.get("digest") == digest and installer.commands_current(previous):
            return "unchanged"
        if name in removed and not isinstance(previous, dict):
            return "removed"
        return "install"

    verdicts = [verdict(name, digest, kind) for _, name, digest, kind in identified]
    pending = verdicts.count("install")
    for (archive, name, digest, kind), decided in zip(identified, verdicts):
        if decided != "install":
            items.append(SeedItem(decided, name=name, path=archive.name, detail="残包" if kind == "broken" else ""))
            continue
        if progress is not None:
            progress(name, sum(1 for item in items if item.status in ("installed", "failed")), pending)
        portraits = avatars_dir if avatars_dir is not None else avatars_beside(archive)
        receipt = installer.install(
            archive,
            home,
            triggers=triggers,
            avatars_dir=portraits,
            generate_triggers=generate_triggers,
        )
        if receipt.ok:
            items.append(SeedItem("installed", name=receipt.plugin or name, path=archive.name))
            index = store.load_index(home).get("plugins") or index
        else:
            items.append(SeedItem("failed", name=name, path=archive.name, detail=receipt.error))
    return items
