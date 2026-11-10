"""Exercise directory protection through real discovery and file-tool dispatch."""

from __future__ import annotations

import json
import shutil
import subprocess
from contextlib import contextmanager
from pathlib import Path

import pytest

from agent.secret_scope import reset_secret_scope, set_multiplex_active, set_secret_scope
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_cli.plugins import PluginContext, get_plugin_manager
from hermes_cli.plugins_manifest import PluginManifest
from model_tools import handle_function_call
from tools.terminal_scope import reset_terminal_scope, set_terminal_scope
from tools.terminal_tool import clear_task_env_overrides, register_task_env_overrides


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "protected").mkdir()
    (root / "protected-other").mkdir()
    return root


@contextmanager
def profile(home, workspace, *, enabled=True, protected=None, settings=None):
    home.mkdir(exist_ok=True)
    (home / "config.yaml").write_text(json.dumps({
        "plugins": {
            "enabled": ["security-guardrail"] if enabled else [],
            "entries": {"security-guardrail": {"settings": {
                "protected_directory": str(protected or workspace / "protected"),
                **(settings or {}),
            }}},
        },
        "terminal": {"backend": "local", "cwd": str(workspace)},
    }), encoding="utf-8")
    home_token = set_hermes_home_override(home)
    secret_token = set_secret_scope({})
    terminal_token = set_terminal_scope({"TERMINAL_ENV": "local", "TERMINAL_CWD": str(workspace)})
    task_id = f"security-guardrail-{home.name}"
    register_task_env_overrides(task_id, {"env_type": "local", "cwd": str(workspace)})
    try:
        manager = get_plugin_manager()
        manager.discover_and_load(force=True)
        assert manager.has_hook("pre_tool_execute") == enabled
        yield task_id
    finally:
        clear_task_env_overrides(task_id)
        reset_terminal_scope(terminal_token)
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def write(path, task_id, content="new content"):
    return json.loads(handle_function_call(
        "write_file", {"path": str(path), "content": content}, task_id=task_id,
    ))


def test_write_guard_matches_real_targets(tmp_path, workspace):
    protected = workspace / "protected"
    existing = protected / "existing.txt"
    existing.write_bytes(b"original bytes")
    before = existing.stat()
    with profile(tmp_path / "home", workspace) as task_id:
        for target in (protected / "new.txt", "protected/relative.txt", "protected/child/../traversal.txt", existing):
            result = write(target, task_id)
            assert "security-guardrail" in result["error"], result
        assert list(protected.iterdir()) == [existing]
        assert existing.read_bytes() == b"original bytes"
        assert existing.stat().st_mtime_ns == before.st_mtime_ns
        allowed = workspace / "protected-other" / "allowed.txt"
        result = write(allowed, task_id)
        assert not result.get("error"), result
        assert allowed.read_text(encoding="utf-8") == "new content"


def test_rewritten_protected_target_is_blocked(tmp_path, workspace):
    """A later parameter rewrite must not bypass a directory decision."""
    protected = workspace / "protected" / "rewritten.txt"
    allowed = workspace / "protected-other" / "original.txt"
    with profile(tmp_path / "home", workspace) as task_id:
        ctx = PluginContext(PluginManifest(name="test-target-rewriter"), get_plugin_manager())

        def rewrite(tool_name="", **kwargs):
            if tool_name == "write_file":
                return {"action": "modify", "args": {"path": str(protected)}}
            return None

        registration = ctx.register_hook("pre_tool_call", rewrite)
        try:
            result = write(allowed, task_id, content="rewrite-gap-probe")
            if protected.exists():
                assert not result.get("error"), result
                assert protected.read_text(encoding="utf-8") == "rewrite-gap-probe"
                raise FileExistsError("The rewritten protected target was actually written")
            assert "security-guardrail" in result.get("error", ""), result
            assert not allowed.exists()
        finally:
            registration.dispose()


def test_installed_copy_loads_policy_from_profile(tmp_path, workspace):
    home = tmp_path / "installed-home"
    installed = home / "plugins" / "security-guardrail"
    source = Path(__file__).resolve().parents[2] / "plugins" / "security-guardrail"
    shutil.copytree(source, installed, ignore=shutil.ignore_patterns("__pycache__"))
    with profile(home, workspace) as task_id:
        loaded = get_plugin_manager()._plugins["security-guardrail"]
        assert Path(loaded.module.__file__).resolve() == (installed / "__init__.py").resolve()
        target = workspace / "protected" / "installed-denied.txt"
        result = write(target, task_id)
        assert "common.filesystem.product_install_dir_access" in result["error"], result
        assert not target.exists()


def test_profile_rules_follow_a_b_a_and_disable(tmp_path, workspace):
    a, b = tmp_path / "A", tmp_path / "B"
    set_multiplex_active(True)
    try:
        for home, filename in ((a, "first.txt"), (b, "second.txt"), (a, "third.txt")):
            with profile(home, workspace, protected=workspace / ("protected" if home == a else "protected-other")) as task_id:
                target = workspace / "protected" / filename
                result = write(target, task_id)
                assert target.exists() == (home == b), result
                assert bool(result.get("error")) == (home == a), result
        with profile(a, workspace, enabled=False) as task_id:
            target = workspace / "protected" / "disabled.txt"
            result = write(target, task_id)
            assert not result.get("error"), result
            assert target.read_text(encoding="utf-8") == "new content"
    finally:
        set_multiplex_active(False)


@pytest.mark.platforms("windows")
def test_windows_case_and_junction_match_target(tmp_path, workspace):
    alias = workspace / "alias"
    subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(workspace / "protected")], check=True, capture_output=True)
    try:
        with profile(tmp_path / "home", workspace) as task_id:
            for target in (str(workspace / "protected" / "case.txt").upper().replace("\\", "/"), alias / "linked.txt"):
                descriptions = []
                observer = PluginContext(PluginManifest(name="execution-inspector"), get_plugin_manager())
                registration = observer.register_hook("pre_tool_execute", lambda execution, **kw: descriptions.append(
                    [(item.path, item.original_path) for item in execution.targets]))
                result = write(target, task_id)
                registration.dispose()
                assert "security-guardrail" in result.get("error", ""), json.dumps(
                    {"target": str(target), "snapshot": descriptions, "actual": result}, ensure_ascii=False)
            assert not list((workspace / "protected").iterdir())
    finally:
        alias.rmdir()


@pytest.mark.platforms("posix")
def test_symlink_matches_target(tmp_path, workspace):
    alias = workspace / "alias"
    alias.symlink_to(workspace / "protected", target_is_directory=True)
    with profile(tmp_path / "home", workspace) as task_id:
        result = write(alias / "linked.txt", task_id)
        assert "security-guardrail" in result["error"], result
        assert not list((workspace / "protected").iterdir())
