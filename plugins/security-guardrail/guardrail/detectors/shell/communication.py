"""High-confidence external message, email, and webhook ASK detector."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from .http_request import HTTP_STATE_CHANGING_METHODS, extract_http_requests
from .profile import profile_shell_command
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction

_EMAIL_ADDRESS_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_MAIL_VALUE_OPTIONS = frozenset({"-a", "-b", "-c", "-f", "-s", "-S", "-u"})
_SENDMAIL_READ_ONLY_FLAGS = frozenset({"-bp", "-bs", "-bt", "-bv"})
_COMMUNICATION_PATH_PREFIXES: dict[str, tuple[str, ...]] = {
    "discord.com": ("/api/webhooks/",),
    "discordapp.com": ("/api/webhooks/",),
    "hooks.slack.com": ("/services/",),
    "open.feishu.cn": ("/open-apis/bot/v2/hook/",),
    "open.larksuite.com": ("/open-apis/bot/v2/hook/",),
}
_COMMUNICATION_EXACT_PATHS: dict[str, frozenset[str]] = {
    "oapi.dingtalk.com": frozenset({"/robot/send"}),
    "qyapi.weixin.qq.com": frozenset({"/cgi-bin/webhook/send"}),
}


def detect_external_communication(action: RuntimeAction) -> BaselineResult:
    """Detect explicit sends to known external communication targets."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        command = invocation.canonical_name
        if _sends_to_known_http_target(command, invocation.args) or _sends_email(command, invocation.args):
            return result_for(ask_rules.EXTERNAL_COMMUNICATION, action)
    return BaselineResult.no_signal()


def _sends_to_known_http_target(command: str, args: tuple[str, ...]) -> bool:
    return any(
        method in HTTP_STATE_CHANGING_METHODS and _is_known_communication_target(url)
        for method, url in extract_http_requests(command, args)
    )


def _is_known_communication_target(url: str) -> bool:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").casefold().rstrip(".")
    path = unquote(parsed.path).casefold()
    prefixes = _COMMUNICATION_PATH_PREFIXES.get(host, ())
    if prefixes:
        detected = path.startswith(prefixes)
    elif exact_paths := _COMMUNICATION_EXACT_PATHS.get(host, frozenset()):
        detected = path in exact_paths
    elif host == "api.telegram.org":
        detected = re.match(r"^/bot[^/]+/(?:copy|delete|edit|forward|send)[a-z0-9_]*$", path) is not None
    elif host in {"requestbin.com", "webhook.site"} or host.endswith(".requestbin.com"):
        detected = path not in {"", "/"}
    else:
        detected = host.endswith((".m.pipedream.net", ".beeceptor.com"))
    return detected


def _sends_email(command: str, args: tuple[str, ...]) -> bool:
    if command in {"mail", "mailx"}:
        return any(_EMAIL_ADDRESS_RE.fullmatch(value) for value in _mail_positionals(args))
    if command != "sendmail" or any(arg.casefold() in _SENDMAIL_READ_ONLY_FLAGS for arg in args):
        return False
    return any(_EMAIL_ADDRESS_RE.fullmatch(arg.strip().strip("\"'`")) for arg in args if not arg.startswith("-"))


def _mail_positionals(args: tuple[str, ...]) -> tuple[str, ...]:
    positionals: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in _MAIL_VALUE_OPTIONS:
            index += 2
            continue
        if not arg.startswith("-"):
            positionals.append(arg.strip().strip("\"'`"))
        index += 1
    return tuple(positionals)
