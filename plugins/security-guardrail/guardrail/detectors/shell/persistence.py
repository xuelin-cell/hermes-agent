"""Privilege and persistence shell detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _CMDPOS
from .profile import profile_shell_command
from .workspace import mutation_paths, mutation_target_values
from ...path_policy import is_user_persistence_path
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction


_STARTUP_PERSISTENCE_TARGET_RE = re.compile(
    r">>?\s*(?:['\"])?(?:~/(?:\.bashrc|\.zshrc|\.profile|\.bash_profile)|/etc/rc\.local|/etc/profile(?:\.d/[^\s;|&]+)?)",
    re.IGNORECASE,
)


_PERSISTED_REVERSE_SHELL_RE = re.compile(
    r"(?:/dev/(?:tcp|udp)/|"
    r"\b(?:nc|ncat)\b[^\n;]*\s-e\s+(?:/bin/)?(?:bash|sh)\b|"
    r"\bsocat\b[^\n;]*EXEC:(?:/bin/)?(?:bash|sh)\b|"
    r"\b(?:bash|sh|zsh|ksh)\b[^\n;]*\b-i\b[^\n;]*(?:>&|0>&1))",
    re.IGNORECASE,
)
_EXECUTABLE_STARTUP_PAYLOAD_RE = re.compile(
    r"\b(?:curl|wget|nc|ncat|socat|bash|sh|python|perl|ruby|php|eval|source)\b",
    re.IGNORECASE,
)


_PERSISTENCE_TERMINAL_RE = re.compile(
    _CMDPOS + r"(?:systemctl\s+enable\b[^\n;]*(?:backdoor|evil)[^\n;]*\.service|"
    r"echo\b(?=[^\n;]*(?:backdoor|evil|curl|nc|ncat|bash|sh))[^\n;]*>>\s*/etc/rc\.local)",
    re.IGNORECASE,
)


_AUTHORIZED_KEYS_PERSISTENCE_RE = re.compile(
    _CMDPOS + r"(?:echo|printf)\b"
    r"(?=[^\n;|&]*(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-|sk-ssh-))"
    r"[^\n;|&]*>>?\s*(?:['\"])?(?:~|/home/[^\s/]+)/(?:\.ssh/)?authorized_keys\b",
    re.IGNORECASE,
)


_LAUNCHCTL_PERSISTENCE_RE = re.compile(
    _CMDPOS + r"launchctl\s+load\b[^\n;|&]*(?:-w\b[^\n;|&]*)?"
    r"(?:~/Library/LaunchAgents/|/Library/Launch(?:Agents|Daemons)/|/System/Library/Launch(?:Agents|Daemons)/)",
    re.IGNORECASE,
)
_PERSISTENCE_CHANGE_RE = re.compile(
    _CMDPOS + r"update-rc\.d\s+\S+\s+(?:defaults|disable|enable|remove)\b|"
    r"(?:echo|printf)\b(?=[^\n;|&]*\b(?:curl|wget|nc|ncat|socat|bash|sh|python|perl|ruby|php|eval|source)\b)"
    r"[^\n;|&]*>>?\s*(?:['\"])?(?:~/(?:\.bashrc|\.zshrc|\.profile|\.bash_profile)|/etc/rc\.local)",
    re.IGNORECASE,
)
_DANGEROUS_UNIX_PERMISSION_RE = re.compile(
    _CMDPOS + r"(?:chmod\s+-R\s+(?:000|777)\b|chown\s+-R\s+(?:root(?::(?:root|wheel))?|0(?::0)?)\b)",
    re.IGNORECASE,
)
_LITE_WINDOWS_PERMISSION_RE = re.compile(
    _CMDPOS
    + r"(?:icacls(?:\.exe)?\b(?=[^\n;|&]*(?:/(?:grant(?::r)?|deny|remove(?::[gd])?|restore|reset|"
    r"setintegritylevel|setowner|substitute|inheritance(?::[edr])?)\b))|"
    r"takeown(?:\.exe)?\b(?=[^\n;|&]*\s/r(?:\s|$))|Set-Acl\b)|"
    r"\[(?:System\.)?IO\.(?:File|Directory)(?:Info)?\]::SetAccessControl\s*\(",
    re.IGNORECASE,
)
_LITE_WINDOWS_PERSISTENCE_RE = re.compile(
    r"(?:\breg(?:\.exe)?\s+(?:add|delete)\s+['\"]?(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)"
    r"[^\n;]*(?:Run|RunOnce)\b|"
    r"\bsc(?:\.exe)?\s+(?:create|config|delete)\b|"
    r"\b(?:New|Set|Remove)-Service\b)",
    re.IGNORECASE,
)
_WINDOWS_STARTUP_PATH_RE = re.compile(
    r"^(?:(?:%appdata%|\$env:appdata|[A-Za-z]:[/\\]Users[/\\][^/\\]+[/\\]AppData[/\\]Roaming)"
    r"[/\\]Microsoft[/\\]Windows[/\\]Start Menu[/\\]Programs[/\\]Startup|"
    r"[A-Za-z]:[/\\]ProgramData[/\\]Microsoft[/\\]Windows[/\\]Start Menu[/\\]Programs[/\\]Startup)"
    r"(?:[/\\].+)?$",
    re.IGNORECASE,
)


def detect_persisted_reverse_shell(action: RuntimeAction) -> BaselineResult:
    """Deny reverse-shell payloads written into startup files."""
    command = action.normalized_payload
    if _STARTUP_PERSISTENCE_TARGET_RE.search(command) and _PERSISTED_REVERSE_SHELL_RE.search(command):
        return result_for(terminal_rules.PERSISTED_REVERSE_SHELL, action, rule_content="persisted_reverse_shell")
    return BaselineResult.no_signal()


def detect_persistence_terminal(action: RuntimeAction) -> BaselineResult:
    """Deny explicit backdoor persistence installation."""
    if (
        _PERSISTENCE_TERMINAL_RE.search(action.normalized_payload)
        or _AUTHORIZED_KEYS_PERSISTENCE_RE.search(action.normalized_payload)
        or _LAUNCHCTL_PERSISTENCE_RE.search(action.normalized_payload)
    ):
        return result_for(terminal_rules.PERSISTENCE_TERMINAL, action, rule_content="persistence_terminal")
    return BaselineResult.no_signal()


def detect_persistence_change(action: RuntimeAction) -> BaselineResult:
    """Detect explicit Unix startup and non-timer persistence mutations."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    command = action.normalized_payload
    if (
        _mutates_user_persistence_path(action)
        or _PERSISTENCE_CHANGE_RE.search(command)
        or _has_structured_persistence_change(action)
        or (_STARTUP_PERSISTENCE_TARGET_RE.search(command) and _EXECUTABLE_STARTUP_PAYLOAD_RE.search(command))
    ):
        return result_for(ask_rules.PERSISTENCE_CHANGE, action)
    return BaselineResult.no_signal()


