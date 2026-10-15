"""实例镜像（deploy/hermes-mt/Dockerfile.cube）：覆盖进 /opt/hermes 的仓库文件和几条构建约束。

overlay.list 里每一项是仓库里的路径（目录表示其下全部受版本管理的文件）。deploy.sh 构建前把它们原样拷进
.overlay/、构建后核对镜像里那份；这里核对清单本身：列的路径在仓库里都有。基础镜像用本仓库构建，
清单现在是空的。
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy" / "hermes-mt"


def _entries() -> list[str]:
    lines = (DEPLOY / "overlay.list").read_text(encoding="utf-8").splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def _instructions() -> list[str]:
    """Dockerfile.cube 的指令，续行拼成一行，去掉注释。"""
    out: list[str] = []
    pending = ""
    for line in (DEPLOY / "Dockerfile.cube").read_text(encoding="utf-8").splitlines():
        if not pending and line.lstrip().startswith("#"):
            continue
        pending += line.rstrip("\\").strip() + " "
        if not line.endswith("\\"):
            out.append(pending.strip())
            pending = ""
    return [i for i in out if i]


def test_overlay_entries_exist_in_the_repository() -> None:
    for entry in _entries():
        path = REPO / entry
        assert path.is_file() or (path.is_dir() and any(p.is_file() for p in path.rglob("*"))), (
            f"overlay.list 里的 {entry} 在仓库里没有"
        )


def test_every_uniwork_skill_has_a_skill_md() -> None:
    skills = [p for p in (REPO / "skills" / "uniwork").iterdir() if p.is_dir()]
    assert skills
    for skill in skills:
        assert (skill / "SKILL.md").is_file(), f"skills/uniwork/{skill.name} 没有 SKILL.md，同步进用户目录后认不出来"


def test_the_image_copies_the_staged_overlay() -> None:
    dockerfile = (DEPLOY / "Dockerfile.cube").read_text(encoding="utf-8")
    assert "COPY .overlay/ /opt/hermes/" in dockerfile
    assert ".overlay/" in (DEPLOY / ".gitignore").read_text(encoding="utf-8").splitlines()


def test_playwright_install_keeps_the_pm_tools() -> None:
    """PLAYWRIGHT_BROWSERS_PATH 是 pm 的工具目录：playwright install 不带 PLAYWRIGHT_SKIP_BROWSER_GC=1
    会把 pm 的 Chromium 和 ffmpeg 当旧浏览器删掉（本机构建撞过）。"""
    commands = [c for i in _instructions() for c in re.split(r";|&&", i) if "playwright install" in c]
    assert commands
    for command in commands:
        assert "PLAYWRIGHT_SKIP_BROWSER_GC=1 " in command, command
