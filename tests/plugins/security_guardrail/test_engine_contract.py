"""Behavior contracts for the migrated engine, before Hermes tool wiring."""

import importlib
import importlib.util
import json
from pathlib import Path


def test_installed_engine_has_internal_contract(candidate):
    assert importlib.util.find_spec(candidate.__name__ + ".contracts") is not None, "Candidate has no migrated engine contract"
    contracts = importlib.import_module(candidate.__name__ + ".contracts")
    types = importlib.import_module(candidate.__name__ + ".guardrail.types")
    result = contracts.evaluate_tool_call(contracts.GuardrailRequest(
        tool_name="Write", args={"file_path": "/workspace/note.txt", "content": "hello"},
        profile=types.BuildProfile.LITE, operating_system=types.OperatingSystem.LINUX,
        cwd="/workspace", workspace_root="/workspace", mode=types.PermissionMode.AUTO,
    ))
    assert result.behavior == types.DecisionBehavior.ALLOW


def test_registered_rule_semantics_match_source_inventory(candidate):
    registry = importlib.import_module(candidate.__name__ + ".guardrail.baseline_rules")
    manifest = Path(__file__).resolve().parents[3] / "docs/guardrail/evidence/phase2-task1/source-manifest.json"
    source = json.loads(manifest.read_text(encoding="utf-8"))["rules"]
    actual = [(r.id, r.verdict.value, r.category.value, r.reason, r.rule_set.value,
               sorted(os.value for os in r.operating_systems)) for r in registry.ALL_RULES]
    expected = [(r["id"], r["verdict"], r["category"], r["reason"], r["rule_set"], r["operating_systems"]) for r in source]
    assert actual == expected
