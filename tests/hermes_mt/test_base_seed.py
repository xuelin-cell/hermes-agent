"""基础镜像的预置（deploy/hermes-mt/scripts/base_seed.py）：Dockerfile 副本的插入点、各文件的备用来源。

部署机连 GitHub 极慢、连不上 Playwright 的 CDN，deploy.sh base 靠这个脚本先把大文件备好、再用它生成的
Dockerfile 副本构建。上游一改 Dockerfile 的结构，插入点就找不到——这里先报出来，不要等到部署时。
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "hermes-mt" / "scripts" / "base_seed.py"


def _module():
    spec = importlib.util.spec_from_file_location("base_seed", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_dockerfile_copy_adds_the_two_seed_copies_in_place() -> None:
    seed = _module()
    original = (REPO / "Dockerfile").read_text(encoding="utf-8")
    derived = seed.derive_dockerfile(original).splitlines()

    # 只多了说明行、两行 COPY 和每个 Debian 阶段的换源段，其余逐行不变
    mirror = "".join(seed.APT_MIRROR_LINES).splitlines()
    added = [line for line in derived if line not in original.splitlines()]
    assert added == [derived[0], *mirror, *mirror, "COPY --from=seed s6/ /tmp/s6-seed/", "COPY --from=seed pm/ /opt/hermes/tools/"]
    # s6 的包要在下载它们的那段 RUN 之前就位；pm 的要在 ensure 之前
    s6_copy = derived.index("COPY --from=seed s6/ /tmp/s6-seed/")
    pm_copy = derived.index("COPY --from=seed pm/ /opt/hermes/tools/")
    s6_run = next(i for i, line in enumerate(derived) if "s6-overlay-noarch.tar.xz" in line)
    ensure = next(i for i, line in enumerate(derived) if "from pm import ensure" in line)
    assert s6_copy < s6_run and pm_copy < ensure
    # 构建时 S6_OVERLAY_BASE_URL 换成 file:///tmp/s6-seed，下载那段按 ${base}/<文件名> 取
    assert re.search(r'base="\$\{S6_OVERLAY_BASE_URL\}/v\$\{S6_OVERLAY_VERSION\}"', original)


def test_every_debian_stage_switches_the_apt_mirror_before_its_first_apt_get() -> None:
    seed = _module()
    original = (REPO / "Dockerfile").read_text(encoding="utf-8")
    derived = seed.derive_dockerfile(original).splitlines()
    stages = [i for i, line in enumerate(derived) if line.startswith("FROM ")]
    debian = [i for i in stages if derived[i].startswith(seed.DEBIAN_FROM)]
    assert len(debian) == 2  # sqlite_build、runtime_base；其余阶段都从它们派生，继承换好的源
    for start in debian:
        end = next((i for i in stages if i > start), len(derived))
        apt = next(i for i in range(start, end) if "apt-get" in derived[i] and "update" in derived[i])
        switch = next(i for i in range(start, end) if "s|deb.debian.org|${APT_MIRROR}|g" in derived[i])
        assert derived[start + 1] == "ARG APT_MIRROR=mirrors.aliyun.com" and switch < apt


def test_a_dockerfile_without_the_insertion_points_is_refused() -> None:
    seed = _module()
    original = (REPO / "Dockerfile").read_text(encoding="utf-8")
    with pytest.raises(ValueError):
        seed.derive_dockerfile(original.replace("COPY scripts/bundles/payload.py scripts/bundles/payload.py\n", ""))


def test_every_seeded_pm_package_is_pinned_for_linux_x64() -> None:
    seed = _module()
    lock = json.loads((REPO / "pm" / "lock.json").read_text(encoding="utf-8"))
    for name in seed.PM_PACKAGES:
        artifacts = lock["packages"][name]["artifacts"]
        art = artifacts.get("linux-x64") or artifacts.get("any")
        assert art and re.fullmatch(r"[0-9a-f]{64}", art["sha256"]), name


def test_the_repository_carries_the_s6_overlay_packages_the_dockerfile_pins() -> None:
    """部署机连不上 GitHub，s6-overlay 的三个包放在仓库里。上游一升版本，这里先报出来。"""
    seed = _module()
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    version = re.search(r"^ARG S6_OVERLAY_VERSION=(\S+)$", dockerfile, re.M).group(1)
    vendor = REPO / "deploy" / "hermes-mt" / "vendor" / "s6-overlay" / f"v{version}"
    for filename, key in seed.S6_FILES:
        pinned = re.search(rf"^ARG {key}=([0-9a-f]{{64}})$", dockerfile, re.M).group(1)
        path = vendor / filename
        assert path.is_file(), f"仓库里没有 {path.relative_to(REPO)}"
        assert seed.sha256_of(str(path)) == pinned, filename


def test_npmmirror_holds_the_same_paths_for_the_mirrored_hosts() -> None:
    seed = _module()
    assert seed.npmmirror("https://nodejs.org/dist/v26.7.0/node-v26.7.0-linux-x64.tar.xz") == (
        "https://cdn.npmmirror.com/binaries/node/v26.7.0/node-v26.7.0-linux-x64.tar.xz"
    )
    assert seed.npmmirror("https://cdn.playwright.dev/builds/cft/145.0.7632.6/linux64/chrome-linux64.zip") == (
        "https://cdn.npmmirror.com/binaries/chrome-for-testing/145.0.7632.6/linux64/chrome-linux64.zip"
    )
    assert seed.npmmirror("https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/x.tar.gz") is None
