"""Permission decision engine — the ``check_permissions()`` function.

Order of evaluation:

1. Normalize the tool call and enforce terminal baseline denies.
2. Allow fixed read-only tools.
3. Allow privileged internal callers.
4. Apply user deny rules, then user allow rules.
5. Apply session allow rules.
6. In AUTO mode, skip approval-only rules.
7. Apply the original ASK baseline in ASK mode.
8. Default to ALLOW.

The baseline remains deterministic and short-circuits on the first terminal
signal. User and session rules are compiled only when they are evaluated.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .baseline import check_ask_baseline, check_terminal_baseline
from .detectors.shell.delete_exempt import resolve_lite_windows_sessions_delete
from .matcher import compile_rule, match, matches_path
from .normalizer import INHERIT_CWD, normalize_runtime_action
from .signals import BaselineVerdict
from .action import RuntimeOperation
from .types import (
    BuildProfile,
    DecisionBehavior,
    DecisionReason,
    OperatingSystem,
    PermissionDecision,
    PermissionMode,
    PermissionRule,
    RuleBehavior,
    RuleSource,
    RuleValue,
    ToolCallOrigin,
)

if TYPE_CHECKING:
    from .action import RuntimeAction
    from .signals import BaselineResult


# Tools that bypass approval checks after passing the terminal baseline.
# These are read-only operations the agent performs frequently.
ALWAYS_ALLOW_TOOLS = frozenset(
    {
        "Read",
        "Glob",
        "Grep",
        "TodoWrite",
        "TaskOutput",
        "ToolSearch",
        "WebFetch",   # network read
        "WebSearch",  # network read
    }
)


def _extract_command_or_path(tool_name: str, tool_input: dict[str, Any]) -> str:
    """Pull the matchable string out of a tool's input.

    Each tool stores its "thing the user cares about" under a different
    key — Bash uses ``command``, Write/Edit use ``file_path``, etc.
    """
    if tool_name in ("Bash", "PowerShell"):
        return str(tool_input.get("command", ""))
    if tool_name in ("Write", "Edit", "NotebookEdit", "FileWrite", "FileEdit"):
        return str(tool_input.get("file_path", tool_input.get("path", "")))
    # Generic fallback: stringify whatever's in the input.
    return str(tool_input)


def _matches_rule(rule: PermissionRule, tool_name: str, payload: str) -> bool:
    if rule.value.tool_name and rule.value.tool_name != tool_name:
        return False
    pattern = rule.value.rule_content
    if not pattern:
        # Tool-level rule (no content) — matches any call to that tool.
        return True
    # File path tools use path-glob semantics; everything else is wildcard.
    if tool_name in ("Write", "Edit", "NotebookEdit", "FileWrite", "FileEdit"):
        return matches_path(pattern, payload)
    # Wildcard / prefix matching for shell-like tools.
    return match(compile_rule(pattern, case_insensitive=(tool_name == "PowerShell")), payload)


def check_permissions(
    *,
    tool_name: str,
    tool_input: dict[str, Any],
    origin: ToolCallOrigin,
    profile: BuildProfile,
    mode: PermissionMode,
    user_rules: list[PermissionRule],
    session_rules: list[PermissionRule],
    cwd: str | None = None,
    tool_call_id: str = "",
    operating_system: OperatingSystem | None = None,
    app_dir: str | None = None,
    app_dir_exclusions: tuple[str, ...] = (),
    appdata_root: str | None = None,
    workspace_root: str | None | object = INHERIT_CWD,
    operation: RuntimeOperation | None = None,
) -> PermissionDecision:
    """Snapshot trusted environment for both live gates and ASK re-derivation.

    Environment values are explicit; no product or process environment is read.
    """
    return _check_permissions(
        tool_name=tool_name,
        tool_input=tool_input,
        origin=origin,
        profile=profile,
        mode=mode,
        user_rules=user_rules,
        session_rules=session_rules,
        cwd=cwd,
        tool_call_id=tool_call_id,
        operating_system=operating_system,
        app_dir=app_dir,
        app_dir_exclusions=app_dir_exclusions,
        appdata_root=appdata_root,
        workspace_root=workspace_root,
        operation=operation,
    )


def _check_permissions(  # noqa: PLR0911, PLR0912 - Each ordered policy tier returns its decision.
    *,
    tool_name: str,
    tool_input: dict[str, Any],
    origin: ToolCallOrigin,
    profile: BuildProfile,
    mode: PermissionMode,
    user_rules: list[PermissionRule],
    session_rules: list[PermissionRule],
    cwd: str | None = None,
    tool_call_id: str = "",
    operating_system: OperatingSystem | None = None,
    app_dir: str | None = None,
    app_dir_exclusions: tuple[str, ...] = (),
    appdata_root: str | None = None,
    workspace_root: str | None | object = INHERIT_CWD,
    operation: RuntimeOperation | None = None,
) -> PermissionDecision:
    """Compute a permission decision from explicit inputs.

    Rule ordering is deterministic. Host inspection capabilities and all
    permission state are supplied explicitly for the evaluation.

    Args:
        tool_name: e.g. ``"Bash"``, ``"Write"``.
        tool_input: The tool's raw input dict.
        origin: Where this call came from (privileged channel detection).
        profile: Pro / Lite / Server.  Selects which rule sets are active.
        mode: ASK or AUTO.  AUTO skips the built-in approval list (only
              hard-deny stays active).
        user_rules: User's Level 4 persisted rules.  Allow + deny mixed.
        session_rules: Level 5 in-memory rules from this conversation.
        cwd: Current workspace directory, if known.
        tool_call_id: Model-emitted tool call id, if known.
        operating_system: Normalized tool execution OS, or unknown.
        app_dir: Validated product installation root, when protection is active.
        app_dir_exclusions: Strict subdirectories excluded from installation protection.
        appdata_root: Trusted APPDATA snapshot for Lite Windows session cleanup.
        workspace_root: Security boundary, separate from the execution cwd.
        operation: Trusted semantic operation supplied by the host.

    Returns:
        ``PermissionDecision`` — caller decides what to do with ASK.
    """
    action = normalize_runtime_action(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        tool_input=tool_input,
        cwd=cwd,
        workspace_root=workspace_root,
        operation=operation,
        origin=origin,
        profile=profile,
        mode=mode,
        operating_system=operating_system,
        app_dir=app_dir,
        app_dir_exclusions=app_dir_exclusions,
    )
    inspection_action = resolve_lite_windows_sessions_delete(action, appdata_root=appdata_root)
    baseline = check_terminal_baseline(action)
    if baseline.verdict != BaselineVerdict.TERMINAL_DENY and inspection_action is not action:
        baseline = check_terminal_baseline(inspection_action)
    if baseline.verdict == BaselineVerdict.TERMINAL_DENY:
        return _deny_from_baseline(action, baseline)

    # User/session rules still match the original command, never the check copy.
    payload = action.normalized_payload

    # 2. Always-allow tools (Read/Glob/Grep/...) — never look at approval rules.
    if tool_name in ALWAYS_ALLOW_TOOLS:
        return PermissionDecision(
            behavior=DecisionBehavior.ALLOW,
            reason=DecisionReason(kind="default", detail="工具白名单"),
            source="default",
        )

    # 3. Privileged channel — internal / trusted callers bypass approval rules.
    if origin.kind != "agent":
        origin_detail = {
            "builtin_skill": "内置技能调用",
            "trusted_mcp": "可信 MCP 调用",
            "system": "系统调用",
        }[origin.kind]
        if origin.kind == "builtin_skill" and origin.skill_id:
            origin_detail += f"（技能：{origin.skill_id}）"  # noqa: RUF001 - Chinese UI punctuation.
        elif origin.kind == "trusted_mcp" and origin.mcp_server_id:
            origin_detail += f"（服务：{origin.mcp_server_id}）"  # noqa: RUF001 - Chinese UI punctuation.
        return PermissionDecision(
            behavior=DecisionBehavior.ALLOW,
            reason=DecisionReason(kind="privileged", detail=origin_detail),
            source="default",
        )

    # 4. User permanent rules: deny first, then allow. Within a tier
    #      deny always wins.
    for rule in user_rules:
        if rule.behavior == RuleBehavior.DENY and _matches_rule(rule, tool_name, payload):
            return PermissionDecision(
                behavior=DecisionBehavior.DENY,
                reason=DecisionReason(kind="rule", rule=rule, detail="用户拒绝规则"),
            )
    for rule in user_rules:
        if rule.behavior == RuleBehavior.ALLOW and _matches_rule(rule, tool_name, payload):
            return PermissionDecision(
                behavior=DecisionBehavior.ALLOW,
                reason=DecisionReason(kind="rule", rule=rule, detail="用户允许规则"),
                source="user_rule",
            )

    # 5. Session-level allows.
    for rule in session_rules:
        if rule.behavior == RuleBehavior.ALLOW and _matches_rule(rule, tool_name, payload):
            return PermissionDecision(
                behavior=DecisionBehavior.ALLOW,
                reason=DecisionReason(kind="rule", rule=rule, detail="会话权限规则"),
                source="session_rule",
            )

    # 6. AUTO mode -> skip approval list, default-allow.
    if mode == PermissionMode.AUTO:
        return PermissionDecision(
            behavior=DecisionBehavior.ALLOW,
            reason=DecisionReason(kind="mode_auto", detail="自动模式"),
            source="default",
        )

    # 7. Security-center per-rule settings are excluded. ASK mode runs the
    # original applicable ASK baseline directly, after all preceding tiers.
    ask_baseline = check_ask_baseline(inspection_action)
    if ask_baseline.verdict == BaselineVerdict.ASK_REQUIRED:
        return PermissionDecision(
            behavior=DecisionBehavior.ASK,
            reason=DecisionReason(kind="rule", detail=ask_baseline.reason),
            source="ask_baseline",
            rule_ids=(ask_baseline.rule_id,),
            category=ask_baseline.category.value,
        )

    # 8. Default: allow. This is the path most normal operations take.
    return PermissionDecision(
        behavior=DecisionBehavior.ALLOW,
        reason=DecisionReason(kind="default", detail="未触发限制规则"),
        source="default",
    )


def _deny_from_baseline(action: RuntimeAction, baseline: BaselineResult) -> PermissionDecision:
    """Convert a terminal baseline result to the existing decision shape."""
    pseudo_rule = PermissionRule(
        source=RuleSource.BUILTIN_HARD,
        behavior=RuleBehavior.DENY,
        value=RuleValue(tool_name=action.tool_name, rule_content=baseline.rule_content or baseline.rule_id),
        reason=baseline.reason,
        category=baseline.category.value,
    )
    return PermissionDecision(
        behavior=DecisionBehavior.DENY,
        reason=DecisionReason(kind="rule", rule=pseudo_rule, detail=baseline.reason),
        source="terminal_baseline",
        rule_ids=(baseline.rule_id,),
        category=baseline.category.value,
    )
