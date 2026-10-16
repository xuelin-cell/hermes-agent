"""desktop-mt: the build copies the gitcode bundled kits next to the plugin that installs them."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path

from scripts.bundles.uniwork_bundled import TARGET, stage_bundled_plugins


def _config_repo(root: Path) -> Path:
    bundle = root / "plugins" / "uniwork-bundled"
    (bundle / "plugins").mkdir(parents=True)
    with zipfile.ZipFile(bundle / "plugins" / "good-kit.zip", "w") as zf:
        zf.writestr("good-kit/.codebuddy-plugin/plugin.json", json.dumps({"name": "good-kit"}))
        zf.writestr("good-kit/skills/a/SKILL.md", "---\nname: a\n---\n")
    with zipfile.ZipFile(bundle / "plugins" / "no-manifest.zip", "w") as zf:
        zf.writestr("readme.md", "no plugin here")
    # What a Git LFS pointer looks like when the build machine lacks git-lfs.
    (bundle / "plugins" / "lfs-pointer.zip").write_text("version https://git-lfs.github.com/spec/v1\n", encoding="utf-8")
    (bundle / "avatars").mkdir()
    (bundle / "avatars" / "good-kit.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    return root


def test_a_local_config_checkout_is_staged_with_only_installable_zips(tmp_path, capsys):
    repo_dir = tmp_path / "hermes-agent"
    source = _config_repo(tmp_path / "config")
    assert stage_bundled_plugins(repo_dir, {"UNIWORK_BUNDLED_PLUGINS": str(source)}) == 1
    staged = repo_dir / TARGET
    assert sorted(p.name for p in (staged / "plugins").iterdir()) == ["good-kit.zip"]
    assert (staged / "avatars" / "good-kit.png").is_file()
    log = capsys.readouterr().out
    assert "no-manifest.zip" in log and "lfs-pointer.zip" in log and "(1 plugin archive(s))" in log


def test_a_git_source_is_fetched_at_the_requested_revision(tmp_path):
    source = _config_repo(tmp_path / "config")
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
    subprocess.run([*git, "init", "-q"], cwd=source, check=True)
    subprocess.run([*git, "add", "-A"], cwd=source, check=True)
    subprocess.run([*git, "commit", "-q", "-m", "bundle"], cwd=source, check=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    (source / "plugins" / "uniwork-bundled" / "plugins" / "good-kit.zip").unlink()
    subprocess.run([*git, "commit", "-q", "-am", "drop it"], cwd=source, check=True)

    repo_dir = tmp_path / "hermes-agent"
    env = {"UNIWORK_BUNDLED_PLUGINS": source.resolve().as_uri(), "UNIWORK_BUNDLED_PLUGINS_REF": commit}
    assert stage_bundled_plugins(repo_dir, env) == 1


def test_off_or_an_unreachable_source_builds_without_bundled_kits(tmp_path, capsys):
    repo_dir = tmp_path / "hermes-agent"
    assert stage_bundled_plugins(repo_dir, {"UNIWORK_BUNDLED_PLUGINS": "off"}) == 0
    missing = (tmp_path / "nowhere").resolve().as_uri()
    assert stage_bundled_plugins(repo_dir, {"UNIWORK_BUNDLED_PLUGINS": missing}) == 0
    assert not (repo_dir / TARGET).exists()
    assert "building without them" in capsys.readouterr().out
