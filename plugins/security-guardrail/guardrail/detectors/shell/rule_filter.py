"""Shell-only command candidate filtering."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...baseline_rules.shell.command_scope import (
    SHELL_COMMAND_SCOPES,
    ShellCommandScope,
    ShellCommandScopeKind,
)

if TYPE_CHECKING:
    from ...baseline_rules.selection import ActiveRuleSet
    from .profile import ShellCommandProfile


def filter_rules_for_shell_commands(
    active_rules: ActiveRuleSet,
    command_profile: ShellCommandProfile,
) -> ActiveRuleSet:
    """Narrow shell rules by necessary command scope, retaining uncertain parses."""
    if not command_profile.invocations:
        return active_rules

    command_names = frozenset(invocation.canonical_name.casefold() for invocation in command_profile.invocations)
    executables = tuple(invocation.executable.strip().strip("\"'`").casefold() for invocation in command_profile.invocations)

    return active_rules.filter(
        lambda rule: _scope_matches(SHELL_COMMAND_SCOPES[rule.id], command_names, executables),
    )


def _scope_matches(
    scope: ShellCommandScope,
    command_names: frozenset[str],
    executables: tuple[str, ...],
) -> bool:
    if scope.kind == ShellCommandScopeKind.ANY:
        return True
    if scope.kind == ShellCommandScopeKind.NAMES:
        return not scope.values.isdisjoint(command_names)
    return any(executable.endswith(tuple(scope.values)) for executable in executables)
