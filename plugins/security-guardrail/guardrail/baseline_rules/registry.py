"""Global registry and validation for new safety baseline rules."""

from __future__ import annotations

import re
from functools import lru_cache
from typing import TYPE_CHECKING

from . import data, filesystem, network, shell, tool
from .core import BaselineRuleDefinition, rule_applies_to_profile
from ..signals import BaselineVerdict
from ..types import OperatingSystem

if TYPE_CHECKING:
    from ..types import BuildProfile

_RULE_ID_RE = re.compile(r"^(?:common|lite|pro)\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$")

ALL_RULES: tuple[BaselineRuleDefinition, ...] = (
    *tool.RULES,
    *filesystem.RULES,
    *network.RULES,
    *data.RULES,
    *shell.RULES,
)


def rule_by_id(rule_id: str) -> BaselineRuleDefinition:
    """Return one registered rule or fail for an unknown id."""
    try:
        return _rule_index()[rule_id]
    except KeyError as exc:
        message = f"unknown baseline rule id: {rule_id!r}"
        raise KeyError(message) from exc


def rules_for_profile(profile: BuildProfile) -> tuple[BaselineRuleDefinition, ...]:
    """Return common rules plus additions for the selected build."""
    return tuple(rule for rule in ALL_RULES if rule_applies_to_profile(rule, profile))


@lru_cache(maxsize=1)
def _rule_index() -> dict[str, BaselineRuleDefinition]:
    index: dict[str, BaselineRuleDefinition] = {}
    for rule in ALL_RULES:
        if not _RULE_ID_RE.fullmatch(rule.id):
            message = f"invalid baseline rule id: {rule.id!r}"
            raise ValueError(message)
        if rule.id in index:
            message = f"duplicate baseline rule id: {rule.id!r}"
            raise ValueError(message)
        if not rule.reason.strip():
            message = f"baseline rule has no reason: {rule.id!r}"
            raise ValueError(message)
        if not rule.operating_systems:
            message = f"baseline rule has no operating systems: {rule.id!r}"
            raise ValueError(message)
        if not all(isinstance(operating_system, OperatingSystem) for operating_system in rule.operating_systems):
            message = f"baseline rule has invalid operating systems: {rule.id!r}"
            raise TypeError(message)
        if rule.verdict != BaselineVerdict.NO_SIGNAL and not any("\u4e00" <= char <= "\u9fff" for char in rule.reason):
            message = f"signal rule reason must contain Chinese text: {rule.id!r}"
            raise ValueError(message)
        index[rule.id] = rule
    return index


# Validate eagerly so invalid or duplicate definitions cannot start Guardrail.
_rule_index()
