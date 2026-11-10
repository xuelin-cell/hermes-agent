"""Terminal network-contract detectors."""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import urlparse

from ..action import TargetKind, ToolType
from ..baseline_rules import network as rules
from ..baseline_rules import result_for
from ..signals import BaselineResult

if TYPE_CHECKING:
    from ..action import RuntimeAction

_MAX_URL_LENGTH = 2000


def detect_terminal_deny(action: RuntimeAction) -> BaselineResult:
    """Detect network targets that must be denied."""
    if not action.network_egress_candidate:
        return BaselineResult.no_signal()

    for url in _explicit_url_candidates(action):
        if not _is_valid_http_url(url):
            return result_for(rules.INVALID_URL, action, rule_content="invalid_url")

        if _has_embedded_credentials(url):
            return result_for(rules.URL_EMBEDDED_CREDENTIALS, action, rule_content="url_embedded_credentials")

    return BaselineResult.no_signal()


def _explicit_url_candidates(action: RuntimeAction) -> tuple[str, ...]:
    if action.tool_type != ToolType.NETWORK and action.target_kind != TargetKind.URL:
        return ()

    values: list[str] = []
    for key in ("url", "uri", "href", "target"):
        value = action.tool_input.get(key)
        if isinstance(value, str) and value:
            values.append(value)
    if action.target_kind == TargetKind.URL and action.target_value:
        values.append(action.target_value)
    return tuple(dict.fromkeys(values))


def _is_valid_http_url(raw_url: str) -> bool:
    if len(raw_url) > _MAX_URL_LENGTH:
        return False
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _has_embedded_credentials(raw_url: str) -> bool:
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return False
    return bool(parsed.username or parsed.password)
