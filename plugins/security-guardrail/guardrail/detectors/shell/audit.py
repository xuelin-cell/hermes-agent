"""Audit protection shell detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _CMDPOS
from .profile import CommandInvocation, profile_shell_command
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult
from ...types import OperatingSystem

if TYPE_CHECKING:
    from ...action import RuntimeAction


_AUDIT_TERMINAL_RE = re.compile(
    _CMDPOS + r"(?:auditctl\s+(?:-D|-e\s+0)\b|(?:kill|pkill|killall)\b[^\n;|&]*(?:auditd|pgrep\s+auditd)|"
    r"service\s+auditd\s+stop\b|systemctl\s+(?:stop|disable|mask)\s+auditd\b)",
    re.IGNORECASE,
)


_USER_HOME_PATTERN = (
    r"(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|/root|/(?:home|Users)/[^/\s;|&]+|"
    r"[A-Za-z]:[/\\]Users[/\\][^/\\\s;|&]+)"
)
_SHELL_HISTORY_PATH_PATTERN = (
    rf"{_USER_HOME_PATTERN}(?:[/\\](?:\.bash_history|\.zsh_history)|"
    r"[/\\]\.local[/\\]share[/\\]fish[/\\]fish_history)"
)
_POWERSHELL_HISTORY_PATH_PATTERN = (
    r"(?:%APPDATA%|\$env:APPDATA|~[/\\]AppData[/\\]Roaming|"
    r"[A-Za-z]:[/\\]Users[/\\][^/\\\s;|&]+[/\\]AppData[/\\]Roaming)"
    r"[/\\]Microsoft[/\\](?:Windows[/\\])?PowerShell[/\\]PSReadLine[/\\]ConsoleHost_history\.txt"
)
_COMMAND_HISTORY_EVASION_RE = re.compile(
    rf"(?:^|[;&|\n])\s*(?:history\s+(?:-(?:c|d)\b|(?:clear|delete)\b)|unset\s+HISTFILE\b|"
    rf"set\s+\+o\s+history\b|(?:export\s+)?HISTSIZE=0\b|"
    rf"(?:export\s+)?HISTFILE=(?:/dev/null\b|(?=$|[\s;|&]))|"
    rf"(?:rm|truncate)\b[^\n;]*{_SHELL_HISTORY_PATH_PATTERN}|"
    rf"ln\s+-sf\s+/dev/null[^\n;]*{_SHELL_HISTORY_PATH_PATTERN}|"
    r"Clear-History\b|"
    r"Set-PSReadLineOption\b(?=[^\n;|&]*(?:-HistorySaveStyle\s+SaveNothing\b|"
    r"-HistorySavePath\s+(?:NUL|/dev/null)\b))[^\n;|&]*|"
    rf"(?:Remove-Item|ri|rm|del|erase)\b[^\n;|&]*(?:{_POWERSHELL_HISTORY_PATH_PATTERN}|"
    r"\(\s*Get-PSReadLineOption\s*\)\.HistorySavePath\b))",
    re.IGNORECASE,
)


_LINUX_SYSTEM_LOG_PATH = (
    r"(?:/var/log(?:/\*)?|/var/log/(?:audit(?:/[^\s;|&]+|\.log)?|auth\.log|secure|syslog|messages|"
    r"journal(?:/[^\s;|&]+)?|wtmp|btmp|lastlog|kern\.log))(?=$|[\s;|&])"
)
_MACOS_SYSTEM_LOG_PATH = r"(?:/var/audit(?:/\*|/[^\s;|&]+)?|/var/log/system\.log)(?=$|[\s;|&])"
_LINUX_LOG_AUDIT_DESTRUCTION_RE = re.compile(
    rf"(?:^|[;&|\n])\s*(?:(?:rm|shred|truncate)\b[^\n;]*{_LINUX_SYSTEM_LOG_PATH}|"
    rf"find\s+/var/log\b[^\n;]*(?:-delete\b|-(?:exec|execdir)\s+(?:rm|shred)\b)|"
    rf"dd\b(?=[^\n;]*\bif=/dev/null\b)(?=[^\n;]*\bof={_LINUX_SYSTEM_LOG_PATH})[^\n;]*|"
    rf"cp\b[^\n;]*\s/dev/null\s+{_LINUX_SYSTEM_LOG_PATH}|"
    rf"(?::|true)\s*(?:>\s*|\|\s*tee\s+){_LINUX_SYSTEM_LOG_PATH}|"
    r"journalctl\b[^\n;]*--vacuum-(?:size|time|files)(?:=|\s))",
    re.IGNORECASE,
)
_MACOS_LOG_AUDIT_DESTRUCTION_RE = re.compile(
    rf"(?:^|[;&|\n])\s*(?:(?:rm|shred|truncate)\b[^\n;]*{_MACOS_SYSTEM_LOG_PATH}|"
    rf"find\s+/var/audit\b[^\n;]*(?:-delete\b|-(?:exec|execdir)\s+(?:rm|shred)\b)|"
    rf"dd\b(?=[^\n;]*\bif=/dev/null\b)(?=[^\n;]*\bof={_MACOS_SYSTEM_LOG_PATH})[^\n;]*|"
    rf"cp\b[^\n;]*\s/dev/null\s+{_MACOS_SYSTEM_LOG_PATH}|"
    rf"(?::|true)\s*(?:>\s*|\|\s*tee\s+){_MACOS_SYSTEM_LOG_PATH}|"
    r"log\s+erase\b[^\n;]*(?:--all\b|--ttl(?:=|\s)))",
    re.IGNORECASE,
)


def detect_audit_service_tampering(action: RuntimeAction) -> BaselineResult:
    """Deny direct tampering with OS audit enforcement."""
    if _AUDIT_TERMINAL_RE.search(action.normalized_payload):
        return result_for(terminal_rules.AUDIT_SERVICE_TAMPERING, action, rule_content="audit_service_tampering")
    return BaselineResult.no_signal()


def detect_command_history_evasion(action: RuntimeAction) -> BaselineResult:
    """Detect cross-platform command-history clearing or recording disablement."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if _COMMAND_HISTORY_EVASION_RE.search(analyze_shell_text(action.normalized_payload).executable_text):
        return result_for(ask_rules.COMMAND_HISTORY_EVASION, action)
    return BaselineResult.no_signal()


