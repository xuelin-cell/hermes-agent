"""Final execution authorization is read-only, bounded and veto-first."""

import importlib
import importlib.util
import threading

import pytest

from hermes_cli.plugins import PluginContext, get_plugin_manager
from hermes_cli.plugins_manifest import PluginManifest


@pytest.fixture
def policy():
    assert importlib.util.find_spec("hermes_cli.plugins_execution") is not None, "Final execution authorization is missing"
    api = importlib.import_module("hermes_cli.plugins_execution")
    manager = get_plugin_manager()
    manager.discover_and_load(force=True)
    ctx = PluginContext(PluginManifest(name="execution-policy-test"), manager)
    registrations = []

    def register(callback):
        registrations.append(ctx.register_hook("pre_tool_execute", callback))

    yield api, register
    for registration in registrations:
        registration.dispose()


def test_final_snapshot_is_detached_and_deeply_readonly(policy):
    api, register = policy
    args = {"items": [{"path": "original"}]}
    execution = api.PreparedToolExecution(tool_name="example", arguments=args)
    args["items"][0]["path"] = "changed"
    seen = []

    def inspect(execution):
        seen.append(execution.arguments["items"][0]["path"])
        execution.arguments["items"][0]["path"] = "mutated"

    register(inspect)
    assert api.enforce_tool_execution(execution)
    assert seen == ["original"]


def test_any_veto_precedes_approval(policy, monkeypatch):
    api, register = policy
    register(lambda **kw: {"action": "approve", "message": "confirm", "rule_key": "one"})
    register(lambda **kw: {"action": "block", "message": "veto"})
    from tools import approval
    monkeypatch.setattr(approval, "request_tool_approval", lambda *a, **kw: pytest.fail("veto must prevent approval"))
    assert api.enforce_tool_execution(api.PreparedToolExecution(tool_name="example", arguments={})) == "veto"


def test_modify_directive_is_invalid_at_final_boundary(policy):
    api, register = policy
    register(lambda **kw: {"action": "modify", "args": {"path": "other"}})
    assert api.enforce_tool_execution(api.PreparedToolExecution(tool_name="example", arguments={}))


def test_hung_final_policy_fails_closed(policy, monkeypatch):
    api, register = policy
    from hermes_cli import plugins
    monkeypatch.setattr(plugins, "_resolve_hook_callback_timeout", lambda: 0.05)
    release = threading.Event()
    register(lambda **kw: release.wait(5))
    try:
        assert api.enforce_tool_execution(api.PreparedToolExecution(tool_name="example", arguments={}))
    finally:
        release.set()


def test_approval_binds_final_input_even_without_plugin_key(policy, monkeypatch):
    api, register = policy
    register(lambda **kw: {"action": "approve", "message": "static reason"})
    from tools import approval
    keys = []
    def approve(*args, **kwargs):
        keys.append(kwargs["rule_key"])
        return {"approved": True}
    monkeypatch.setattr(approval, "request_tool_approval", approve)
    for scope, value in (("A", "first"), ("A", "first"), ("A", "second"), ("B", "first")):
        execution = api.PreparedToolExecution(tool_name="example", arguments={"value": value}, profile_scope=scope)
        assert api.enforce_tool_execution(execution) is None
    assert keys[0] == keys[1]
    assert len(set(keys)) == 3
    assert all("first" not in key and "second" not in key for key in keys)
