"""Shared signal types for deterministic guardrail checks."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class BaselineVerdict(str, Enum):
    """Outcome of common baseline checks."""

    NO_SIGNAL = "no_signal"
    ASK_REQUIRED = "ask_required"
    TERMINAL_DENY = "terminal_deny"


class RiskCategory(str, Enum):
    """Stable categories used by P0 baseline rules."""

    CREDENTIAL_EXPOSURE = "credential_exposure"
    COMMAND_EXECUTION = "command_execution"
    FILESYSTEM_MODIFICATION = "filesystem_modification"
    NETWORK_EGRESS = "network_egress"
    SENSITIVE_PATH = "sensitive_path"
    SELF_PROTECTION = "self_protection"
    PERSISTENCE = "persistence"
    PRIVILEGE_CHANGE = "privilege_change"
    DATA_EXFILTRATION = "data_exfiltration"
    TOOL_CONTRACT = "tool_contract"


@dataclass(frozen=True)
class BaselineResult:
    """Result produced by baseline checks and detectors."""

    verdict: BaselineVerdict
    category: RiskCategory = RiskCategory.COMMAND_EXECUTION
    rule_id: str = ""
    reason: str = ""
    rule_content: str = ""

    @classmethod
    def no_signal(cls) -> BaselineResult:
        """Return an empty result."""
        return cls(verdict=BaselineVerdict.NO_SIGNAL)