def detect_log_audit_destruction(action: RuntimeAction) -> BaselineResult:
    """Detect deletion or truncation of common audit and system logs."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    executable = analyze_shell_text(action.normalized_payload).executable_text
    is_linux = action.operating_system in {None, OperatingSystem.LINUX}
    is_macos = action.operating_system in {None, OperatingSystem.MACOS}
    if (is_linux and _LINUX_LOG_AUDIT_DESTRUCTION_RE.search(executable)) or (is_macos and _MACOS_LOG_AUDIT_DESTRUCTION_RE.search(executable)):
        return result_for(ask_rules.LOG_AUDIT_DESTRUCTION, action)
    return BaselineResult.no_signal()


_WINDOWS_EVENT_LOG_SESSION_CLEAR_RE = re.compile(
    r"\[\s*(?:System\.)?Diagnostics\.Eventing\.Reader\.EventLogSession\s*\]"
    r"\s*::\s*GlobalSession\s*\.\s*ClearLog\s*\(",
    re.IGNORECASE,
)
_WINDOWS_EVENT_LOG_CMDLETS = frozenset({"clear-eventlog", "clear-winevent", "remove-eventlog"})
_WINDOWS_EVENT_LOG_WHATIF_CMDLETS = frozenset({"clear-eventlog", "remove-eventlog"})
_WEVTUTIL_CLEAR_OPERATIONS = frozenset({"cl", "clear-log"})
_WEVTUTIL_SET_OPERATIONS = frozenset({"sl", "set-log"})
_WEVTUTIL_DISABLE_OPTIONS = frozenset({"/e:false", "/e=false", "/enabled:false", "/enabled=false"})


def _normalized_argument(value: str) -> str:
    return value.strip().strip("\"'`").casefold()


def _has_enabled_whatif(invocation: CommandInvocation) -> bool:
    return any(_normalized_argument(argument) in {"-whatif", "-whatif:$true"} for argument in invocation.args)


def _is_windows_event_log_clear_invocation(invocation: CommandInvocation) -> bool:
    command = invocation.canonical_name
    if command in _WINDOWS_EVENT_LOG_CMDLETS:
        return command not in _WINDOWS_EVENT_LOG_WHATIF_CMDLETS or not _has_enabled_whatif(invocation)
    if command != "wevtutil" or not invocation.args:
        return False
    arguments = tuple(_normalized_argument(argument) for argument in invocation.args)
    operation = arguments[0]
    return operation in _WEVTUTIL_CLEAR_OPERATIONS or (
        operation in _WEVTUTIL_SET_OPERATIONS and any(argument in _WEVTUTIL_DISABLE_OPTIONS for argument in arguments[1:])
    )


def detect_lite_windows_event_log_clear(action: RuntimeAction) -> BaselineResult:
    """Detect explicit Windows event-log clearing or disablement."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    executable = analyze_shell_text(action.normalized_payload).executable_text
    invocations = profile_shell_command(action.normalized_payload).invocations
    if _WINDOWS_EVENT_LOG_SESSION_CLEAR_RE.search(executable) or any(
        _is_windows_event_log_clear_invocation(invocation) for invocation in invocations
    ):
        return result_for(ask_rules.LITE_WINDOWS_EVENT_LOG_CLEAR, action)
    return BaselineResult.no_signal()
