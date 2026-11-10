"""Terminal-deny and approval-baseline enforcement."""

from __future__ import annotations

from functools import partial
from typing import TYPE_CHECKING

from .action import TargetKind, ToolType
from .baseline_rules import ALL_RULES, ActiveRuleSet, select_active_rules
from .baseline_rules import data as data_rules
from .baseline_rules import filesystem as filesystem_rules
from .baseline_rules import network as network_rules
from .baseline_rules import shell as shell_rules
from .baseline_rules import tool as tool_rules
from .detectors import data, filesystem, network, shell, tool
from .signals import BaselineResult, BaselineVerdict

if TYPE_CHECKING:
    from collections.abc import Callable

    from .action import RuntimeAction


def check_terminal_baseline(action: RuntimeAction) -> BaselineResult:
    """Run only terminal-deny detectors used by the current engine."""
    active_rules = select_active_rules(
        ALL_RULES,
        profile=action.profile,
        operating_system=action.operating_system,
        verdict=BaselineVerdict.TERMINAL_DENY,
    )
    for detector in _terminal_detectors_for(action, active_rules):
        result = detector(action)
        if result.verdict == BaselineVerdict.TERMINAL_DENY:
            return result

    return BaselineResult.no_signal()


def check_ask_baseline(action: RuntimeAction, *, active_rules: ActiveRuleSet | None = None) -> BaselineResult:
    """Return the first active rule that requires user approval."""
    if active_rules is None:
        active_rules = select_active_rules(
            ALL_RULES,
            profile=action.profile,
            operating_system=action.operating_system,
            verdict=BaselineVerdict.ASK_REQUIRED,
        )
    for detector in _ask_detectors_for(action, active_rules):
        result = detector(action)
        if result.verdict == BaselineVerdict.ASK_REQUIRED and active_rules.contains(result.rule_id):
            return result

    return BaselineResult.no_signal()


def _terminal_detectors_for(
    action: RuntimeAction,
    active_rules: ActiveRuleSet,
) -> tuple[Callable[[RuntimeAction], BaselineResult], ...]:
    detectors: list[Callable[[RuntimeAction], BaselineResult]] = []
    if not active_rules.isdisjoint(rule.id for rule in tool_rules.TERMINAL_RULES):
        detectors.append(tool.detect_terminal_deny)

    if action.tool_type == ToolType.SHELL:
        shell_active_rules = active_rules.intersect((*shell_rules.RULES, filesystem_rules.PRODUCT_INSTALL_DIR_ACCESS))
        if shell_active_rules.rules:
            detectors.append(partial(shell.detect_terminal_deny, active_rules=shell_active_rules))
    elif action.tool_type == ToolType.FILESYSTEM and not active_rules.isdisjoint(rule.id for rule in filesystem_rules.TERMINAL_RULES):
        detectors.append(filesystem.detect_terminal_deny)
    elif (action.tool_type == ToolType.NETWORK or action.target_kind == TargetKind.URL) and not active_rules.isdisjoint(
        rule.id for rule in network_rules.TERMINAL_RULES
    ):
        detectors.append(network.detect_terminal_deny)

    if (action.tool_type in {ToolType.SHELL, ToolType.NETWORK} or action.network_egress_candidate) and not active_rules.isdisjoint(
        rule.id for rule in data_rules.TERMINAL_RULES
    ):
        detectors.append(data.detect_terminal_deny)
    return tuple(detectors)


def _ask_detectors_for(
    action: RuntimeAction,
    active_rules: ActiveRuleSet,
) -> tuple[Callable[[RuntimeAction], BaselineResult], ...]:
    detectors: list[Callable[[RuntimeAction], BaselineResult]] = []
    if not active_rules.isdisjoint(rule.id for rule in tool_rules.ASK_RULES):
        detectors.append(tool.detect_ask)
    if (action.tool_type in {ToolType.SHELL, ToolType.NETWORK} or action.network_egress_candidate) and not active_rules.isdisjoint(
        rule.id for rule in data_rules.ASK_RULES
    ):
        detectors.append(partial(data.detect_ask, active_rules=active_rules))

    if action.tool_type == ToolType.SHELL:
        shell_active_rules = active_rules.intersect((*shell_rules.ASK_RULES, *filesystem_rules.ASK_RULES))
        if shell_active_rules.rules:
            detectors.append(partial(shell.detect_ask, active_rules=shell_active_rules))
    elif action.tool_type == ToolType.FILESYSTEM and not active_rules.isdisjoint(rule.id for rule in filesystem_rules.ASK_RULES):
        detectors.append(partial(filesystem.detect_ask, active_rules=active_rules))
    return tuple(detectors)
