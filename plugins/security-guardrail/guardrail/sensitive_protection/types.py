"""Inputs and value-only outputs for explicit sensitive text inspection."""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal, TypedDict

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import date

DetectionMethod = Literal["keyword", "regex", "entropy", "validation", "context"]


class SensitiveUnavailableError(Exception):
    """The fixed rule catalog cannot be safely executed."""

    def __init__(self) -> None:
        """Keep resource failures independent of any inspected value."""
        super().__init__("Sensitive detection rules are unavailable.")


@dataclass(frozen=True)
class SensitivePolicySnapshot:
    """Immutable settings and an explicit reference date for one inspection."""

    revision: int
    enabled: bool
    rule_overrides: Mapping[str, bool]
    reference_date: date

    def __post_init__(self) -> None:
        """Detach caller-owned settings before inspecting text."""
        object.__setattr__(self, "rule_overrides", MappingProxyType(dict(self.rule_overrides)))


class SensitiveFinding(TypedDict):
    """One confirmed occurrence; values must never be written to ordinary logs."""

    rule_id: str
    methods: list[DetectionMethod]
    original_text: str
    original_value: str
    protected_value: str


class SensitiveDetectionResult(TypedDict):
    """Inspection output without persistence or a modified full-text result."""

    enabled: bool
    findings: list[SensitiveFinding]
