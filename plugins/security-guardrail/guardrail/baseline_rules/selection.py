"""Selection helpers for deterministic baseline rule evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from .core import (
    BaselineRuleDefinition,
    rule_applies_to_operating_system,
    rule_applies_to_profile,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from ..signals import BaselineVerdict
    from ..types import BuildProfile, OperatingSystem


@dataclass(frozen=True)
class ActiveRuleSet:
    """Ordered baseline rules selected for one evaluation phase."""

    rules: tuple[BaselineRuleDefinition, ...]
    rule_ids: frozenset[str]

    @classmethod
    def from_rules(cls, rules: Iterable[BaselineRuleDefinition]) -> ActiveRuleSet:
        """Build an immutable ordered selection from rule definitions."""
        ordered = tuple(rules)
        return cls(rules=ordered, rule_ids=frozenset(rule.id for rule in ordered))

    def contains(self, rule: BaselineRuleDefinition | str) -> bool:
        """Return whether a rule definition or id is selected."""
        rule_id = rule if isinstance(rule, str) else rule.id
        return rule_id in self.rule_ids

    def filter(self, predicate: Callable[[BaselineRuleDefinition], bool]) -> ActiveRuleSet:
        """Return a selection retaining rules accepted by ``predicate``."""
        return ActiveRuleSet.from_rules(rule for rule in self.rules if predicate(rule))

    def intersect(self, rules: Iterable[BaselineRuleDefinition]) -> ActiveRuleSet:
        """Intersect with another rule collection while preserving selection order."""
        allowed_ids = frozenset(rule.id for rule in rules)
        return self.filter(lambda rule: rule.id in allowed_ids)

    def isdisjoint(self, rule_ids: Iterable[str]) -> bool:
        """Return whether none of the supplied rule ids are selected."""
        return self.rule_ids.isdisjoint(rule_ids)


def select_active_rules(
    rules: Iterable[BaselineRuleDefinition],
    *,
    profile: BuildProfile,
    operating_system: OperatingSystem | None,
    verdict: BaselineVerdict,
) -> ActiveRuleSet:
    """Select rules by build profile, execution OS, and evaluation verdict."""
    return ActiveRuleSet.from_rules(
        rule
        for rule in rules
        if rule_applies_to_profile(rule, profile) and rule_applies_to_operating_system(rule, operating_system) and rule.verdict == verdict
    )
