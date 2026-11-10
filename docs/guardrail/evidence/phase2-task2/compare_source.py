"""Compare offline decisions with the pinned source, without application startup."""

from dataclasses import asdict
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import sys
import types


root = Path(__file__).resolve().parents[4]
manifest = json.loads((root / "docs/guardrail/evidence/phase2-task1/source-manifest.json").read_text(encoding="utf-8"))
source = Path(manifest["source_root"])
for item in manifest["files"]:
    if hashlib.sha256((source / item["source"]).read_bytes()).hexdigest() != item["sha256"]:
        raise SystemExit("Reference source changed: " + item["source"])
base = source / "libs/hexagent/hexagent/harness/guardrail"
for name, path in (("hexagent", base.parents[1]), ("hexagent.harness", base.parent), ("hexagent.harness.guardrail", base)):
    module = types.ModuleType(name)
    module.__path__ = [str(path)]
    sys.modules[name] = module
reference = importlib.import_module("hexagent.harness.guardrail.engine")
old_types = importlib.import_module("hexagent.harness.guardrail.types")
policy_types = importlib.import_module("hexagent.harness.guardrail.configurable")
registry = importlib.import_module("hexagent.harness.guardrail.baseline_rules")
policy = policy_types.AskPolicySnapshot(rule_actions={rule.id: policy_types.AskRuleAction.ASK for rule in registry.ALL_RULES if rule.verdict.value == "ask_required"})

path = root / "plugins/security-guardrail"
spec = importlib.util.spec_from_file_location("candidate_guardrail", path / "__init__.py", submodule_search_locations=[str(path)])
candidate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = candidate
spec.loader.exec_module(candidate)
contracts = importlib.import_module(spec.name + ".contracts")
new_types = importlib.import_module(spec.name + ".guardrail.types")

cases = json.loads((root / "tests/plugins/security_guardrail/original/fixtures/all_ask_cases.json").read_text(encoding="utf-8"))
cases += [
    dict(rule_id="hard-linux", tool_name="Bash", args={"command": "rm -rf /"}, cwd="/workspace", platform="linux", profiles=["lite", "pro", "server"]),
    dict(rule_id="hard-windows", tool_name="PowerShell", args={"command": "format E:"}, cwd="C:/workspace", platform="windows", profiles=["lite", "pro", "server"]),
    dict(rule_id="normal-write", tool_name="Write", args={"file_path": "/workspace/note.txt"}, cwd="/workspace", platform="linux", profiles=["lite", "pro", "server"]),
    dict(rule_id="read-credential", tool_name="Read", args={"file_path": "/etc/shadow"}, cwd="/workspace", platform="linux", profiles=["lite", "pro", "server"]),
]


def summary(decision):
    return dict(behavior=decision.behavior.value, rule_ids=list(decision.rule_ids), source=decision.source, category=decision.category)


results = []
for case in cases:
    for profile in case["profiles"]:
        for mode in ("ask", "auto"):
            before = reference._check_permissions(
                tool_name=case["tool_name"], tool_input=case["args"], origin=old_types.ToolCallOrigin(kind="agent"),
                profile=old_types.BuildProfile(profile), mode=old_types.PermissionMode(mode), user_rules=[], session_rules=[],
                cwd=case["cwd"], operating_system=old_types.operating_system_from_platform(case["platform"]), ask_policy=policy,
            )
            after = contracts.evaluate_tool_call(contracts.GuardrailRequest(
                tool_name=case["tool_name"], args=case["args"], profile=new_types.BuildProfile(profile),
                mode=new_types.PermissionMode(mode), cwd=case["cwd"], workspace_root=case["cwd"],
                operating_system=new_types.operating_system_from_platform(case["platform"]),
            ))
            row = dict(case=case["rule_id"], profile=profile, mode=mode, reference=summary(before), candidate=summary(after))
            if row["reference"] != row["candidate"]:
                raise SystemExit(json.dumps(row, ensure_ascii=False))
            results.append(row)
output = Path(__file__).with_name("source-decision-comparison.json")
output.write_text(json.dumps(dict(source_commit=manifest["source_commit"],
    method="source deterministic engine with all ASK rules configured ASK vs candidate direct ASK; no dangerous commands executed",
    comparisons=results), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(dict(matched=len(results), source_commit=manifest["source_commit"])))
