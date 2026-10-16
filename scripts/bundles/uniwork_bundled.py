"""desktop-mt: put the built-in kits and experts into the staged agent.

The packages live in the gitcode config repo (``plugins/uniwork-bundled/``),
where colleagues update them without touching this repository — the same
place 数字员工's installer takes them from. The agent is staged from a
``git archive`` of this repo, so they are copied in afterwards, next to the
plugin that installs them: ``plugins/uniwork-kits/bundled/uniwork-bundled/``.
On first start the backend seeds them into the account (``autoseed``).

Source, from the environment of the build:

* ``UNIWORK_BUNDLED_PLUGINS`` — a git URL, or a local directory: a checkout of
  the config repo, its ``plugins/`` or ``plugins/uniwork-bundled/``. Default:
  the gitcode repo. ``off`` builds without built-in kits.
* ``UNIWORK_BUNDLED_PLUGINS_REF`` — branch, tag or commit (default: the
  repository's default branch).

Like 数字员工, a source that cannot be fetched is a warning, not a failed
build; the log says which source was used and how many packages went in. Only
zips that open and carry a ``plugin.json`` are copied: a broken or LFS-pointer
zip is named in the log and left out.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

DEFAULT_SOURCE = "git@gitcode.com:uni-ai/uniclawwork-local-config.git"
TARGET = Path("plugins/uniwork-kits/bundled/uniwork-bundled")
MANIFEST_MAX_DEPTH = 2


def _bundle_root(source: Path) -> Path | None:
    for candidate in (source / "plugins" / "uniwork-bundled", source / "uniwork-bundled", source):
        if (candidate / "plugins").is_dir():
            return candidate
    return None


def usable(archive: Path) -> bool:
    """Whether the runtime can install *archive*: a real zip with a plugin.json near the top."""
    try:
        with zipfile.ZipFile(archive) as zf:
            return any(
                name.rsplit("/", 1)[-1] == "plugin.json" and name.count("/") <= MANIFEST_MAX_DEPTH
                for name in zf.namelist()
            )
    except (OSError, zipfile.BadZipFile):
        return False


FETCH_TIMEOUT_S = 300


def _fetch(url: str, ref: str, into: Path) -> None:
    # init + fetch works for a branch, a tag and a bare commit alike, all shallow.
    # Never prompt: a build machine (or a test) without gitcode credentials must
    # fail at once and build without the packages, not wait for input.
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_SSH_COMMAND": os.environ.get("GIT_SSH_COMMAND") or "ssh -o BatchMode=yes -o ConnectTimeout=20",
    }
    run = {"check": True, "env": env, "timeout": FETCH_TIMEOUT_S, "stdin": subprocess.DEVNULL}
    subprocess.run(["git", "init", "-q", str(into)], **run)
    subprocess.run(["git", "fetch", "-q", "--depth", "1", url, ref or "HEAD"], cwd=into, **run)
    subprocess.run(["git", "checkout", "-q", "FETCH_HEAD"], cwd=into, **run)


def stage_bundled_plugins(repo_dir: Path, env: dict[str, str] | None = None) -> int:
    """Copy the bundled packages into the staged *repo_dir*; return how many went in."""
    env = os.environ if env is None else env
    source = (env.get("UNIWORK_BUNDLED_PLUGINS") or DEFAULT_SOURCE).strip()
    if source.lower() == "off":
        print("==> Bundled plugins: off (UNIWORK_BUNDLED_PLUGINS=off)", flush=True)
        return 0
    ref = (env.get("UNIWORK_BUNDLED_PLUGINS_REF") or "").strip()
    with tempfile.TemporaryDirectory(prefix="uniwork-bundled-") as temp:
        local = Path(source)
        if not local.is_dir():
            local = Path(temp) / "config"
            try:
                _fetch(source, ref, local)
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                print(f"WARNING: could not fetch bundled plugins from {source} ({exc}); building without them",
                      flush=True)
                return 0
        bundle = _bundle_root(local)
        if bundle is None:
            print(f"WARNING: no plugins/uniwork-bundled under {source}; building without bundled plugins", flush=True)
            return 0
        archives = sorted((bundle / "plugins").glob("*.zip"))
        good = [archive for archive in archives if usable(archive)]
        for archive in archives:
            if archive not in good:
                print(f"WARNING: skipped bundled plugin {archive.name}: not a zip with a plugin.json", flush=True)
        target = repo_dir / TARGET
        if target.exists():
            shutil.rmtree(target)
        (target / "plugins").mkdir(parents=True)
        for archive in good:
            shutil.copy2(archive, target / "plugins" / archive.name)
        avatars = bundle / "avatars"
        if avatars.is_dir():
            shutil.copytree(avatars, target / "avatars")
    print(f"==> Bundled plugins source: {source}{'@' + ref if ref else ''} ({len(good)} plugin archive(s))", flush=True)
    if not good:
        print("WARNING: the build carries no bundled kits or experts", flush=True)
    return len(good)
