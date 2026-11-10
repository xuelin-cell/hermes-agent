"""Explicit sensitive inspection; no Agent, tool, or model integration."""

from .detector import inspect_sensitive_text
from .types import SensitiveDetectionResult, SensitiveFinding, SensitivePolicySnapshot, SensitiveUnavailableError

__all__ = [
    "SensitiveDetectionResult",
    "SensitiveFinding",
    "SensitivePolicySnapshot",
    "SensitiveUnavailableError",
    "inspect_sensitive_text",
]
