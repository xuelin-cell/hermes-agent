"""Source public ASK matrix, expressed through explicit profile/OS inputs."""

import json
from pathlib import Path

import pytest

from _guardrail_migrated.contracts import GuardrailRequest, evaluate_tool_call
from _guardrail_migrated.guardrail.baseline_rules import ALL_RULES
from _guardrail_migrated.guardrail.signals import BaselineVerdict
from _guardrail_migrated.guardrail.types import BuildProfile, DecisionBehavior, PermissionMode, operating_system_from_platform


_CASES = json.loads((Path(__file__).parent / "fixtures/all_ask_cases.json").read_text(encoding="utf-8"))
_ACTIVE = [(case, profile, mode) for case in _CASES for profile in case["profiles"] for mode in PermissionMode]


def test_representative_cases_cover_all_registered_ask_rules():
    assert {case["rule_id"] for case in _CASES} == {rule.id for rule in ALL_RULES if rule.verdict == BaselineVerdict.ASK_REQUIRED}


@pytest.mark.parametrize(("case", "profile", "mode"), _ACTIVE,
                         ids=[f"{case['rule_id']}-{profile}-{mode.value}" for case, profile, mode in _ACTIVE])
def test_original_ask_case_with_explicit_context(case, profile, mode):
    result = evaluate_tool_call(GuardrailRequest(
        tool_name=case["tool_name"], args=case["args"], profile=BuildProfile(profile),
        operating_system=operating_system_from_platform(case["platform"]),
        cwd=case["cwd"], workspace_root=case["cwd"], mode=mode,
    ))
    if mode == PermissionMode.AUTO:
        assert result.behavior == DecisionBehavior.ALLOW, result
    else:
        assert result.behavior == DecisionBehavior.ASK, result
        assert result.rule_ids == (case["rule_id"],)
        assert case["reason_marker"] in result.reason.detail
