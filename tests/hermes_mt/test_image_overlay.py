"""覆盖进实例镜像 /opt/hermes 的仓库文件（deploy/hermes-mt/overlay.list，见 Dockerfile.cube 与 deploy.sh::overlay_files）。

清单里每一项是仓库里的路径（目录表示其下全部受版本管理的文件）。deploy.sh 构建前把它们原样拷进
.overlay/、构建后核对镜像里那份；这里核对清单本身：该进镜像的都在，列的路径在仓库里都有。
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy" / "hermes-mt"


def _entries() -> list[str]:
    lines = (DEPLOY / "overlay.list").read_text(encoding="utf-8").splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def test_overlay_ships_the_skill_market_backend_and_the_uniwork_skills() -> None:
    assert "hermes_cli/web_routers/skills.py" in _entries()
    assert "skills/uniwork" in _entries()


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
