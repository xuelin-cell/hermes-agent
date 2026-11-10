"""Real harmless terminal executions exercise the final policy boundary."""

import json
import shlex
import sys
from pathlib import Path
import subprocess
import pytest

from model_tools import handle_function_call
from tests.plugins.test_security_guardrail import profile


def terminal(command, task_id, **kwargs):
    return json.loads(handle_function_call("terminal", {"command": command, **kwargs}, task_id=task_id))


def workspace(tmp_path):
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    return root


def test_terminal_blocks_protected_foreground_and_background(tmp_path):
    root = workspace(tmp_path)
    with profile(tmp_path / "home", root) as task_id:
        for background in (False, True):
            target = root / "protected" / f"blocked-{background}.txt"
            result = terminal(f"printf guarded > {shlex.quote(target.as_posix())}", task_id, background=background)
            assert "security-guardrail" in result.get("error", ""), result
            assert not target.exists()
        allowed = terminal("printf allowed > allowed.txt", task_id)
        assert not allowed.get("error"), allowed
        assert (root / "allowed.txt").read_text(encoding="utf-8") == "allowed"


def test_terminal_uses_actual_workdir_and_approval_decision(tmp_path, monkeypatch):
    root = workspace(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    from tools import approval
    prompts = []
    approved = False

    def decide(tool, reason, *, rule_key=""):
        prompts.append((tool, rule_key))
        return {"approved": approved, "message": "test decision"}

    monkeypatch.setattr(approval, "request_tool_approval", decide)
    with profile(tmp_path / "home", root) as task_id:
        result = terminal("printf outside > created.txt", task_id, workdir=str(outside))
        assert result.get("error"), result
        assert not (outside / "created.txt").exists()
        approved = True
        result = terminal("printf outside > created.txt", task_id, workdir=str(outside))
        assert not result.get("error"), result
        assert (outside / "created.txt").read_text(encoding="utf-8") == "outside"
        result = terminal("printf other > changed.txt", task_id, workdir=str(outside))
        assert not result.get("error"), result
        assert len(prompts) == 3
        assert prompts[0][1] == prompts[1][1]
        assert prompts[1][1] != prompts[2][1]


def test_terminal_inspects_local_scripts_with_bounded_reader(tmp_path):
    root = workspace(tmp_path)
    script = root / "safe.py"
    script.write_text("print('guardrail-script-ok')\n", encoding="utf-8")
    huge = root / "huge.py"
    huge.write_bytes(b"#" + b"x" * (1024 * 1024 + 1))
    python = shlex.quote(Path(sys.executable).as_posix())
    with profile(tmp_path / "home", root) as task_id:
        result = terminal(f"{python} safe.py", task_id)
        assert "guardrail-script-ok" in result.get("output", ""), result
        result = terminal(f"{python} huge.py", task_id)
        assert "security-guardrail" in result.get("error", ""), result


def test_recorded_session_cwd_does_not_move_file_security_boundary(tmp_path):
    from tests.plugins.test_security_guardrail import write
    root = workspace(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    with profile(tmp_path / "home", root) as task_id:
        from tools.terminal_tool import record_session_cwd
        # Exercise the host's real session-cwd API and the real file resolver.
        # A session record is execution state, never a new security boundary.
        record_session_cwd(task_id, str(outside))
        result = write("after-cd.txt", task_id)
        assert result.get("status") == "blocked", result
        assert not (outside / "after-cd.txt").exists()


@pytest.mark.platforms("windows")
def test_windows_shell_msys_and_junction_targets_keep_hard_deny(tmp_path):
    root = workspace(tmp_path)
    alias = root / "alias"
    subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(root / "protected")], check=True, capture_output=True)
    try:
        with profile(tmp_path / "home", root, settings={"mode": "auto"}) as task_id:
            target = root / "protected" / "msys.txt"
            native = target.as_posix()
            msys = "/" + native[0].lower() + native[2:]
            for command in (f"printf guarded > {shlex.quote(msys)}", "printf guarded > alias/junction.txt"):
                result = terminal(command, task_id)
                assert "common.filesystem.product_install_dir_access" in (result.get("error") or ""), result
            assert not list((root / "protected").iterdir())
    finally:
        alias.rmdir()


def test_shell_script_variables_are_not_resolved_from_initial_environment(tmp_path):
    root = workspace(tmp_path)
    with profile(tmp_path / "home", root, settings={"mode": "auto"}) as task_id:
        # Do not execute either candidate script. Without a proven persistent
        # shell environment this input must stop before process execution.
        for command in ('bash "$HOME/payload.sh"', 'bash ~/payload.sh'):
            result = terminal(command, task_id)
            assert "security-guardrail" in (result.get("error") or ""), result
