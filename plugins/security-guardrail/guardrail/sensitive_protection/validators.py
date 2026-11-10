"""Offline structure and context checks; never establish a real-world identity."""

from __future__ import annotations

import re
from datetime import date

_PROVINCES = frozenset(
    {
        "11",
        "12",
        "13",
        "14",
        "15",
        "21",
        "22",
        "23",
        "31",
        "32",
        "33",
        "34",
        "35",
        "36",
        "37",
        "41",
        "42",
        "43",
        "44",
        "45",
        "46",
        "50",
        "51",
        "52",
        "53",
        "54",
        "61",
        "62",
        "63",
        "64",
        "65",
    }
)
_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_ID_CHECKS = "10X98765432"
_SEPARATORS = re.compile(r"[ \t-]")


def _valid_id(value: str, reference_date: date) -> bool:
    if re.fullmatch(r"[1-9][0-9]{16}[0-9X]", value) is None:
        return False
    if value[:2] not in _PROVINCES or value[14:17] == "000":
        return False
    try:
        birthday = date(int(value[6:10]), int(value[10:12]), int(value[12:14]))
    except ValueError:
        return False
    checksum = sum(int(digit) * weight for digit, weight in zip(value[:17], _ID_WEIGHTS, strict=True)) % 11
    return birthday <= reference_date and value[-1] == _ID_CHECKS[checksum]


def valid_personal_value(validator: str, value: str, reference_date: date) -> bool:
    """Validate the normalized value using the rule's fixed validator."""
    if validator == "cn_id_card":
        return _valid_id(value, reference_date)
    if validator == "luhn_pan":
        if re.fullmatch(r"[0-9]{13,19}", value) is None or len(set(value)) == 1:
            return False
        digits = [int(char) for char in reversed(value)]
        total = sum(sum(divmod(digit * 2, 10)) if index % 2 else digit for index, digit in enumerate(digits))
        return total % 10 == 0
    if validator == "cn_mobile_format":
        return re.fullmatch(r"1[3-9][0-9]{9}", value) is not None
    message = "Unknown personal information validator"
    raise ValueError(message)


def normalize_personal_value(value: str, validator: str) -> str:
    """Normalize only the internal validation copy."""
    return value.upper() if validator == "cn_id_card" else _SEPARATORS.sub("", value)


def has_context(text: str, start: int, end: int, keywords: tuple[str, ...]) -> bool:
    """Apply the source rules' fixed 32-before/16-after label window."""
    context = text[max(0, start - 32) : start] + " " + text[end : end + 16]
    return any(
        re.search(r"\b" + re.escape(keyword) + r"\b", context, re.IGNORECASE) is not None if keyword.isascii() else keyword in context
        for keyword in keywords
    )


def has_identifier_boundary(text: str, start: int, end: int) -> bool:
    """Reject a number embedded in a longer ASCII identifier."""
    return any(char.isascii() and (char.isalnum() or char == "_") for char in (text[start - 1 : start] if start else "", text[end : end + 1]) if char)
