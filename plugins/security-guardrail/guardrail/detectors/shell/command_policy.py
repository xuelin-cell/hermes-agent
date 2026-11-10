"""Authored command-policy shell detector."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell.commands import (
    ArgumentCondition,
    CommandMatchKind,
    CommandRule,
    lookup_command_policies,
)
from .profile import is_help_or_version_only_invocation, profile_shell_command
from ...signals import BaselineResult, BaselineVerdict

if TYPE_CHECKING:
    from ...action import RuntimeAction
    from ...baseline_rules.selection import ActiveRuleSet
    from .profile import ShellCommandProfile

_HELP_OR_VERSION_ARGS = frozenset({"-?", "-h", "--help", "--version", "/?", "/h", "/help", "help", "version"})


def detect_command_policy_terminal_deny(
    action: RuntimeAction,
    *,
    active_rules: ActiveRuleSet | None = None,
    command_profile: ShellCommandProfile | None = None,
) -> BaselineResult:
    """Deny authored unsafe commands applicable to the execution OS."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()

    profile = command_profile or profile_shell_command(action.normalized_payload)
    for invocation in profile.invocations:
        if is_help_or_version_only_invocation(invocation):
            continue
        for policy in lookup_command_policies(invocation.canonical_name):
            for command_rule in policy.rules:
                rule = command_rule.rule
                if active_rules is not None and not active_rules.contains(rule):
                    continue
                if rule.verdict != BaselineVerdict.TERMINAL_DENY:
                    continue
                if not _command_rule_matches(command_rule, invocation.args):
                    continue
                reason = rule.reason
                if command_rule.include_command_name_in_reason:
                    reason = f"{reason}: {invocation.canonical_name}"
                result = result_for(
                    rule,
                    action,
                    reason=reason,
                    rule_content=f"baseline_rule:{rule.id}",
                )
                if result.verdict == BaselineVerdict.TERMINAL_DENY:
                    return result

    return BaselineResult.no_signal()


def _command_rule_matches(command_rule: CommandRule, args: tuple[str, ...]) -> bool:
    if command_rule.match_kind == CommandMatchKind.COMMAND:
        return True
    if command_rule.condition is None:
        return False
    return _arguments_match(args, command_rule.condition)


def _arguments_match(args: tuple[str, ...], condition: ArgumentCondition) -> bool:
    normalized = tuple(arg.strip().strip("\"'`").casefold() for arg in args)
    values = frozenset(normalized)
    subcommands = _casefolded(condition.subcommands_any)
    required_all = _casefolded(condition.require_all)
    required_any = _casefolded(condition.require_any)
    excluded = _casefolded(condition.exclude_any)
    operand_offset = 1 if condition.subcommands_any else 0

    return not any(
        (
            not values.isdisjoint(_HELP_OR_VERSION_ARGS),
            bool(subcommands) and (not normalized or normalized[0] not in subcommands),
            bool(required_all) and not required_all.issubset(values),
            bool(required_any) and values.isdisjoint(required_any),
            bool(excluded) and not values.isdisjoint(excluded),
            condition.requires_operand and len(normalized) <= operand_offset,
        )
    )


def _casefolded(values: tuple[str, ...]) -> frozenset[str]:
    return frozenset(value.casefold() for value in values)
