"""Authoritative UniWork bundled-skill convergence against old account homes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.bundles.uniwork_bundled_skills import _files
from tools import skills_sync
from tools import skills_sync_uniwork


NAMES = {"dws", "lark-unified", "video-frames", "video-source-search"}
ESSENTIAL = "autonomous-ai-agents/hermes-agent"
RECORD = ".bundled-source.json"


def sync(package: Path) -> dict:
    return skills_sync_uniwork.sync_uniwork_skills(package, quiet=True)


def write_skill(root: Path, relative: str, name: str | None = None) -> Path:
    path = root / relative
    path.mkdir(parents=True, exist_ok=True)
    (path / "SKILL.md").write_text(
        f"---\nname: {name or path.name}\ndescription: Test {name or path.name}\n---\n# {name or path.name}\n",
        encoding="utf-8",
    )
    (path / "scripts").mkdir(exist_ok=True)
    (path / "scripts" / "run.py").write_text(f"VALUE = {name or path.name!r}\n", encoding="utf-8")
    return path


def write_record(bundle: Path, *, names: set[str] | None = None, marker: bool = True) -> dict:
    ordinary = NAMES if names is None else names
    if marker:
        (bundle / "UNIWORK_BUNDLED_ONLY").write_text("GitCode distribution\n", encoding="utf-8")
    files = _files(bundle)
    files.pop(RECORD, None)
    record = {
        "source": "fixture",
        "ref": "release",
        "commit": "a" * 40,
        "skills": sorted(ordinary),
        "files": files,
    }
    (bundle / RECORD).write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def bundle(root: Path, names: set[str] | None = None) -> Path:
    root.mkdir(parents=True)
    write_skill(root, ESSENTIAL, "hermes-agent")
    for name in NAMES if names is None else names:
        write_skill(root, f"uniwork/{name}", name)
    write_record(root, names=names)
    return root


@pytest.fixture
def homes(tmp_path, monkeypatch):
    target = tmp_path / "home"
    skills = target / "skills"
    manifest = skills / ".bundled_manifest"
    optional = tmp_path / "optional"
    monkeypatch.setattr(skills_sync, "SKILLS_DIR", skills)
    monkeypatch.setattr(skills_sync, "MANIFEST_FILE", manifest)
    monkeypatch.setattr(skills_sync, "_get_optional_dir", lambda: optional)
    return target, skills, manifest


def old_home(skills: Path, legacy_count: int = 14) -> None:
    names = NAMES | {f"legacy-{index}" for index in range(legacy_count)}
    manifest = []
    for name in sorted(names):
        path = write_skill(skills, f"uniwork/{name}", name)
        manifest.append(f"{name}:{skills_sync._dir_hash(path)}")
    (skills / ".bundled_manifest").write_text("\n".join(manifest) + "\n", encoding="utf-8")


def test_old_home_converges_to_package_and_visible_set(homes):
    target, skills, manifest = homes
    old_home(skills)
    (skills / "uniwork/dws/SKILL.md").write_text("User changed dws\n", encoding="utf-8")
    (skills / "uniwork/video-frames/SKILL.md").unlink()
    write_skill(skills, "user/custom", "custom")
    write_skill(skills, "uniwork/community-old", "hub-old")
    with (skills / ".bundled_manifest").open("a", encoding="utf-8") as manifest_file:
        manifest_file.write(f"hub-old:{skills_sync._dir_hash(skills / 'uniwork/community-old')}\n")
    (skills / ".hub").mkdir()
    (skills / ".hub/lock.json").write_text(json.dumps({"installed": {
        "hub-old": {"install_path": "uniwork/community-old"},
    }}), encoding="utf-8")
    package = bundle(Path(target).parent / "bundle")

    result = sync(package)

    assert set(result["desired_builtin"]) == NAMES
    assert set(result["actual_builtin"]) == NAMES
    assert (skills / "uniwork/dws/SKILL.md").read_bytes() == (
        package / "uniwork/dws/SKILL.md").read_bytes()
    assert "User changed dws" in next((skills / ".retired-hermes").glob("dws*/SKILL.md")).read_text()
    assert (skills / "uniwork/video-frames").is_dir()
    assert (skills / "user/custom").is_dir()
    assert (skills / "uniwork/community-old").is_dir()
    assert not (skills / "uniwork/legacy-0").exists()
    assert set(skills_sync._read_manifest()) == NAMES | {"hermes-agent"}
    assert set(json.loads((skills / ".hub/lock.json").read_text())["installed"]) == {"hub-old"}
    assert not list((skills / ".retired-hermes").glob("legacy-*/SKILL.md"))


def test_manifest_failures_never_delete_external_same_name(homes, tmp_path):
    _, skills, _ = homes
    write_skill(skills, "user/doc", "doc")
    old_dws = write_skill(skills, "uniwork/dws", "dws")
    before = (old_dws / "SKILL.md").read_bytes()
    (skills / ".bundled_manifest").write_text("doc:not-a-real-hash\ndws:not-a-real-hash\n")
    package = bundle(tmp_path / "bundle")

    (package / RECORD).write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="install record"):
        sync(package)

    assert (skills / "user/doc/SKILL.md").is_file()
    assert (skills / "uniwork/dws/SKILL.md").read_bytes() == before
    state = json.loads((skills / ".bundled-distribution.json").read_text())
    assert state["sync_status"] == "failed"


def test_content_upgrade_replaces_without_archive(homes, tmp_path):
    _, skills, _ = homes
    first = bundle(tmp_path / "first")
    sync(first)
    (first / "uniwork/dws/SKILL.md").write_text("# Package V2\n", encoding="utf-8")
    write_record(first)

    result = sync(first)

    assert "dws" in result["updated"]
    assert (skills / "uniwork/dws/SKILL.md").read_text() == "# Package V2\n"
    assert not list((skills / ".retired-hermes").glob("dws*/SKILL.md"))
    assert not (skills / ".retired-hermes/.transactions").exists() or not any(
        (skills / ".retired-hermes/.transactions").iterdir())


def test_removed_and_renamed_package_paths_leave_active_tree(homes, tmp_path):
    _, skills, _ = homes
    package = bundle(tmp_path / "bundle")
    sync(package)
    old = package / "uniwork/video-frames"
    old.rename(package / "uniwork/video-clips")
    (package / "uniwork/video-clips/SKILL.md").write_text(
        "---\nname: video-clips\ndescription: renamed\n---\n", encoding="utf-8")
    files = _files(package)
    files.pop(RECORD, None)
    (package / RECORD).write_text(json.dumps({
        "source": "fixture", "ref": "release", "commit": "b" * 40,
        "skills": sorted(NAMES - {"video-frames"} | {"video-clips"}),
        "files": files,
    }), encoding="utf-8")

    sync(package)

    assert not (skills / "uniwork/video-frames").exists()
    assert (skills / "uniwork/video-clips").is_dir()
    assert "video-frames" not in set(skills_sync._read_manifest())
    assert set(skills_sync_uniwork._active_ordinary_names(skills)) == (
        NAMES - {"video-frames"} | {"video-clips"})


def test_historical_category_layout_uses_manifest_ownership(homes, tmp_path):
    _, skills, _ = homes
    pristine = write_skill(skills, "devops/pristine", "pristine")
    edited = write_skill(skills, "creative/edited", "edited")
    old_v1 = write_skill(skills, "research/old-v1", "old-v1")
    hub_owned = write_skill(skills, "media/hub-owned", "hub-owned")
    unknown = write_skill(skills, "devops/unknown", "unknown")
    manifest = {
        "pristine": skills_sync._dir_hash(pristine),
        "edited": skills_sync._dir_hash(edited),
        "hub-owned": skills_sync._dir_hash(hub_owned),
    }
    (edited / "SKILL.md").write_text("User edited historical skill\n", encoding="utf-8")
    (skills / ".bundled_manifest").write_text(
        "".join(f"{name}:{digest}\n" for name, digest in sorted(manifest.items()))
        + "old-v1\n",
        encoding="utf-8",
    )
    (skills / ".hub").mkdir()
    (skills / ".hub/lock.json").write_text(json.dumps({"installed": {
        "hub-owned": {"install_path": "media/hub-owned"},
    }}), encoding="utf-8")
    package = bundle(tmp_path / "bundle")

    result = sync(package)

    assert "pristine" in result["retired_pristine"]
    assert "edited" in result["retired_modified"]
    assert "old-v1" in result["retired_modified"]
    assert not pristine.exists()
    assert not old_v1.exists()
    assert "User edited historical skill" in next(
        (skills / ".retired-hermes").glob("edited*/SKILL.md")).read_text()
    assert hub_owned.is_dir()
    assert unknown.is_dir()
    assert set(skills_sync._read_manifest()) == NAMES | {"hermes-agent"}
    assert set(json.loads((skills / ".hub/lock.json").read_text())["installed"]) == {"hub-owned"}


def test_current_hub_path_is_taken_over_but_other_hub_remains(homes, tmp_path):
    _, skills, _ = homes
    package = bundle(tmp_path / "bundle")
    write_skill(skills, "uniwork/dws", "dws")
    write_skill(skills, "uniwork/hub-old", "hub-old")
    (skills / ".hub").mkdir()
    (skills / ".hub/lock.json").write_text(json.dumps({"installed": {
        "dws-hub": {"install_path": "uniwork/dws"},
        "other": {"install_path": "uniwork/hub-old"},
    }}), encoding="utf-8")

    result = sync(package)

    assert result["hub_conflicts_dropped"] == ["dws-hub"]
    assert (skills / "uniwork/dws/SKILL.md").read_bytes() == (
        package / "uniwork/dws/SKILL.md").read_bytes()
    assert (skills / "uniwork/hub-old").is_dir()
    lock = json.loads((skills / ".hub/lock.json").read_text())
    assert set(lock["installed"]) == {"other"}


def test_opt_out_and_suppression_do_not_block_authoritative_set(homes, tmp_path, monkeypatch):
    target, skills, _ = homes
    target.mkdir(parents=True, exist_ok=True)
    (target / ".no-bundled-skills").touch()
    skills.mkdir(parents=True)
    (skills / ".curator_suppressed").write_text("dws\nkeep-other\n", encoding="utf-8")
    package = bundle(tmp_path / "bundle")
    monkeypatch.setattr(skills_sync, "_get_bundled_dir", lambda: package)
    monkeypatch.setattr("agent.skill_utils.get_external_skills_dirs", lambda: [])

    result = skills_sync.sync_skills(quiet=True)

    assert set(result["actual_builtin"]) == NAMES
    assert (skills / "uniwork/dws").is_dir()
    assert (skills / "autonomous-ai-agents/hermes-agent").is_dir()
    assert (skills / ".curator_suppressed").read_text() == "keep-other\n"


def test_copy_failure_restores_old_copy_and_can_retry(homes, tmp_path, monkeypatch):
    _, skills, _ = homes
    write_skill(skills, "uniwork/dws", "dws")
    (skills / "uniwork/dws/SKILL.md").write_text("Old local copy\n", encoding="utf-8")
    before = (skills / "uniwork/dws/SKILL.md").read_bytes()
    package = bundle(tmp_path / "bundle")
    copy = skills_sync._copy_dir
    failed = False

    def flaky(source, destination):
        nonlocal failed
        if destination.name == "dws" and not failed:
            failed = True
            destination.mkdir(parents=True)
            (destination / "partial").write_text("partial", encoding="utf-8")
            raise OSError("fixture copy failure")
        return copy(source, destination)

    monkeypatch.setattr(skills_sync, "_copy_dir", flaky)
    with pytest.raises(OSError, match="copy failure"):
        sync(package)
    assert (skills / "uniwork/dws/SKILL.md").read_bytes() == before
    assert json.loads((skills / ".bundled-distribution.json").read_text())["sync_status"] == "failed"
    assert not any((skills / ".retired-hermes/.transactions").iterdir())

    result = sync(package)
    assert "dws" in result["updated"]
    assert (skills / "uniwork/dws/SKILL.md").read_bytes() == (
        package / "uniwork/dws/SKILL.md").read_bytes()


def test_archives_are_hidden_from_skill_listing(homes, tmp_path, monkeypatch):
    target, skills, _ = homes
    package = bundle(tmp_path / "bundle")
    sync(package)
    archived = skills / ".retired-hermes/legacy"
    write_skill(archived.parent, archived.name, "legacy")
    monkeypatch.setenv("HERMES_HOME", str(target))
    from tools.skills_tool import _find_all_skills

    names = {skill["name"] for skill in _find_all_skills(skip_disabled=True)}
    assert names == NAMES | {"hermes-agent"}


def test_state_and_content_are_isolated_across_homes(homes, tmp_path, monkeypatch):
    _, first, _ = homes
    package = bundle(tmp_path / "bundle")
    sync(package)
    first_state = json.loads((first / ".bundled-distribution.json").read_text())

    second_home = tmp_path / "home-b"
    monkeypatch.setattr(skills_sync, "SKILLS_DIR", second_home / "skills")
    monkeypatch.setattr(skills_sync, "MANIFEST_FILE", second_home / "skills/.bundled_manifest")
    sync(package)
    assert (second_home / "skills/uniwork/dws").is_dir()
    assert (first / "uniwork/dws").is_dir()
    assert first_state["managed"] == json.loads(
        (second_home / "skills/.bundled-distribution.json").read_text())["managed"]
