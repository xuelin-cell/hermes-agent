"""Authorize the whole real patch before its first filesystem mutation."""

import json
import subprocess
import pytest

from model_tools import handle_function_call
from tests.plugins.test_security_guardrail import profile


def run_patch(task_id, **args):
    return json.loads(handle_function_call("patch", args, task_id=task_id))


def test_patch_replace_and_multi_target_are_authorized_before_mutation(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    protected = root / "protected"
    protected.mkdir(parents=True)
    original = protected / "existing.txt"
    original.write_text("original\n", encoding="utf-8")
    ordinary = root / "ordinary.txt"
    ordinary.write_text("original\n", encoding="utf-8")
    before = original.stat().st_mtime_ns
    with profile(tmp_path / "home", root) as task_id:
        malformed = run_patch(task_id, mode="patch", patch="*** Begin Patch\nnot an operation\n*** End Patch")
        assert malformed.get("error"), malformed
        assert ordinary.read_text(encoding="utf-8") == "original\n"
        result = run_patch(task_id, path=str(original), old_string="original", new_string="changed")
        assert "security-guardrail" in (result.get("error") or ""), result
        assert original.read_text(encoding="utf-8") == "original\n"
        assert original.stat().st_mtime_ns == before
        for operation in (
            "*** Add File: protected/new.txt\n+new",
            "*** Update File: protected/existing.txt\n@@\n-original\n+changed",
            "*** Delete File: protected/existing.txt",
            "*** Move File: protected/existing.txt -> moved.txt",
            "*** Move File: ordinary.txt -> protected/moved.txt",
        ):
            patch = "*** Begin Patch\n*** Add File: first.txt\n+first\n" + operation + "\n*** End Patch"
            result = run_patch(task_id, mode="patch", patch=patch.replace("\n", "\r\n"))
            assert "security-guardrail" in (result.get("error") or ""), result
            assert not (root / "first.txt").exists()
            assert original.read_text(encoding="utf-8") == "original\n"
            assert ordinary.read_text(encoding="utf-8") == "original\n"
        result = run_patch(task_id, path="ordinary.txt", old_string="original", new_string="allowed")
        assert not result.get("error"), result
        assert ordinary.read_text(encoding="utf-8") == "allowed\n"
        patch = "*** Begin Patch\n*** Add File: added.txt\n+added\n*** Move File: ordinary.txt -> renamed.txt\n*** Update File: renamed.txt\n@@\n-allowed\n+after-move\n*** End Patch"
        result = run_patch(task_id, mode="patch", patch=patch)
        assert result.get("status") == "blocked", result
        assert not (root / "added.txt").exists()
        from tools import approval
        approvals = []
        def approve(*args, **kwargs):
            approvals.append(kwargs["rule_key"])
            return {"approved": True}
        monkeypatch.setattr(approval, "request_tool_approval", approve)
        result = run_patch(task_id, mode="patch", patch=patch)
        assert not result.get("error"), result
        assert len(approvals) == 1
        assert (root / "added.txt").read_text(encoding="utf-8").strip() == "added"
        assert not ordinary.exists()
        assert (root / "renamed.txt").read_text(encoding="utf-8") == "after-move\n"


@pytest.mark.platforms("windows")
def test_patch_moved_junction_dependency_is_refused_before_first_edit(tmp_path):
    root = tmp_path / "workspace"
    protected = root / "protected"
    protected.mkdir(parents=True)
    victim = protected / "victim.txt"
    victim.write_text("original\n", encoding="utf-8")
    link = root / "alias"
    subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(protected)], check=True, capture_output=True)
    try:
        with profile(tmp_path / "home", root, settings={"mode": "auto"}) as task_id:
            result = run_patch(task_id, mode="patch", patch="*** Begin Patch\n*** Add File: first.txt\n+first\n*** Move File: alias -> moved\n*** Update File: moved/victim.txt\n@@\n-original\n+changed\n*** End Patch")
            assert "moved link" in result["error"], result
            assert victim.read_text(encoding="utf-8") == "original\n"
            assert not (root / "first.txt").exists()
            assert not (root / "moved").exists()
    finally:
        link.rmdir()


@pytest.mark.platforms("posix")
def test_patch_moved_file_symlink_dependency_is_refused(tmp_path):
    root = tmp_path / "workspace"
    protected = root / "protected"
    protected.mkdir(parents=True)
    victim = protected / "victim.txt"
    victim.write_text("original\n", encoding="utf-8")
    (root / "alias.txt").symlink_to(victim)
    with profile(tmp_path / "home", root, settings={"mode": "auto"}) as task_id:
        result = run_patch(task_id, mode="patch", patch="*** Begin Patch\n*** Move File: alias.txt -> moved.txt\n*** Update File: moved.txt\n@@\n-original\n+changed\n*** End Patch")
        assert "moved link" in result["error"], result
        assert victim.read_text(encoding="utf-8") == "original\n"
        assert (root / "alias.txt").is_symlink()
