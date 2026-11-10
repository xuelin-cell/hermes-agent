"""Pure, explicit inspection with deterministic display masks."""

from __future__ import annotations

import math
from collections import Counter
from typing import TYPE_CHECKING

from .catalog import _ContainsAny, _Entropy, get_sensitive_catalog
from .validators import has_context, has_identifier_boundary, normalize_personal_value, valid_personal_value

if TYPE_CHECKING:
    import re

    from .catalog import CompiledCondition, CompiledRule
    from .types import SensitiveDetectionResult, SensitiveFinding, SensitivePolicySnapshot


def _entropy(value: str) -> float:
    data = value.encode("utf-8")
    return -sum((count / len(data)) * math.log2(count / len(data)) for count in Counter(data).values()) if data else 0.0


def _excluded(value: str, conditions: tuple[CompiledCondition, ...]) -> bool:
    for condition in conditions:
        definition = condition.definition
        if isinstance(definition, _Entropy):
            entropy = _entropy(value)
            if entropy < definition.threshold or (definition.comparison == "<=" and entropy == definition.threshold):
                return True
        elif isinstance(definition, _ContainsAny):
            if any(term.lower() in value.lower() for term in definition.values):
                return True
        elif any(pattern.search(value) for pattern in condition.patterns):
            return True
    return False


def _original_record(text: str, start: int, end: int) -> str:
    left = max(text.rfind("\n", 0, start), text.rfind("\r", 0, start)) + 1
    stops = [offset for marker in ("\r", "\n") if (offset := text.find(marker, end)) >= 0]
    return text[left : min(stops) if stops else len(text)]


def _mask(value: str, rule: CompiledRule) -> str:
    if rule.definition.kind == "credential":
        return f"[{rule.definition.id.upper()}]"
    if rule.definition.runtime.validator == "cn_id_card":
        return value[:6] + "*" * 8 + value[-4:]
    mobile = rule.definition.runtime.validator == "cn_mobile_format"
    prefix_end = 3 if mobile and value.startswith("+86") else 0
    positions = [index for index, char in enumerate(value) if index >= prefix_end and "0" <= char <= "9"]
    hidden = set(positions[3 if mobile else 6 : -4])
    return "".join("*" if index in hidden else char for index, char in enumerate(value))


def _personal_span(
    text: str,
    match: re.Match[str],
    rule: CompiledRule,
    group: int,
    policy: SensitivePolicySnapshot,
    occupied: list[tuple[int, int]],
) -> tuple[int, int] | None:
    start, end = match.span(group)
    if has_identifier_boundary(text, *match.span()) or any(start < right and end > left for left, right in occupied):
        return None
    runtime = rule.definition.runtime
    validator = runtime.validator
    if validator is None or not valid_personal_value(
        validator,
        normalize_personal_value(match.group(group), validator),
        policy.reference_date,
    ):
        return None
    if runtime.require_context and not has_context(text, *match.span(), runtime.context_keywords):
        return None
    # Keep +86 and separators in the returned/displayed original.
    return match.span()


def inspect_sensitive_text(text: str, *, policy: SensitivePolicySnapshot) -> SensitiveDetectionResult:
    """Inspect one string without retaining values or modifying any application state.

    Args:
        text: Original text; natural-language commands are treated as data.
        policy: Immutable settings and explicit date for this inspection.

    Returns:
        Enabled state and one finding per confirmed occurrence, including the
        exact value, its original record, and a non-reversible display mask.

    Raises:
        SensitiveUnavailableError: The fixed offline catalog cannot be loaded.
    """
    if not policy.enabled:
        return {"enabled": False, "findings": []}
    catalog = get_sensitive_catalog()
    findings: list[SensitiveFinding] = []
    occupied: list[tuple[int, int]] = []
    lowered = text.lower()
    for rule in catalog.rules:
        definition = rule.definition
        runtime = definition.runtime
        if not policy.rule_overrides.get(definition.id, True):
            continue
        if runtime.keywords and not any(keyword.lower() in lowered for keyword in runtime.keywords):
            continue
        seen: set[tuple[int, int]] = set()
        for match in rule.pattern.finditer(text):
            group = runtime.secret_group
            if group is None:
                group = next((index for index, value in enumerate(match.groups(), 1) if value), 0)
            start, end = match.span(group)
            if start < 0 or start == end:
                continue
            if definition.kind == "pii":
                span = _personal_span(text, match, rule, group, policy, occupied)
                if span is None:
                    continue
                start, end = span
            value = text[start:end]
            if (start, end) in seen:
                continue
            if definition.kind == "credential" and (_excluded(value, catalog.common_exclusions) or _excluded(value, rule.exclusions)):
                continue
            seen.add((start, end))
            if definition.kind == "pii":
                occupied.append((start, end))
            findings.append(
                {
                    "rule_id": definition.id,
                    "methods": list(definition.methods),
                    "original_text": _original_record(text, start, end),
                    "original_value": value,
                    "protected_value": _mask(value, rule),
                }
            )
    return {"enabled": True, "findings": findings}