def _mutates_user_persistence_path(action: RuntimeAction) -> bool:
    return any(is_user_persistence_path(target) for target in (*mutation_target_values(action), *mutation_paths(action)))


def _has_structured_persistence_change(action: RuntimeAction) -> bool:
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        command = invocation.canonical_name
        args = invocation.args
        if command == "systemctl" and _mutates_non_timer_systemd_unit(args):
            return True
        if command == "launchctl" and _mutates_launchd(args):
            return True
    return False


def _mutates_non_timer_systemd_unit(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    try:
        enable_index = lowered.index("enable")
    except ValueError:
        return False
    units = tuple(arg for arg in args[enable_index + 1 :] if not arg.startswith("-"))
    return not units or any(not unit.casefold().endswith(".timer") for unit in units)


def _mutates_launchd(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    return lowered[:1] in {("bootout",), ("bootstrap",), ("disable",), ("enable",)}


def detect_dangerous_unix_permission_change(action: RuntimeAction) -> BaselineResult:
    """Detect recursive permission changes with destructive modes or owners."""
    if _DANGEROUS_UNIX_PERMISSION_RE.search(action.normalized_payload) or any(
        _is_dangerous_permission_invocation(invocation.canonical_name, invocation.args)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.DANGEROUS_PERMISSION_CHANGE, action)
    return BaselineResult.no_signal()


def _is_dangerous_permission_invocation(command: str, args: tuple[str, ...]) -> bool:
    if command not in {"chmod", "chown"} or not _has_recursive_option(args):
        return False
    positional = _permission_positionals(args)
    if not positional:
        return False
    subject = positional[0].casefold()
    if command == "chmod":
        return subject in {"000", "777", "a+rwx", "a=rwx", "ugo+rwx", "ugo=rwx"}
    return re.fullmatch(r"(?:root(?::(?:root|wheel))?|0(?::0)?)", subject) is not None


def _has_recursive_option(args: tuple[str, ...]) -> bool:
    return any(
        arg.casefold() == "--recursive" or (arg.startswith("-") and not arg.startswith("--") and "R" in arg[1:])
        for arg in args
    )


def _permission_positionals(args: tuple[str, ...]) -> tuple[str, ...]:
    positional: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        option = arg.casefold().partition("=")[0]
        if option == "--reference":
            index += 1 if "=" in arg else 2
            continue
        if not arg.startswith("-"):
            positional.append(arg)
        index += 1
    return tuple(positional)


def detect_lite_windows_persistence(action: RuntimeAction) -> BaselineResult:
    """Detect Lite-only Windows persistence changes."""
    persistence_commands = {
        "new-service",
        "reg",
        "remove-service",
        "sc",
        "set-service",
    }
    if any(
        _LITE_WINDOWS_PERSISTENCE_RE.search(invocation.raw_segment)
        for invocation in profile_shell_command(action.normalized_payload).invocations
        if invocation.canonical_name in persistence_commands
    ) or any(_WINDOWS_STARTUP_PATH_RE.fullmatch(target.strip().strip("\"'`")) for target in mutation_target_values(action)):
        return result_for(ask_rules.LITE_WINDOWS_PERSISTENCE, action)
    return BaselineResult.no_signal()


def detect_lite_windows_permission_change(action: RuntimeAction) -> BaselineResult:
    """Detect Windows ACL and ownership mutations in Lite."""
    if _LITE_WINDOWS_PERMISSION_RE.search(analyze_shell_text(action.normalized_payload).executable_text) or any(
        _LITE_WINDOWS_PERMISSION_RE.search(invocation.raw_segment)
        for invocation in profile_shell_command(action.normalized_payload).invocations
        if invocation.canonical_name in {"icacls", "set-acl", "takeown"}
    ):
        return result_for(ask_rules.LITE_WINDOWS_PERMISSION_CHANGE, action)
    return BaselineResult.no_signal()
