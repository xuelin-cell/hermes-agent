"""Fetch the pinned PPT sidecar into the agent payload, outside Electron's asar."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from .uniwork_bundled import BUILDER_HOME_ENV, DEFAULT_SOURCE, _fetch

REVISION = "eb35691db1eaf5940648b4b989f1dc9575f9b221"
ARCHIVE_SHA256 = "b4918bc89341e64b1b2ddc754dccec0a679b863990bb4d41a68775dc8c047c17"
DISTRIBUTION = Path("runtimes/tencent-ppt/windows-x64")


def stage_native_ppt(repo_dir: Path, cache: Path, env: dict) -> bool:
    source = (env.get("UNIWORK_BUNDLED_PLUGINS") or "").strip()
    if os.name != "nt" or not source or source.lower() in {"off", "none", "0"}:
        return False
    from .native_prepared import preparation_lock

    checkout = cache.resolve() / "native-ppt" / REVISION
    checkout.parent.mkdir(parents=True, exist_ok=True)
    with preparation_lock(checkout):
        if not (checkout / DISTRIBUTION / "manifest.json").is_file():
            with tempfile.TemporaryDirectory(dir=checkout.parent, prefix="fetch-") as temp:
                fresh = Path(temp) / "source"
                _fetch(DEFAULT_SOURCE, REVISION, fresh, env.get(BUILDER_HOME_ENV, ""))
                fresh.rename(checkout)
        unpack_distribution(repo_dir, checkout / DISTRIBUTION, repo_dir / "tencent-ppt-runtime")
        # The clone's git metadata duplicates the whole distribution (~275 MB of
        # objects) and nothing downstream reads it: the shipped runtime is the
        # unpacked copy under tencent-ppt-runtime. Dropping it keeps the build
        # cache small enough for the 32-bit NSIS installer's 2 GiB payload.
        shutil.rmtree(checkout / ".git", ignore_errors=True)
    return True


def unpack_distribution(repo_dir: Path, distribution: Path, destination: Path) -> None:
    manifest = json.loads((distribution / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("archive_sha256") != ARCHIVE_SHA256:
        raise ValueError("Native PPT distribution differs from the pinned release")
    subprocess.run([
        sys.executable, str(repo_dir / "plugins/uniwork-kits/tencent_ppt_assets.py"),
        "unpack", "--distribution", str(distribution), "--destination", str(destination),
    ], check=True, timeout=300)
    (destination / "source.json").write_text(json.dumps({
        "revision": REVISION, "archive_sha256": ARCHIVE_SHA256,
    }, indent=2), encoding="utf-8")


def warm_material_wheels(repo_dir: Path, cache: Path, python: Path, env: dict | None) -> None:
    """A native PPT installer must carry its material worker's dependency graph."""
    if not (repo_dir / "tencent-ppt-runtime").is_dir():
        return
    import pm

    with tempfile.TemporaryDirectory(prefix="ppt-material-wheels-") as temp:
        project = Path(temp) / "project"
        project.mkdir()
        (project / "pyproject.toml").write_text(
            '[project]\nname="uniwork-native-ppt"\nversion="0"\nrequires-python=">=3.11"\n'
            'dependencies=["python-pptx==1.0.2", "Pillow>=11.3,<13"]\n'
            '[tool.uv]\npackage=false\n', encoding="utf-8")
        pm.build_environment(source=project, out=Path(temp) / "venv", python=python,
                             cache=cache, env=env, frozen=False, explicit=True, timeout=600)
