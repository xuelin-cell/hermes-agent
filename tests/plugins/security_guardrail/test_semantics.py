"""Host context, decision ordering and deliberate ASK migration differences."""

from dataclasses import replace
import importlib

import pytest


def api(candidate):
    name = candidate.__name__
    contracts = importlib.import_module(name + ".contracts")
    types = importlib.import_module(name + ".guardrail.types")
    runtime = importlib.import_module(name + ".guardrail.runtime")
    return contracts, types, runtime


def request(contracts, types, **changes):
    values = dict(tool_name="Write", args={"file_path": "/workspace/a.txt", "content": "hello"},
                  profile=types.BuildProfile.LITE, operating_system=types.OperatingSystem.LINUX,
                  cwd="/workspace", workspace_root="/workspace", mode=types.PermissionMode.ASK)
    values.update(changes)
    return contracts.GuardrailRequest(**values)


def rule(types, behavior, tool="Write"):
    return types.PermissionRule(source=types.RuleSource.USER, behavior=behavior,
                                value=types.RuleValue(tool_name=tool))


def test_hard_deny_precedes_auto_trusted_origin_and_user_allow(candidate):
    contracts, types, _ = api(candidate)
    req = request(contracts, types, protected_roots=("/workspace",), mode=types.PermissionMode.AUTO,
                  origin=types.ToolCallOrigin(kind="system"),
                  user_rules=(rule(types, types.RuleBehavior.ALLOW),))
    result = contracts.evaluate_tool_call(req)
    assert result.behavior == types.DecisionBehavior.DENY
    assert result.rule_ids == ("common.filesystem.product_install_dir_access",)


def test_user_deny_precedes_allow_and_allow_precedes_ask(candidate):
    contracts, types, _ = api(candidate)
    req = request(contracts, types, args={"file_path": "/external/a.txt"})
    ask = contracts.evaluate_tool_call(req)
    assert ask.behavior == types.DecisionBehavior.ASK
    allow = rule(types, types.RuleBehavior.ALLOW)
    deny = rule(types, types.RuleBehavior.DENY)
    assert contracts.evaluate_tool_call(replace(req, user_rules=(allow,))).behavior == types.DecisionBehavior.ALLOW
    assert contracts.evaluate_tool_call(replace(req, user_rules=(allow, deny))).behavior == types.DecisionBehavior.DENY
    assert contracts.evaluate_tool_call(replace(req, mode=types.PermissionMode.AUTO)).behavior == types.DecisionBehavior.ALLOW


def test_final_cwd_does_not_redefine_workspace_boundary(candidate):
    contracts, types, _ = api(candidate)
    req = request(contracts, types, tool_name="Bash", args={"command": "touch report.txt"},
                  cwd="/external", workspace_root="/workspace")
    result = contracts.evaluate_tool_call(req)
    assert result.behavior == types.DecisionBehavior.ASK
    assert result.rule_ids == ("common.filesystem.workspace_external_mutation",)
    assert contracts.evaluate_tool_call(replace(req, cwd="/workspace")).behavior == types.DecisionBehavior.ALLOW


def test_delete_operation_is_preserved_separately_from_write(candidate):
    contracts, types, _ = api(candidate)
    actions = importlib.import_module(candidate.__name__ + ".guardrail.action")
    req = request(contracts, types)
    assert contracts.evaluate_tool_call(req).behavior == types.DecisionBehavior.ALLOW
    deletion = contracts.evaluate_tool_call(replace(req, operation=actions.RuntimeOperation.DELETE))
    assert deletion.behavior == types.DecisionBehavior.ASK
    assert deletion.rule_ids == ("common.filesystem.delete_mutation",)


def test_process_product_variables_cannot_select_profile_or_protection(candidate, monkeypatch):
    contracts, types, _ = api(candidate)
    monkeypatch.setenv("HEXAGENT_BUILD_VARIANT", "pro")
    monkeypatch.setenv("HEXAGENT_APP_DIR", "/workspace")
    monkeypatch.setenv("APPDATA", "C:/untrusted-process-profile")
    req = request(contracts, types, profile=None, mode=types.PermissionMode.AUTO)
    assert contracts.evaluate_tool_call(req).behavior == types.DecisionBehavior.ALLOW
    assert contracts.evaluate_tool_call(replace(req, protected_roots=("/workspace",))).behavior == types.DecisionBehavior.DENY


def test_explicit_script_reader_is_bounded_and_required(candidate):
    contracts, types, runtime = api(candidate)
    req = request(contracts, types, tool_name="Bash", args={"command": "python helper.py"}, mode=types.PermissionMode.AUTO)
    with pytest.raises(runtime.ContextUnavailableError):
        contracts.evaluate_tool_call(req)
    calls = []

    def reader(path, limit):
        calls.append((path, limit))
        return b"print('hello')"

    result = contracts.evaluate_tool_call(replace(req, environment=runtime.ExecutionEnvironment(script_reader=reader)))
    assert result.behavior == types.DecisionBehavior.ALLOW
    # One extra byte distinguishes an oversized script from an exact-size script.
    assert calls and all(path == "/workspace/helper.py" and 0 < limit <= 1024 * 1024 + 1 for path, limit in calls)
    oversized = runtime.ExecutionEnvironment(script_reader=lambda path, limit: b"x" * limit)
    with pytest.raises(runtime.ContextUnavailableError):
        contracts.evaluate_tool_call(replace(req, environment=oversized))
    with pytest.raises(runtime.ContextUnavailableError):
        contracts.evaluate_tool_call(req)


def test_product_exemptions_need_explicit_context_and_do_not_leak(candidate):
    _, _, runtime = api(candidate)
    paths = importlib.import_module(candidate.__name__ + ".guardrail.path_policy")
    target = "C:/profile-a/hexagent/skills/public/example/script.ps1"
    assert not paths.is_hexagent_public_skill_descendant(target)
    for root, expected in (("C:/profile-a", True), ("C:/profile-b", False), ("C:/profile-a", True)):
        with runtime.use_execution_environment(runtime.ExecutionEnvironment(appdata_root=root, product_exemptions=True)):
            assert paths.is_hexagent_public_skill_descendant(target) == expected
    assert not paths.is_hexagent_public_skill_descendant(target)


@pytest.mark.parametrize("roots", ["/workspace", ("relative",), ("",), ("/",), ("C:/",),
                                  ("/workspace/../protected",), ("/workspace/./protected",)])
def test_invalid_protection_roots_are_not_silently_ignored(candidate, roots):
    contracts, types, _ = api(candidate)
    with pytest.raises(ValueError):
        request(contracts, types, protected_roots=roots)
