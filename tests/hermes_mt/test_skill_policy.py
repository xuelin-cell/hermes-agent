"""平台的技能策略（deploy/hermes-mt/seed/skillpolicy.py）配上 hermes 真正的技能同步（tools/skills_sync.py）。

镜像里自带的技能 = 上游的一大套 + UniWork 的；策略只留 UniWork 的（和点名放的上游技能），其余写进 hermes 的
「不再补回」名单，删掉用户目录里没改过的副本。这里用一棵小的「自带技能」目录代替镜像里的，验 hermes 同步前后的样子。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SEED_DIR = REPO / "deploy" / "hermes-mt" / "seed"
if str(SEED_DIR) not in sys.path:
    sys.path.insert(0, str(SEED_DIR))

import skillpolicy  # noqa: E402
from tools import skills_sync  # noqa: E402

UNIWORK = {"keep_categories": ["uniwork"], "keep": []}


def _skill(root: Path, rel: str, name: str) -> None:
    folder = root / rel
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name} skill\n---\n\n{name}\n", encoding="utf-8")


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """一棵小的「自带技能」：UniWork 两个、上游三个（powerpoint 带脚本）、hermes 的必需技能。"""
    bundled = tmp_path / "bundled"
    _skill(bundled, "uniwork/doc", "doc")
    _skill(bundled, "uniwork/excel", "excel")
    _skill(bundled, "productivity/powerpoint", "powerpoint")
    (bundled / "productivity/powerpoint/scripts").mkdir()
    (bundled / "productivity/powerpoint/scripts/make.py").write_text("print('pptx')\n", encoding="utf-8")
    _skill(bundled, "productivity/docx", "docx")
    _skill(bundled, "creative/ascii-art", "ascii-art")
    _skill(bundled, "autonomous-ai-agents/hermes-agent", "hermes-agent")
    hermes_home = tmp_path / "home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(bundled))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return hermes_home


def _on_disk(home: Path) -> set[str]:
    return {path.parent.name for path in (home / "skills").rglob("SKILL.md")}


def _suppressed(home: Path) -> set[str]:
    path = home / "skills" / ".curator_suppressed"
    return set(path.read_text(encoding="utf-8").split()) if path.exists() else set()


def test_only_uniwork_and_the_essential_skill_stay(home: Path) -> None:
    # 容器启动时 hermes 已经同步过一遍（stage2 钩子），转发器之后才跑策略。
    skills_sync.sync_skills(quiet=True)
    assert _on_disk(home) == {"doc", "excel", "powerpoint", "docx", "ascii-art", "hermes-agent"}

    report = skillpolicy.apply(UNIWORK)

    assert report == {"suppressed": 3, "released": [], "removed": 3, "kept_modified": []}
    assert _on_disk(home) == {"doc", "excel", "hermes-agent"}
    assert _suppressed(home) == {"powerpoint", "docx", "ascii-art"}
    # hermes 启动时再同步一遍：名单里的不补回；策略再跑一遍什么也不变。
    skills_sync.sync_skills(quiet=True)
    assert _on_disk(home) == {"doc", "excel", "hermes-agent"}
    assert skillpolicy.apply(UNIWORK)["removed"] == 0


def test_a_profile_that_never_synced_never_gets_them(home: Path) -> None:
    assert skillpolicy.apply(UNIWORK)["removed"] == 0

    skills_sync.sync_skills(quiet=True)

    assert _on_disk(home) == {"doc", "excel", "hermes-agent"}


def test_what_the_user_changed_or_wrote_stays(home: Path) -> None:
    skills_sync.sync_skills(quiet=True)
    changed = home / "skills/productivity/docx/SKILL.md"
    changed.write_text(changed.read_text(encoding="utf-8") + "\n我的改动\n", encoding="utf-8")
    _skill(home / "skills", "productivity/cjk-slide-decks", "cjk-slide-decks")  # agent 自己写的（learned）

    report = skillpolicy.apply(UNIWORK)

    assert report["removed"] == 2 and report["kept_modified"] == ["docx"]
    assert _on_disk(home) == {"doc", "excel", "hermes-agent", "docx", "cjk-slide-decks"}
    skills_sync.sync_skills(quiet=True)
    assert _on_disk(home) == {"doc", "excel", "hermes-agent", "docx", "cjk-slide-decks"}


def test_named_upstream_skills_stay_and_opening_up_leaves_the_users_own_list_alone(home: Path) -> None:
    (home / "skills").mkdir()
    (home / "skills/.curator_suppressed").write_text("ascii-art\n", encoding="utf-8")  # 用户自己整理掉的
    skills_sync.sync_skills(quiet=True)
    assert "ascii-art" not in _on_disk(home)

    report = skillpolicy.apply({"keep_categories": ["uniwork"], "keep": ["powerpoint"]})

    assert report["suppressed"] == 2 and report["removed"] == 1  # docx 收起；ascii-art 本来就不在
    assert _on_disk(home) == {"doc", "excel", "hermes-agent", "powerpoint"}

    # 全放开：只撤平台加的 docx，用户自己整理掉的 ascii-art 还在名单里；hermes 下次同步把 docx 补回来。
    report = skillpolicy.apply({"all": True})

    assert report["released"] == ["docx"] and report["suppressed"] == 0
    assert _suppressed(home) == {"ascii-art"}
    skills_sync.sync_skills(quiet=True)
    assert _on_disk(home) == {"doc", "excel", "hermes-agent", "powerpoint", "docx"}


def test_runs_as_a_script_with_the_policy_on_stdin(home: Path) -> None:
    skills_sync.sync_skills(quiet=True)
    env = dict(os.environ, PYTHONPATH=str(REPO))
    script = [sys.executable, str(SEED_DIR / "skillpolicy.py")]

    done = subprocess.run(script, input=json.dumps(UNIWORK), capture_output=True, text=True, env=env, timeout=120)

    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1])["removed"] == 3
    assert _on_disk(home) == {"doc", "excel", "hermes-agent"}

    bad = subprocess.run(script, input="[1, 2]", capture_output=True, text=True, env=env, timeout=120)

    assert bad.returncode == 1 and "error" in json.loads(bad.stdout.strip().splitlines()[-1])
