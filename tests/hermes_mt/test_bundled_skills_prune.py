"""云端镜像按 seed/bundled-skills.list 收窄 UniWork 预制技能（对齐 UniClaw 生产只留 4 个）。

收窄只发生在镜像里；用户目录由 hermes 自己的 sync_skills 跟上，这里走真实的同步代码验证整条链。
"""

import importlib.util
from pathlib import Path

import pytest

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"
REPO_SKILLS = Path(__file__).resolve().parents[2] / "skills" / "uniwork"


def _prune_module():
    spec = importlib.util.spec_from_file_location("prune_bundled_skills_under_test", SEED_DIR / "prune_bundled_skills.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _skill(root: Path, name: str) -> None:
    (root / name).mkdir(parents=True)
    (root / name / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name}\n---\n\n{name}\n", encoding="utf-8")


def _installed(home: Path, name: str) -> Path | None:
    hits = [p.parent for p in (home / "skills").rglob("SKILL.md")
            if p.parent.name == name and ".retired-hermes" not in p.parts]
    return hits[0] if hits else None


def test_image_with_kits_narrows_skills_and_user_copies_follow(tmp_path, monkeypatch):
    from tools.skills_sync import sync_skills

    prune = _prune_module()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    bundled = tmp_path / "image-skills"
    (bundled / "uniwork").mkdir(parents=True)
    (bundled / "UNIWORK_BUNDLED_ONLY").write_text("enabled", encoding="utf-8")
    for name in ("keep-me", "drop-pristine", "drop-edited"):
        _skill(bundled / "uniwork", name)
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(bundled))
    no_kits, kits = tmp_path / "no-kits", tmp_path / "kits"
    kits.mkdir()
    (kits / "docx.zip").write_bytes(b"zip")

    sync_skills(quiet=True)
    edited = _installed(home, "drop-edited")
    (edited / "SKILL.md").write_text("---\nname: drop-edited\ndescription: mine\n---\n\nmine\n", encoding="utf-8")

    # 没带套件：一个都不动，办公类能力还要靠这些技能
    assert prune.prune(bundled / "uniwork", ["keep-me"], no_kits) == (["drop-edited", "drop-pristine", "keep-me"], [])
    # 带了套件：只留清单里的
    assert prune.prune(bundled / "uniwork", ["keep-me"], kits) == (["keep-me"], ["drop-edited", "drop-pristine"])

    sync_skills(quiet=True)
    assert _installed(home, "keep-me") is not None
    assert _installed(home, "drop-pristine") is None
    assert _installed(home, "drop-edited") is None
    assert "mine" in (home / "skills" / ".retired-hermes" / "drop-edited" / "SKILL.md").read_text(encoding="utf-8")

    # 回退：加回镜像的技能会重新装上，不被当成用户删掉的
    _skill(bundled / "uniwork", "drop-pristine")
    sync_skills(quiet=True)
    assert _installed(home, "drop-pristine") is not None


def test_listed_skills_exist_in_the_repo_and_an_unknown_name_fails_the_build(tmp_path):
    prune = _prune_module()
    listed = prune.read_list(SEED_DIR / "bundled-skills.list")
    assert listed and set(listed) <= {p.name for p in REPO_SKILLS.iterdir() if p.is_dir()}

    skills, kits = tmp_path / "uniwork", tmp_path / "kits"
    _skill(skills, "dws")
    _skill(skills, "other")
    kits.mkdir()
    (kits / "pdf.zip").write_bytes(b"zip")
    with pytest.raises(ValueError, match="not-there"):
        prune.prune(skills, ["dws", "not-there"], kits)
    assert sorted(p.name for p in skills.iterdir()) == ["dws", "other"]
