"""desktop-mt: the build copies the gitcode bundled kits next to the plugin that installs them."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path

from scripts.bundles.uniwork_bundled import TARGET, stage_bundled_plugins


def _config_repo(root: Path) -> Path:
    """在临时目录里做一个配置仓库：一个能装的包，外加没有清单的 zip、LFS 指针文件和头像。"""
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
    """本地配置仓库只拷能装的 zip 和头像，坏包在日志里点名跳过。"""
    repo_dir = tmp_path / "hermes-agent"
    source = _config_repo(tmp_path / "config")
    assert stage_bundled_plugins(repo_dir, {"UNIWORK_BUNDLED_PLUGINS": str(source)}) == 1
    staged = repo_dir / TARGET
    assert sorted(p.name for p in (staged / "plugins").iterdir()) == ["good-kit.zip"]
    assert (staged / "avatars" / "good-kit.png").is_file()
    log = capsys.readouterr().out
    assert "no-manifest.zip" in log and "lfs-pointer.zip" in log and "(1 plugin archive(s))" in log


def test_a_git_source_is_fetched_at_the_requested_revision(tmp_path):
    """git 来源按指定的提交拉取，而不是最新的。"""
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


def test_off_unset_or_an_unreachable_source_builds_without_bundled_kits(tmp_path, capsys):
    """关掉、没配置或拉不到时都只打警告，打包照常继续，不留下半截目录。"""
    repo_dir = tmp_path / "hermes-agent"
    assert stage_bundled_plugins(repo_dir, {"UNIWORK_BUNDLED_PLUGINS": "off"}) == 0
    assert stage_bundled_plugins(repo_dir, {}) == 0
    missing = (tmp_path / "nowhere").resolve().as_uri()
    assert stage_bundled_plugins(repo_dir, {"UNIWORK_BUNDLED_PLUGINS": missing}) == 0
    assert not (repo_dir / TARGET).exists()
    assert "building without them" in capsys.readouterr().out


def test_the_desktop_build_defaults_to_the_gitcode_source_and_keeps_a_chosen_one():
    """正式打包的环境默认指向 gitcode，打包人自己指定的来源不被覆盖。"""
    from types import SimpleNamespace

    from scripts.bundles.desktop_inputs import identity_environment
    from scripts.bundles.uniwork_bundled import DEFAULT_SOURCE

    request = SimpleNamespace(validate_channel=lambda: None, channel_request=None, commit="a" * 40,
                              version="1.0.0", bundle_env={}, release_epoch=None, tag=None)
    assert identity_environment(request, "bundled", {})["UNIWORK_BUNDLED_PLUGINS"] == DEFAULT_SOURCE
    chosen = {"UNIWORK_BUNDLED_PLUGINS": "off"}
    assert identity_environment(request, "bundled", chosen)["UNIWORK_BUNDLED_PLUGINS"] == "off"
