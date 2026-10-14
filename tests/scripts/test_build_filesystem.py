"""Build cleanup remains repeatable across sealed and interrupted outputs."""
from __future__ import annotations

import pytest

from scripts.build.filesystem import remove_build_tree


@pytest.mark.platforms("windows")
def test_remove_build_tree_retries_transient_windows_file_lock(tmp_path, monkeypatch):
    destination = tmp_path / "snapshot"
    destination.mkdir()
    attempts = []
    delays = []

    def remove(path, *, onerror):
        assert onerror is not None
        attempts.append(path)
        if len(attempts) < 3:
            raise PermissionError("temporarily held")

    monkeypatch.setattr("scripts.build.filesystem.shutil.rmtree", remove)
    monkeypatch.setattr("scripts.build.filesystem.time.sleep", delays.append)

    remove_build_tree(destination)

    assert attempts == [destination, destination, destination]
    assert delays == [0.25, 0.5]


@pytest.mark.platforms("windows")
def test_remove_build_tree_removes_baked_readonly_bytecode(tmp_path):
    destination = tmp_path / "snapshot"
    bytecode = destination / "package/__pycache__/module.pyc"
    bytecode.parent.mkdir(parents=True)
    bytecode.write_bytes(b"compiled")
    bytecode.chmod(0o444)

    remove_build_tree(destination)

    assert not destination.exists()
