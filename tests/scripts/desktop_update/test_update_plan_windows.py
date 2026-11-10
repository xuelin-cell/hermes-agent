"""Windows installer planner produces correct delete/exclude lists.

NOTE: These tests require a real installed payload with a working Python interpreter
at tools/python/python.exe. The planner invokes this interpreter to verify component
digests. Fake payloads will fail with "not a valid Win32 application" errors.

For CI, these tests should be skipped unless a real payload is available.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


pytestmark = [pytest.mark.platforms("windows"), pytest.mark.skip(reason="Requires real installed payload with working Python interpreter")]

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
UPDATE_PLAN_PS1 = REPO_ROOT / "apps/desktop/nsis/update-plan.ps1"


def _write_stamp(path: Path, target: str, components: dict[str, str], tools: dict[str, dict],
                 archive_components: set[str] | None = None) -> None:
    """Write a payload-stamp.txt file.

    Args:
        archive_components: Set of component names that should be marked as 'archive'.
    """
    archive_components = archive_components or set()
    lines = ["schema 1", f"target {target}"]
    for name in ("venv", "pm-runtime", "uv-cache.zip", "hermes-agent"):
        if name in components:
            suffix = " archive" if name in archive_components else ""
            lines.append(f"{name} {components[name]}{suffix}")
    for name, info in sorted(tools.items()):
        lines.append(f"tool {name} {info['entry']} {info['version']} {info['digest']}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _make_payload(root: Path, target: str, components: dict[str, str], tools: dict[str, dict]) -> None:
    payload = root / "resources/agent-payload"
    payload.mkdir(parents=True)
    (payload / "manifest.json").write_text(json.dumps({
        "runtime": {"storePython": "tools/python/python.exe", "repoDir": "app"}
    }), encoding="utf-8")
    for name in ("venv", "pm-runtime"):
        (payload / name).mkdir(exist_ok=True)
        (payload / name / "file").write_bytes(b"content")
    (payload / "uv-cache.zip").write_bytes(b"cache")
    (payload / "app").mkdir(exist_ok=True)
    (payload / "app/file").write_bytes(b"app")
    (payload / "tools/python").mkdir(parents=True, exist_ok=True)
    (payload / "tools/python/python.exe").write_bytes(b"python")
    _write_stamp(payload / "payload-stamp.txt", target, components, tools)


def _run_planner(install: Path, new_stamp: Path, old_stamp: Path | None, delete_file: Path, patterns_file: Path) -> subprocess.CompletedProcess:
    powershell = shutil.which("powershell.exe")
    assert powershell, "Windows planner tests require Windows PowerShell."
    args = [
        powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(UPDATE_PLAN_PS1),
        "-Install", str(install), "-NewStamp", str(new_stamp),
        "-DeleteFile", str(delete_file), "-PatternsFile", str(patterns_file),
    ]
    if old_stamp:
        args.extend(["-OldStamp", str(old_stamp)])
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)


def test_planner_exits_2_when_not_installed_payload(tmp_path):
    install = tmp_path / "not-a-payload"
    install.mkdir()
    new_stamp = tmp_path / "new.txt"
    _write_stamp(new_stamp, "windows-x64", {"venv": "a" * 64, "pm-runtime": "b" * 64, "uv-cache.zip": "c" * 64}, {})
    delete = tmp_path / "delete.txt"
    patterns = tmp_path / "exclude-patterns.txt"
    result = _run_planner(install, new_stamp, None, delete, patterns)
    assert result.returncode == 2


def test_planner_deletes_everything_when_no_previous_stamp(tmp_path):
    install = tmp_path / "install"
    install.mkdir()
    (install / "resources").mkdir()
    (install / "resources/agent-payload").mkdir()
    (install / "other").write_bytes(b"old")
    components = {"venv": "a" * 64, "pm-runtime": "b" * 64, "uv-cache.zip": "c" * 64}
    tools = {"python": {"entry": "python", "version": "3.11", "digest": "d" * 64}}
    _make_payload(install, "windows-x64", components, tools)
    new_stamp = install / "resources/agent-payload/payload-stamp.txt"
    delete = tmp_path / "delete.txt"
    patterns = tmp_path / "exclude-patterns.txt"
    result = _run_planner(install, new_stamp, None, delete, patterns)
    assert result.returncode == 0
    deleted = delete.read_text(encoding="utf-8").splitlines()
    assert "other" in deleted
    # 没有可比对的旧指纹时，计划只删顶层目录（resources 整个删掉，venv 等在里面跟着走）。
    assert "resources" in deleted
    assert r"resources\agent-payload\venv" not in deleted


def test_planner_keeps_components_with_matching_digests(tmp_path):
    install = tmp_path / "install"
    install.mkdir()
    (install / "resources/agent-payload").mkdir(parents=True)
    components = {"venv": "a" * 64, "pm-runtime": "b" * 64, "uv-cache.zip": "c" * 64}
    tools = {"python": {"entry": "python", "version": "3.11", "digest": "d" * 64}}
    _make_payload(install, "windows-x64", components, tools)
    old_stamp = tmp_path / "old.txt"
    _write_stamp(old_stamp, "windows-x64", components, tools)
    new_stamp = install / "resources/agent-payload/payload-stamp.txt"
    delete = tmp_path / "delete.txt"
    patterns = tmp_path / "exclude-patterns.txt"
    result = _run_planner(install, new_stamp, old_stamp, delete, patterns)
    assert result.returncode == 0
    patterns_lines = patterns.read_text(encoding="utf-8").splitlines()
    # 纯模式行，7za 用 -x@listfile 读取（一行一个，不再带 -x! 前缀）。
    assert r"resources\agent-payload\venv\*" in patterns_lines
    assert r"resources\agent-payload\pm-runtime\*" in patterns_lines
    assert r"resources\agent-payload\uv-cache.zip" in patterns_lines
    assert r"resources\agent-payload\tools\python\*" in patterns_lines
    deleted = delete.read_text(encoding="utf-8").splitlines()
    assert len(deleted) == 0


def test_planner_replaces_component_when_digest_changes(tmp_path):
    install = tmp_path / "install"
    install.mkdir()
    (install / "resources/agent-payload").mkdir(parents=True)
    old_components = {"venv": "a" * 64, "pm-runtime": "b" * 64, "uv-cache.zip": "c" * 64}
    new_components = {"venv": "x" * 64, "pm-runtime": "b" * 64, "uv-cache.zip": "c" * 64}
    tools = {"python": {"entry": "python", "version": "3.11", "digest": "d" * 64}}
    _make_payload(install, "windows-x64", new_components, tools)
    old_stamp = tmp_path / "old.txt"
    _write_stamp(old_stamp, "windows-x64", old_components, tools)
    new_stamp = install / "resources/agent-payload/payload-stamp.txt"
    delete = tmp_path / "delete.txt"
    patterns = tmp_path / "exclude-patterns.txt"
    result = _run_planner(install, new_stamp, old_stamp, delete, patterns)
    assert result.returncode == 0
    patterns_lines = patterns.read_text(encoding="utf-8").splitlines()
    assert r"resources\agent-payload\pm-runtime\*" in patterns_lines
    assert r"resources\agent-payload\uv-cache.zip" in patterns_lines
    assert not any("venv" in line for line in patterns_lines)
    deleted = delete.read_text(encoding="utf-8").splitlines()
    assert r"resources\agent-payload\venv" in deleted
