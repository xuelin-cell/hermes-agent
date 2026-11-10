"""Map prepared Hermes executions to the migrated, host-independent engine."""

from collections.abc import Mapping
import hashlib
import json
from pathlib import Path

from ..contracts import GuardrailRequest, evaluate_tool_call
from ..guardrail.runtime import ExecutionEnvironment
from ..guardrail.types import BuildProfile, DecisionBehavior, PermissionMode, operating_system_from_platform
from .mapping import map_execution
from .policy import parse_user_rules, policy_key, session_rules


def _plain(value):
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_plain(item) for item in value]
    return value


def _settings(ctx):
    configured = ctx.get_config("protected_directory", "")
    roots = ctx.get_config("protected_roots", [])
    if not isinstance(roots, list):
        raise ValueError("protected_roots must be a list")
    roots = [*roots, *([configured] if configured else [])]
    if not roots:
        raise ValueError("configure protected_directory or protected_roots")
    resolved = []
    for root in roots:
        if not isinstance(root, str) or root.startswith(("\\\\", "//")) or not Path(root).is_absolute():
            raise ValueError("protection roots require absolute local directories")
        resolved.append(str(Path(root).resolve()))
    mode = PermissionMode(ctx.get_config("mode", "ask"))
    build = ctx.get_config("build_profile", "common")
    profile = None if build == "common" else BuildProfile(build)
    return tuple(resolved), mode, profile


def before_execute(ctx, execution):
    """Errors block without echoing raw input or detector findings."""
    try:
        return _decide(ctx, execution)
    except Exception as exc:
        return {"action": "block", "message": f"security-guardrail: execution inspection failed ({type(exc).__name__})"}


def _decide(ctx, execution):
    local_required = execution.tool_name in {"write_file", "patch", "terminal", "read_file", "search_files"}
    if local_required and (execution.backend != "local" or not execution.cwd or not execution.workspace_root
                           or operating_system_from_platform(execution.operating_system) is None):
        raise ValueError("inspection requires a prepared local execution environment")
    roots, mode, profile = _settings(ctx)
    user_rules = parse_user_rules(ctx.get_config("user_rules", []))
    allowances = session_rules(execution.profile_scope, execution.session_id or execution.task_id)
    inspected_scripts = []
    def read_script(path, limit):
        if execution.capabilities.read_script is None:
            raise ValueError("script inspection is unavailable")
        data = execution.capabilities.read_script(path, limit)
        inspected_scripts.append((path, hashlib.sha256(data).hexdigest() if data is not None else None))
        return data
    environment = ExecutionEnvironment(
        # A persistent Bash snapshot may have changed these since env creation.
        # Literal script paths are inspectable; unproven shell expansions fail closed.
        home=None if execution.tool_name == "terminal" else execution.environment.get("HOME"),
        appdata_root=None if execution.tool_name == "terminal" else execution.environment.get("APPDATA"),
        local_appdata_root=None if execution.tool_name == "terminal" else execution.environment.get("LOCALAPPDATA"),
        variables={} if execution.tool_name == "terminal" else execution.environment,
        script_reader=read_script,
        exists=execution.capabilities.exists, is_directory=execution.capabilities.is_directory,
        resolve_path=execution.capabilities.resolve_path if execution.tool_name == "terminal" else None,
    )
    decisions = []
    requests = map_execution(execution, _plain(execution.arguments))
    for tool_name, args, operation in requests:
        decisions.append(evaluate_tool_call(GuardrailRequest(
            tool_name=tool_name, args=args,
            profile=profile, mode=mode, operating_system=operating_system_from_platform(execution.operating_system),
            cwd=execution.cwd, workspace_root=execution.workspace_root, protected_roots=roots,
            operation=operation, environment=environment,
            tool_call_id=execution.tool_call_id,
            user_rules=user_rules, session_rules=allowances,
        )))
    result = next((decision for decision in decisions if decision.behavior == DecisionBehavior.DENY), None)
    if result is None:
        result = next((decision for decision in decisions if decision.behavior == DecisionBehavior.ASK), None)
    if result is None:
        return None
    # Only static rule metadata is displayed; user input and matched secrets stay out.
    policy_source = result.source or (result.reason.rule.source.value if result.reason.rule else "policy")
    message = "security-guardrail: " + (", ".join(result.rule_ids) or policy_source)
    if result.rule_ids:
        from ..guardrail.baseline_rules.registry import rule_by_id
        message += ": " + rule_by_id(result.rule_ids[0]).reason
    if result.behavior == DecisionBehavior.DENY:
        return {"action": "block", "message": message}
    key_data = dict(tool=execution.tool_name, arguments=_plain(execution.arguments),
                    targets=[(target.operation, target.path, target.role) for target in execution.targets],
                    backend=execution.backend, cwd=execution.cwd, workspace=execution.workspace_root,
                    task=execution.task_id, session=execution.session_id, scope=execution.profile_scope, rules=result.rule_ids,
                    roots=roots, mode=mode.value, build=profile.value if profile else "common",
                    user_rules=policy_key(user_rules), session_rules=policy_key(allowances), policy_version=1)
    key_data["inspected_scripts"] = inspected_scripts
    key = hashlib.sha256(json.dumps(key_data, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    return {"action": "approve", "message": message, "rule_key": "security-guardrail:" + key}
