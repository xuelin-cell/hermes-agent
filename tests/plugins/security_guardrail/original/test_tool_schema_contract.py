"""Port of tool-contract behavior without importing UniClaw product tool classes."""

import pytest

from _guardrail_migrated.contracts import GuardrailRequest, evaluate_tool_call
from _guardrail_migrated.guardrail.types import BuildProfile, DecisionBehavior, OperatingSystem, PermissionMode


@pytest.mark.parametrize(("tool", "args", "rule"), [
    ("Bash", {}, "common.tool.missing_command"),
    ("Write", {}, "common.tool.missing_path"),
    ("WebFetch", {}, "common.tool.missing_url"),
    ("WebSearch", {}, "common.tool.missing_query"),
    ("UnrecognizedTool", {"command": "echo hello"}, "common.tool.unknown_exec_field"),
])
def test_contract_violations_still_deny(tool, args, rule):
    decision = evaluate_tool_call(GuardrailRequest(
        tool_name=tool, args=args, profile=BuildProfile.LITE,
        operating_system=OperatingSystem.LINUX, cwd="/workspace", workspace_root="/workspace",
        mode=PermissionMode.AUTO,
    ))
    assert decision.behavior == DecisionBehavior.DENY
    assert rule in decision.rule_ids
