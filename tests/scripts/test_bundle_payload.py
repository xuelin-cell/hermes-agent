"""Shared bundle operations use real filesystem and entrypoint contracts."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


import pytest

from scripts.bundles.payload import relativize_links, snapshot, write_payload_stamp
from scripts.build.inputs import project_entries
from scripts.build.agent import plant_surfaces
from scripts.build.launchers import posix_launcher
from scripts.bundles.desktop import release_version
from pm.lock import Facts
from pm.store import current_target, tree_digest


def test_release_version_comes_from_the_release_identity_not_the_checkout(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nversion="0.0.0"\n', encoding="utf-8")
    assert release_version(tmp_path, "v1.2.3") == "1.2.3"
    assert release_version(tmp_path, "v1.2.4") == "1.2.4"


def test_wrapper_rejects_unresolved_template_fields(tmp_path, monkeypatch):
    from scripts.build import launchers

    template = tmp_path / "launcher_wrapper.py"
    template.write_text('entry = "__HERMES_ENTRY_MODULE__"\nmissing = "__HERMES_NEW__"\n', encoding="utf-8")
    monkeypatch.setattr(launchers, "__file__", str(tmp_path / "payload.py"))
    with pytest.raises(ValueError, match="__HERMES_NEW__"):
        launchers.render_wrapper("entry:run", "../app", "../venv/Lib/site-packages")


@pytest.mark.platforms("posix")
def test_relocation_preserves_sibling_and_framework_links(tmp_path):
    root = tmp_path / "payload"
    store = root / "tools/python/bin"
    venv = root / "venv/bin"
    store.mkdir(parents=True)
    venv.mkdir(parents=True)
    (store / "python3").write_text("interpreter", encoding="utf-8")
    (venv / "python").symlink_to("/builder/tools/python/bin/python3")
    (venv / "python3").symlink_to("python")
    framework = root / "tools/framework"
    framework.symlink_to("python/bin/python3")
    assert relativize_links(root) == 1
    assert (venv / "python3").read_text(encoding="utf-8-sig") == "interpreter"
    assert os.readlink(venv / "python3") == "python"
    assert os.readlink(framework) == "python/bin/python3"
    assert relativize_links(root) == 0
    (venv / "bad").symlink_to("/usr/bin/python")
    with pytest.raises(ValueError, match="escapes payload"):
        relativize_links(root)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("target", ["linux-x64", "linux-arm64-bionic"])
def test_both_launchers_keep_active_home_and_call_declared_function(tmp_path, target):
    root = tmp_path / "payload with spaces"
    (root / "bin").mkdir(parents=True)
    (root / "app").mkdir()
    (root / "python").symlink_to(sys.executable)
    (root / "app/entry.py").write_text("import json,os,sys\ndef run():\n print(json.dumps([os.environ['HERMES_HOME'],sys.argv[1:]])); return 7\n", encoding="utf-8")
    launcher = root / "bin/custom"
    launcher.write_text(posix_launcher("custom", "entry:run", python="python", repo="app", site="deps", target=target), encoding="utf-8")
    result = subprocess.run(["sh", str(launcher), "two words", "$(nope)", ""], cwd=tmp_path,
                            env={**os.environ, "HERMES_HOME": str(tmp_path / "custom/profiles/memory")}, capture_output=True, text=True)
    assert result.returncode == 7, result.stderr
    assert json.loads(result.stdout) == [str(tmp_path / "custom/profiles/memory"), ["two words", "$(nope)", ""]]


def test_write_payload_stamp_records_schema_target_and_components(tmp_path):
    root = tmp_path / "payload"
    store = root / "tools"
    entries = {"python": "python", "uv": "uv"}
    lock = tmp_path / "lock.json"
    lock_obj = __import__("pm.lock", fromlist=["Lockfile"]).Lockfile(lock)
    for name, entry in entries.items():
        directory = store / entry
        directory.mkdir(parents=True)
        (directory / "tool").write_bytes(b"staging bytes")
        lock_obj.set_pin(name, "1.0", {current_target(): {
            "url": "https://example.invalid/tool.zip", "sha256": "a" * 64,
        }})
    lock_obj.save()
    from scripts.bundles.payload import record_tools
    record_tools(root, lock, current_target(), entries)
    Facts(store / "facts.json").record_state("venv", "selection", ["web"])
    (root / "venv").mkdir()
    (root / "venv" / "file").write_bytes(b"venv bytes")
    (root / "pm-runtime").mkdir()
    (root / "pm-runtime" / "file").write_bytes(b"runtime bytes")
    (root / "uv-cache.zip").write_bytes(b"cache bytes")
    stamp_path = write_payload_stamp(root)
    assert stamp_path == root / "payload-stamp.txt"
    lines = stamp_path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "schema 1"
    assert lines[1] == f"target {current_target()}"
    components = {}
    tools = {}
    for line in lines[2:]:
        if line.startswith(("venv ", "pm-runtime ", "uv-cache.zip ")):
            name, digest = line.split(" ", 1)
            components[name] = digest
        elif line.startswith("tool "):
            parts = line.split()
            tools[parts[1]] = {"entry": parts[2], "version": parts[3], "digest": parts[4]}
    assert set(components.keys()) == {"venv", "pm-runtime", "uv-cache.zip"}
    for name, digest in components.items():
        assert len(digest) == 64
        assert all(c in "0123456789abcdef" for c in digest)
    assert set(tools.keys()) == {"python", "uv"}
    for name, info in tools.items():
        assert len(info["digest"]) == 64
        assert info["version"] == "1.0"
        expected_digest = tree_digest(root / "tools" / info["entry"])
        assert info["digest"] == expected_digest
