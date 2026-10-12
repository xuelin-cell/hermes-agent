"""实例镜像里的 hermes 源码覆盖（deploy/hermes-mt/overlay/，见 Dockerfile.cube 与 deploy.sh::check_overlay）。

overlay/ 下的文件按原路径覆盖进镜像的 /opt/hermes，必须和仓库里同路径的文件逐字节相同，
否则镜像里跑的不是仓库里的代码。改了仓库里的文件忘了同步，这里先红，部署时 deploy.sh 也会停。
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OVERLAY = REPO / "deploy" / "hermes-mt" / "overlay"


def _overlay_files() -> list[Path]:
    return sorted(path.relative_to(OVERLAY) for path in OVERLAY.rglob("*") if path.is_file())


def test_overlay_ships_the_skill_market_backend() -> None:
    assert Path("hermes_cli/web_routers/skills.py") in _overlay_files()


def test_overlay_files_match_the_repository() -> None:
    for relative in _overlay_files():
        assert (OVERLAY / relative).read_bytes() == (REPO / relative).read_bytes(), (
            f"overlay/{relative.as_posix()} 与仓库里的 {relative.as_posix()} 不一致"
        )
