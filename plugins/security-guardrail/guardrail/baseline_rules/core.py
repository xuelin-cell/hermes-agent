"""Core models and result construction for deterministic baseline rules."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from ..signals import BaselineResult, BaselineVerdict, RiskCategory
from ..types import ALL_OPERATING_SYSTEMS, BuildProfile, OperatingSystem


class BaselineRuleSet(str, Enum):
    """Build applicability of a baseline rule."""

    COMMON = "common"
    LITE_EXTRA = "lite_extra"
    PRO_EXTRA = "pro_extra"


@dataclass(frozen=True)
class BaselineRuleDefinition:
    """Immutable metadata for one globally identified baseline rule.

    ``operating_systems`` identifies supported execution environments; an
    unknown runtime OS intentionally checks every rule.
    """

    id: str
    verdict: BaselineVerdict
    category: RiskCategory
    reason: str
    rule_set: BaselineRuleSet = BaselineRuleSet.COMMON
    operating_systems: frozenset[OperatingSystem] = ALL_OPERATING_SYSTEMS


def terminal_rule(
    rule_id: str,
    category: RiskCategory,
    reason: str,
    *,
    rule_set: BaselineRuleSet = BaselineRuleSet.COMMON,
    operating_systems: frozenset[OperatingSystem] = ALL_OPERATING_SYSTEMS,
) -> BaselineRuleDefinition:
    """Create a terminal-deny rule definition."""
    return BaselineRuleDefinition(
        id=rule_id,
        verdict=BaselineVerdict.TERMINAL_DENY,
        category=category,
        reason=reason,
        rule_set=rule_set,
        operating_systems=operating_systems,
    )


def ask_rule(
    rule_id: str,
    category: RiskCategory,
    reason: str,
    *,
    rule_set: BaselineRuleSet = BaselineRuleSet.COMMON,
    operating_systems: frozenset[OperatingSystem] = ALL_OPERATING_SYSTEMS,
) -> BaselineRuleDefinition:
    """Create a user-approval rule definition."""
    return BaselineRuleDefinition(
        id=rule_id,
        verdict=BaselineVerdict.ASK_REQUIRED,
        category=category,
        reason=reason,
        rule_set=rule_set,
        operating_systems=operating_systems,
    )


def result_for(
    rule: BaselineRuleDefinition,
    action: object,
    *,
    rule_content: str = "",
    reason: str | None = None,
) -> BaselineResult:
    """Build a result if the rule is active for the action profile and OS."""
    if not rule_applies_to_profile(rule, getattr(action, "profile", None)):
        return BaselineResult.no_signal()
    if not rule_applies_to_operating_system(rule, getattr(action, "operating_system", None)):
        return BaselineResult.no_signal()

    resolved_reason = reason or rule.reason
    if not any("\u4e00" <= char <= "\u9fff" for char in resolved_reason):
        message = f"signal result reason must contain Chinese text: {rule.id!r}"
        raise ValueError(message)

    return BaselineResult(
        verdict=rule.verdict,
        category=rule.category,
        rule_id=rule.id,
        reason=resolved_reason,
        rule_content=(rule_content or rule.id) if rule.verdict == BaselineVerdict.TERMINAL_DENY else "",
    )


def rule_applies_to_profile(rule: BaselineRuleDefinition, profile: BuildProfile | None) -> bool:
    """Return whether a rule is active for a build profile."""
    if rule.rule_set == BaselineRuleSet.COMMON:
        return True
    if rule.rule_set == BaselineRuleSet.LITE_EXTRA:
        return profile == BuildProfile.LITE
    return profile in {BuildProfile.PRO, BuildProfile.SERVER}


def rule_applies_to_operating_system(
    rule: BaselineRuleDefinition,
    operating_system: OperatingSystem | None,
) -> bool:
    """Return whether a rule applies to an OS, checking all rules if unknown."""
    return operating_system is None or operating_system in rule.operating_systems
