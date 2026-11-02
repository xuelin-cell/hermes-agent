"""Image-local tools must be replaceable during state restoration."""

import os
from pathlib import Path
import stat
import sys

import pytest

SEED = Path(__file__).resolve().parents[2] / "deploy/hermes-mt/seed"
if str(SEED) not in sys.path:
    sys.path.insert(0, str(SEED))

import mtstate
from prepare_home import check_home, prepare_home


@pytest.mark.platforms("posix")
def test_nested_image_tools_can_be_replaced_by_a_real_state_archive(tmp_path):
    source = tmp_path / "source"
    (source / "tools").mkdir(parents=True)
    (source / "tools/user-tool.py").write_text("print('saved tool')")
    (source / "config.yaml").write_text("model: saved-model\n")
    archive, manifest = mtstate.build_archive(source, tmp_path / "archive", "old", 1, "")
    home = tmp_path / "new-home"
    nested = home / "tools/agent-browser-0.26.0-linux-x64/bin"
    nested.mkdir(parents=True)
    binary = nested / "agent-browser"
    binary.write_text("old binary")
    binary.chmod(0o555)
    for directory in (nested, nested.parent):
        directory.chmod(0o555)
    try:
        prepare_home(home, os.getuid(), os.getgid())
        check_home(home)
        result = mtstate.restore_archive(home, archive.parent, manifest)
        assert result["archive"] == manifest.archive
        assert (home / "tools/user-tool.py").read_text() == "print('saved tool')"
        assert (home / "config.yaml").read_text() == "model: saved-model\n"
        assert not nested.parent.exists()
    finally:
        for directory in (nested.parent, nested):
            if directory.exists():
                directory.chmod(0o755)


@pytest.mark.platforms("posix")
def test_image_permission_preparation_does_not_follow_links_or_change_user_state(tmp_path):
    home = tmp_path / "home"
    (home / "tools").mkdir(parents=True)
    outside = tmp_path / "persistent-or-immutable"
    outside.mkdir()
    (outside / "keep").write_text("unchanged")
    (home / "tools/linked-store").symlink_to(outside, target_is_directory=True)
    state = home / "config.yaml"
    state.write_text("user config")
    state.chmod(0o400)
    before = [(p, p.stat()) for p in (outside, outside / "keep", state)]
    prepare_home(home, os.getuid(), os.getgid())
    check_home(home)
    for path, old in before:
        current = path.stat()
        assert (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) == (
            old.st_uid, old.st_gid, stat.S_IMODE(old.st_mode))
    assert (outside / "keep").read_text() == "unchanged"
    assert state.read_text() == "user config"
