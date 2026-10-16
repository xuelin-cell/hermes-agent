"""前端依赖里不在 npm 仓库的包放进仓库（deploy/hermes-mt/vendor/npm/）。

部署机构建前端（scripts/build-frontend.sh）时 npm ci 走 npmmirror；锁文件里直接写外部网址的包
（xlsx 从 cdn.sheetjs.com 下）不经过 npm 仓库，部署机连那些站极慢或不通（实测 cdn.sheetjs.com 约 5KB/s）。
build-frontend.sh 装依赖前把仓库里的包放进 npm 缓存，npm ci 见到缓存里校验值对得上的包就不再下载。
上游再加这类依赖、或者换了版本，这里先报出来。
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VENDOR = REPO / "deploy" / "hermes-mt" / "vendor" / "npm"
REGISTRIES = ("https://registry.npmjs.org/", "https://registry.npmmirror.com/")


def _integrity(path: Path) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()


def _outside_registry() -> list[tuple[str, dict]]:
    lock = json.loads((REPO / "package-lock.json").read_text(encoding="utf-8"))
    return [
        (name, entry)
        for name, entry in lock["packages"].items()
        if entry.get("resolved", "").startswith("https://") and not entry["resolved"].startswith(REGISTRIES)
    ]


def test_every_dependency_outside_the_npm_registry_is_in_the_repository() -> None:
    vendored = {_integrity(path) for path in VENDOR.glob("*.tgz")}
    missing = [f"{name} {entry['resolved']}" for name, entry in _outside_registry() if entry.get("integrity") not in vendored]
    assert not missing, f"放进 {VENDOR.relative_to(REPO).as_posix()}/，校验值要和锁文件一致：{missing}"


def test_every_package_in_the_repository_is_still_locked() -> None:
    locked = {entry.get("integrity") for _, entry in _outside_registry()}
    stale = [path.name for path in VENDOR.glob("*.tgz") if _integrity(path) not in locked]
    assert not stale, f"锁文件里已经没有这些包，从仓库删掉：{stale}"


def test_the_frontend_build_caches_them_before_installing() -> None:
    script = (REPO / "deploy" / "hermes-mt" / "scripts" / "build-frontend.sh").read_text(encoding="utf-8")
    cache = script.index("npm cache add")
    assert "/workspace/deploy/hermes-mt/vendor/npm/" in script[max(0, cache - 200) : cache]
    assert cache < script.index("npm ci --workspace")
