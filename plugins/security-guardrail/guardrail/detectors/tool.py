"""Tool-call contract detectors."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..action import RuntimeOperation, TargetKind, ToolType
from ..baseline_rules import result_for
from ..baseline_rules import tool as rules
from ..signals import BaselineResult, BaselineVerdict

if TYPE_CHECKING:
    from collections.abc import Mapping

    from ..action import RuntimeAction
    from ..baseline_rules.core import BaselineRuleDefinition

_READ_FILE_TOOL_NAMES = frozenset({"read", "read_file"})
_EXEC_FIELD_NAMES = frozenset({"command", "cmd", "code", "script", "shell", "powershell", "exec"})


def detect_terminal_deny(action: RuntimeAction) -> BaselineResult:
    """Detect tool-call contract violations that must be denied."""
    result = detect_tool_contract_violation(action)
    if result.verdict == BaselineVerdict.TERMINAL_DENY:
        return result

    result = detect_web_search_domain_filter_contract(action)
    if result.verdict == BaselineVerdict.TERMINAL_DENY:
        return result

    result = detect_unknown_tool(action)
    if result.verdict == BaselineVerdict.TERMINAL_DENY:
        return result

    return BaselineResult.no_signal()


def detect_ask(action: RuntimeAction) -> BaselineResult:
    """Detect explicit tool operations with persistent or public effects."""
    if action.canonical_tool_name == "PublishArtifact":
        operation = str(action.tool_input.get("action", "publish")).strip().casefold()
        if operation == "publish":
            return result_for(rules.PUBLIC_PUBLISH, action)

    return BaselineResult.no_signal()


def detect_tool_contract_violation(action: RuntimeAction) -> BaselineResult:
    """Detect recognized tool calls that are missing required target fields."""
    if action.tool_type == ToolType.SHELL and not action.target_value:
        return _missing_required_field(
            action,
            rules.MISSING_COMMAND,
        )

    if _requires_file_path(action) and not action.target_value:
        return _missing_required_field(
            action,
            rules.MISSING_PATH,
        )

    if action.target_kind == TargetKind.URL and not action.target_value:
        return _missing_required_field(
            action,
            rules.MISSING_URL,
        )

    if action.tool_type == ToolType.NETWORK and action.operation == RuntimeOperation.SEARCH and not action.target_value:
        return _missing_required_field(
            action,
            rules.MISSING_QUERY,
        )

    return BaselineResult.no_signal()


def detect_unknown_tool(action: RuntimeAction) -> BaselineResult:
    """Deny unknown tools that carry an execution-shaped field."""
    if action.tool_type != ToolType.UNKNOWN or not action.tool_input:
        return BaselineResult.no_signal()

    field_names = {key.replace("-", "_").lower() for key in action.tool_input}
    if field_names & _EXEC_FIELD_NAMES:
        return result_for(rules.UNKNOWN_EXEC_FIELD, action, rule_content="unknown_exec_field")

    return BaselineResult.no_signal()


def detect_web_search_domain_filter_contract(action: RuntimeAction) -> BaselineResult:
    """Detect malformed WebSearch domain filter inputs."""
    if action.canonical_tool_name != "WebSearch":
        return BaselineResult.no_signal()

    allowed_domains = _string_list(action.tool_input, "allowed_domains")
    blocked_domains = _string_list(action.tool_input, "blocked_domains")
    if allowed_domains and blocked_domains:
        return result_for(rules.CONFLICTING_DOMAIN_FILTERS, action, rule_content="conflicting_domain_filters")

    return BaselineResult.no_signal()


def _requires_file_path(action: RuntimeAction) -> bool:
    if action.tool_type != ToolType.FILESYSTEM or action.target_kind != TargetKind.PATH:
        return False
    if action.operation == RuntimeOperation.WRITE:
        return True
    return action.operation == RuntimeOperation.READ and action.canonical_tool_name.strip().lower() in _READ_FILE_TOOL_NAMES


def _string_list(tool_input: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = tool_input.get(key)
    if isinstance(value, str):
        value = value.strip()
        return (value,) if value else ()
    if not isinstance(value, list):
        return ()
    return tuple(item.strip() for item in value if isinstance(item, str) and item.strip())


def _missing_required_field(action: RuntimeAction, rule: BaselineRuleDefinition) -> BaselineResult:
    return result_for(rule, action, rule_content=rule.id)
