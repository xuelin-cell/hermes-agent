"""GitCode controls the offline distribution, independently of local defaults."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from scripts.bundles.uniwork_bundled import TARGET
from scripts.bundles.uniwork_bundled_skills import (
    ESSENTIAL, MARKER, RECORD, SOURCE_ENV, REF_ENV, REQUIRED_ENV,
    BundledSkillsError, stage_bundled_skills, verify_bundled_skills,
)


def skill(root, name):
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: Test {name}\n---\n# {name}\n", encoding="utf-8")
    (root / "scripts").mkdir(exist_ok=True)
    (root / "scripts" / "run.py").write_text("print('resource')\n", encoding="utf-8")


def git(root, *args):
    return subprocess.check_output(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
         "-c", "commit.gpgsign=false", *args], cwd=root, text=True).strip()


def snapshot(root):
    skill(root / "skills" / ESSENTIAL, "hermes-agent")
    skill(root / "skills/uniwork/local-only", "local-only")
    return root


def test_pinned_gitcode_tree_drives_offline_install_and_safe_upgrade(tmp_path, monkeypatch):
    """Real Git fetch, complete resources, profile isolation, upgrade and repeat sync."""
    from tools.skills_sync import sync_skills

    config = tmp_path / "config"
    names = {"dws", "lark-unified", "video-frames", "video-source-search"}
    for name in names:
        skill(config / "skills/public" / name, name)
    git(config, "init", "-q")
    git(config, "add", ".")
    git(config, "commit", "-qm", "release skills")
    commit = git(config, "rev-parse", "HEAD")
    # A later HEAD and dirty checkout must not affect a pinned release.
    skill(config / "skills/public/later", "later")
    git(config, "add", ".")
    git(config, "commit", "-qm", "later")
    stage = snapshot(tmp_path / "stage")
    plugin_record = stage / TARGET / "source.json"
    plugin_record.parent.mkdir(parents=True)
    plugin_record.write_text(json.dumps({"source": config.as_uri(), "commit": commit}))
    env = {SOURCE_ENV: config.as_uri(), REQUIRED_ENV: "1"}
    assert stage_bundled_skills(stage, env) == len(names)
    record = verify_bundled_skills(stage / "skills")
    assert set(record["skills"]) == names and record["commit"] == commit
    assert (config / "skills/public/later").is_dir()
    assert not (stage / "skills/uniwork/local-only").exists()
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(stage / "skills"))
    monkeypatch.setenv("HERMES_OPTIONAL_SKILLS", str(tmp_path / "optional"))
    homes = [tmp_path / "home-a", tmp_path / "home-b"]
    for home in homes:
        monkeypatch.setenv("HERMES_HOME", str(home))
        if home == homes[0]:
            # Seed an older distribution, then install the new offline payload.
            old = snapshot(tmp_path / "old") / "skills"
            for name in names | {"modified-old", "hub-old"} | {f"legacy-{n}" for n in range(11)}:
                skill(old / "uniwork" / name, name)
            (old / MARKER).touch()
            monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(old))
            sync_skills(quiet=True)
            installed = home / "skills/uniwork"
            (installed / "modified-old/SKILL.md").write_text("User changes", encoding="utf-8")
            (installed / "dws/SKILL.md").write_text("User dws", encoding="utf-8")
            hub = home / "skills/.hub"
            hub.mkdir(exist_ok=True)
            (hub / "lock.json").write_text(json.dumps({"installed": {
                "hub-old": {"install_path": "uniwork/hub-old"}}}), encoding="utf-8")
            monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(stage / "skills"))
        result = sync_skills(quiet=True)
        if home == homes[0]:
            assert "local-only" in result["retired_pristine"]
            assert "modified-old" in result["retired_modified"]
            assert (home / "skills/.retired-hermes/modified-old/SKILL.md").read_text() == "User changes"
            assert (home / "skills/uniwork/hub-old/SKILL.md").is_file()
            assert (home / "skills/uniwork/dws/SKILL.md").read_text() == "User dws"
        else:
            assert set(result["copied"]) == names | {"hermes-agent"}
        for name in names:
            assert (home / "skills/uniwork" / name / "scripts/run.py").read_bytes() == (
                stage / "skills/uniwork" / name / "scripts/run.py").read_bytes()
        shutil.rmtree(home / "skills/uniwork/video-frames")
        assert not sync_skills(quiet=True)["copied"]
        assert not (home / "skills/uniwork/video-frames").exists()
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    assert not sync_skills(quiet=True)["copied"]
    assert not (homes[0] / "skills/uniwork/local-only").exists()
    # Exercise the actual assembler: all three native targets share this path.
    from scripts.build.agent import assemble
    from scripts.build.inputs import AgentInputs
    (stage / "pyproject.toml").write_text(
        '[project]\nname="skill-payload-test"\nversion="1.0"\n[project.scripts]\n', encoding="utf-8")
    out = tmp_path / "assembled"
    site = out / "venv/site-packages"
    site.mkdir(parents=True)
    python = out / "python"
    python.touch()
    pm = out / "pm-runtime"
    pm.mkdir()
    (pm / "pm-runtime.json").write_text(json.dumps({"python": "../python", "sitePackages": "."}))
    inputs = AgentInputs(project=stage / "pyproject.toml", code=stage, repo="agent",
                         placement="contained", target="win32-x64", python=python,
                         site_packages=site, environment=site.parent, pm_runtime=pm,
                         resources={"skills": stage / "skills"})
    assemble(inputs, out)
    assert verify_bundled_skills(out / "agent/skills", record) == record
    # A later resource override must not replace GitCode with local skills.
    inputs.resources["skills"] = tmp_path / "old/skills"
    with pytest.raises(FileNotFoundError):
        assemble(inputs, out)
    assert not (out / "manifest.json").exists()
    # Final payload checks catch both extra skills and changed resource bytes.
    payload = tmp_path / "payload"
    shutil.copytree(stage / "skills", payload)
    verify_bundled_skills(payload, record)
    (payload / "uniwork/dws/scripts/run.py").write_text("changed", encoding="utf-8")
    with pytest.raises(BundledSkillsError, match="inventory"):
        verify_bundled_skills(payload, record)


@pytest.mark.parametrize("invalid", ["missing", "empty", "metadata", "reserved", "drift", "off", "unconfigured", "worktree", "git-link", "unreachable"])
def test_invalid_sources_abort_without_using_or_modifying_local_skills(tmp_path, invalid):
    stage = snapshot(tmp_path / "stage")
    before = (stage / "skills/uniwork/local-only/SKILL.md").read_bytes()
    source = tmp_path / "config"
    (source / "skills/public").mkdir(parents=True)
    env = {SOURCE_ENV: str(source)}
    if invalid == "missing":
        shutil.rmtree(source / "skills/public")
    elif invalid == "metadata":
        skill(source / "skills/public/wrong", "other")
    elif invalid == "reserved":
        skill(source / "skills/public/hermes-agent", "hermes-agent")
    elif invalid == "drift":
        skill(source / "skills/public/valid", "valid")
        record = stage / TARGET / "source.json"
        record.parent.mkdir(parents=True)
        record.write_text(json.dumps({"source": "other", "commit": "a" * 40}))
    elif invalid == "off":
        env = {SOURCE_ENV: "off", REQUIRED_ENV: "1"}
    elif invalid == "unconfigured":
        env = {REQUIRED_ENV: "1"}
    elif invalid == "worktree":
        (stage / ".git").mkdir()
    elif invalid == "git-link":
        git(source, "init", "-q")
        (source / "link-target").write_text("../../outside", encoding="utf-8")
        blob = git(source, "hash-object", "-w", "link-target")
        git(source, "update-index", "--add", "--cacheinfo", f"120000,{blob},skills/public/link")
        git(source, "commit", "-qm", "symlink")
        env = {SOURCE_ENV: source.as_uri(), REF_ENV: "HEAD", REQUIRED_ENV: "1"}
    elif invalid == "unreachable":
        env = {SOURCE_ENV: (tmp_path / "nonexistent").as_uri(), REQUIRED_ENV: "1"}
    with pytest.raises((BundledSkillsError, FileNotFoundError, subprocess.CalledProcessError)):
        stage_bundled_skills(stage, env)
    assert (stage / "skills/uniwork/local-only/SKILL.md").read_bytes() == before
    assert not (stage / "skills" / RECORD).exists()
