"""desktop-mt: put the built-in kits and experts into the staged agent.

The packages live in the gitcode config repo (``plugins/uniwork-bundled/``),
where colleagues update them without touching this repository — the same
place 数字员工's installer takes them from. The agent is staged from a
``git archive`` of this repo, so they are copied in afterwards, next to the
plugin that installs them: ``plugins/uniwork-kits/bundled/uniwork-bundled/``.
On first start the backend seeds them into the account (``autoseed``).

Source, from the environment of the build:

* ``UNIWORK_BUNDLED_PLUGINS`` — a git URL, or a local directory: a checkout of
  the config repo, its ``plugins/`` or ``plugins/uniwork-bundled/``. The desktop
  build's identity environment (``desktop_inputs.identity_environment``) sets
  the gitcode repo unless the builder chose another source; ``off`` builds
  without built-in kits. Unset — ``prepare_native`` called on its own, as the
  packaging tests do — stages nothing and goes to no network.
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
# 套件和专家脚本的依赖清单，插件运行时（script_python.py）读的是同一份。
SCRIPT_REQUIREMENTS = Path("plugins/uniwork-kits/script-requirements.txt")
MANIFEST_MAX_DEPTH = 2


def _bundle_root(source: Path) -> Path | None:
    """在配置仓库、它的 plugins/ 或 plugins/uniwork-bundled/ 里找到放 zip 的那一层。"""
    for candidate in (source / "plugins" / "uniwork-bundled", source / "uniwork-bundled", source):
        if (candidate / "plugins").is_dir():
            return candidate
    return None


def usable(archive: Path) -> bool:
    """这个 zip 运行时能不能装：能打开，并且前两层里有 plugin.json。"""
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
    """浅拉取配置仓库的一个分支、标签或提交到 *into*。

    绝不等输入：没有 gitcode 权限的打包机器要立刻失败、不带内置包继续打包，而不是卡住。
    """
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
    """把内置套件和专家拷进打包目录 *repo_dir*，返回拷了几个包。"""
    env = os.environ if env is None else env
    source = (env.get("UNIWORK_BUNDLED_PLUGINS") or "").strip()
    if not source or source.lower() == "off":
        print(f"==> Bundled plugins: {'off' if source else 'not configured'} (UNIWORK_BUNDLED_PLUGINS)", flush=True)
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


def script_requirements(repo_dir: Path) -> list[str]:
    """读打包目录里插件的脚本依赖清单，去掉空行和注释；没有清单时返回空列表。"""
    path = repo_dir / SCRIPT_REQUIREMENTS
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]


def warm_script_wheels(repo_dir: Path, cache: Path, python: Path, env: dict[str, str]) -> int:
    """把套件脚本依赖的安装包放进将随安装包发出的 uv 缓存，返回依赖条数。

    安装版在每个账号里用 pm.ensure_environment 建脚本环境；缓存里有这些安装包，就只需查一下版本信息，
    不用下载大文件。做法是用打包机器上同一个 PM 在临时目录建一次同样的环境，建完删掉，只留下缓存。
    要在核心依赖裁剪（prune_uv_cache_to_lock）之后调用，否则会被当成锁文件以外的包删掉。
    建不成只打警告：安装版联网时照样能装，只是第一次要下载。
    """
    requirements = script_requirements(repo_dir)
    if not requirements:
        return 0
    if not (repo_dir / TARGET / "plugins").is_dir():
        # 这次没带内置套件（来源是 off 或没配置），也就没有要跑的脚本，安装包不必多带这些库。
        print("==> Kit script dependencies: skipped (the build carries no bundled kits)", flush=True)
        return 0
    import json

    import pm

    try:
        with tempfile.TemporaryDirectory(prefix="uniwork-scripts-") as temp:
            project = Path(temp) / "project"
            project.mkdir()
            lines = [
                "[project]",
                'name = "uniwork-kits-scripts"',
                'version = "0"',
                'requires-python = ">=3.11"',
                f"dependencies = {json.dumps(requirements)}",
                "[tool.uv]",
                "package = false",
            ]
            (project / "pyproject.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
            pm.build_environment(source=project, out=Path(temp) / "venv", python=python, cache=cache, env=env,
                                 frozen=False, explicit=True, timeout=30 * 60)
    except (pm.InstallError, OSError) as exc:
        print(f"WARNING: could not cache the kit script dependencies ({exc}); installs will download them", flush=True)
        return 0
    print(f"==> Kit script dependencies cached for offline installs ({len(requirements)} requirement(s))", flush=True)
    return len(requirements)
