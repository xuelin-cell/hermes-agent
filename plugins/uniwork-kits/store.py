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


def root_home(home: Path) -> Path:
    """home 是某个专家档案时返回默认档案的 home，否则原样返回。

    套件统一在默认档案里管理、专家也从默认档案装；桌面把插件请求发给当前对话所在的档案，打开专家对话时请求会落到专家自己的 home，所以要先折回默认档案。
    """
    from hermes_constants import named_profile_home

    named = named_profile_home(home)
    return named.parent.parent if named is not None else home


def imported_root(home: Path) -> Path:
    """本插件在 home 里的数据目录（索引、原包副本、安装记录都在这里）。"""
    return home / IMPORTED_DIRNAME


def index_path(home: Path) -> Path:
    """已装套件和专家的索引文件位置。"""
    return imported_root(home) / "index.json"


def retained_dir(home: Path, plugin: str, version: str) -> Path:
    """某个包某个版本的原包副本目录，重装和对比时用。"""
    return imported_root(home) / plugin / version


def receipt_path(home: Path, plugin: str) -> Path:
    """某个包最近一次安装的文字记录（装了什么、跳过了什么）。"""
    return imported_root(home) / f"{plugin}.receipt.txt"


def kit_root(home: Path, plugin: str) -> Path:
    """套件技能放在 home/skills 下的哪个目录。"""
    return home / "skills" / KITS_DIRNAME / plugin


def load_index(home: Path) -> Dict[str, Any]:
    """读出 home 的索引；文件不存在或读不懂时返回空索引，不报错。"""
    try:
        data = json.loads(index_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict) or not isinstance(data.get("plugins"), dict):
        data = {"version": INDEX_VERSION, "plugins": {}}
    return data


def save_index(home: Path, data: Dict[str, Any]) -> None:
    """写回索引（原子写入），并带上当前索引版本号。"""
    from utils import atomic_json_write

    data["version"] = INDEX_VERSION
    imported_root(home).mkdir(parents=True, exist_ok=True)
    atomic_json_write(index_path(home), data)


def self_expert(index: Dict[str, Any]) -> tuple[str, Dict[str, Any]] | None:
    """这个 home 自己就是哪个专家（索引里 self 为 true 的那条）；普通档案返回 None。"""
    for name, entry in (index.get("plugins") or {}).items():
        if isinstance(entry, dict) and entry.get("kind") == "expert" and entry.get("self"):
            return name, entry
    return None


@contextmanager
def scoped_home(home: Path) -> Iterator[None]:
    """在 with 块里让 Hermes 的配置、环境变量读写临时指向 home，而不是当前进程默认的那个。"""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(home))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def is_within(parent: Path, child: Path) -> bool:
    """child 是否在 parent 目录里面（按真实路径判断，解析失败当作不在）。"""
    try:
        child.resolve().relative_to(parent.resolve())
    except (OSError, ValueError):
        return False
    return True


def safe_rmtree(path: Path, home: Path) -> bool:
    """只删除 home 里面真实存在的目录。

    符号链接只删链接本身，绝不顺着链接删到档案外面用户的文件。
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
