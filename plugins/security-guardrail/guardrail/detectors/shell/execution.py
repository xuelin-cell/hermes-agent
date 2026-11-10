"""Direct, indirect, remote, and obfuscated shell execution detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _CMDPOS
from .profile import profile_shell_command
from .trusted_installers import match_trusted_installer
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction


_OBFUSCATED_TERMINAL_RE = re.compile(
    r"(?=[^\n;]*cm0gLXJmIC8=)(?=[^\n;]*base64\s+-d)(?=[^\n;]*(?:\|\s*(?:bash|sh)\b|\beval\b|\$\())|"
    r"(?:^|[;&|\n])\s*(?:r[\"']{2}m|\\r\\m)\s+-rf\s+/(?=$|[\s;|&\n`)])|"
    r"\$\{IFS\}rm\$\{IFS\}-rf\$\{IFS\}/|"
    r"\$\(printf\s+['\"]\\x72\\x6d['\"]\)\s+-rf\s+/(?=$|[\s;|&\n`)])|"
    r"(?:^|[;&|\n])\s*x=rm\s*;\s*\$x\s+-rf\s+/(?=$|[\s;|&\n`)])|"
    r"\bpython3?\s+-c\b(?=[^\n]*\bos\.system\s*\()(?=[^\n]*rm\s+-rf\s+/)|"
    r"\bperl\s+-e\b(?=[^\n]*\bsystem\s*\()(?=[^\n]*rm[\"',\s]+-rf[\"',\s]+/)",
    re.IGNORECASE,
)


_REVERSE_SHELL_TERMINAL_RE = re.compile(
    _CMDPOS
    + r"(?:bash|sh|zsh|ksh)\b[^\n;]*(?:/dev/tcp|/dev/udp)/|"
    + _CMDPOS
    + r"(?:nc|ncat)\b[^\n;]*\s-e\s+(?:/bin/)?(?:bash|sh)\b|"
    + _CMDPOS
    + r"socat\b[^\n;]*EXEC:(?:/bin/)?(?:bash|sh)\b|"
    + _CMDPOS
    + r"python3?\s+-c\b(?=[^\n;]*\bsocket\b)(?=[^\n;]*(?:subprocess|os\.dup2|pty\.spawn))|"
    + _CMDPOS
    + r"perl\s+-e\b(?=[^\n;]*\bSocket\b)|"
    + _CMDPOS
    + r"php\s+-r\b(?=[^\n;]*fsockopen\b)|"
    + _CMDPOS
    + r"ruby\b[^\n;]*(?:-rsocket|require\s+['\"]socket)|"
    + _CMDPOS
    + r"msfvenom\b[^\n;]*reverse_(?:tcp|shell)",
    re.IGNORECASE,
)


_REMOTE_SCRIPT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:curl|wget)\b(?:(?!&&|\|\||;|\n|\r).)*\|\s*(?:sudo\s+)?(?:bash|sh)\b", re.IGNORECASE),
    re.compile(r"\b(?:bash|sh)\s+<\s*\(\s*(?:curl|wget)\b[^;)\n\r]*\)", re.IGNORECASE),
    re.compile(r"\beval\s+['\"]?\$\(\s*(?:curl|wget)\b[^;)\n\r]*\)", re.IGNORECASE),
    re.compile(
        r"\b(?:curl|wget)\b[^\n;]*(?:-O\s+|-o\s+)?(?P<script>[A-Za-z0-9_./-]+\.(?:sh|bash|py))\b"
        r"[^\n;]*(?:&&|;)\s*(?:sudo\s+)?(?:bash|sh|python3?)\s+(?P=script)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:iex|Invoke-Expression)\b\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b", re.IGNORECASE),
)

_RESOURCE_EXHAUSTION_RE = re.compile(
    r"(?:^|[;&|\n])\s*(?:(?:yes|cat\s+/dev/urandom)\b[^\n;]*>\s*/dev/null\s*&|"
    r"ab\s+[^\n;]*-n\s+\d{6,}[^\n;]*-c\s+\d{3,})",
    re.IGNORECASE,
)
_LITE_POWERSHELL_EXPRESSION_RE = re.compile(_CMDPOS + r"(?:Invoke-Expression|iex)\b", re.IGNORECASE)
_LITE_POWERSHELL_DOWNLOAD_EXECUTE_RE = re.compile(
    r"(?=[\s\S]*\bDownloadString\b)(?=[\s\S]*(?:\bInvoke-Expression\b|\biex\b|&\s*\(|\.\s*\())",
    re.IGNORECASE,
)
_LITE_POWERSHELL_NATIVE_TYPE_RE = re.compile(
    _CMDPOS + r"Add-Type\b(?=[\s\S]*(?:DllImport|P/Invoke|unsafe\b|kernel32|user32|advapi32|System\.Runtime\.InteropServices))",
    re.IGNORECASE,
)
_LITE_POWERSHELL_ENCODED_RE = re.compile(
    _CMDPOS + r"(?:powershell|pwsh)(?:\.exe)?\b[^\n;|&]*\s-(?:EncodedArguments|EncodedCommand|enca|enc)\b",
    re.IGNORECASE,
)
_LITE_POWERSHELL_SCRIPTBLOCK_RE = re.compile(r"\[\s*ScriptBlock\s*\]::Create\s*\(", re.IGNORECASE)
_LITE_WINDOWS_SOFTWARE_INSTALL_RE = re.compile(
    _CMDPOS + r"(?:"
    r"Start-Process\b[^\n;|&]*(?:setup|install(?:er)?)[^\s;|&]*\.(?:exe|msi)\b)",
    re.IGNORECASE,
)
_WINDOWS_INSTALLER_FILENAME_RE = re.compile(r"(?:setup|install(?:er)?)[^/\\]*\.(?:exe|msi)$", re.IGNORECASE)
_WINDOWS_RESOURCE_EXHAUSTION_RE = re.compile(
    r"while\s*\(\s*\$true\s*\)\s*\{[^}]*\b(?:Start-Job|Start-Process)\b|"
    r"for\s+/L\s+%%?[A-Za-z]\s+in\s+\(\s*\d+\s*,\s*0\s*,\s*\d+\s*\)\s+do\s+[^\n;]*\bstart\b",
    re.IGNORECASE,
)
_FSUTIL_CREATENEW_ARGUMENTS = 4
_OVERSIZED_FILE_BYTES = 10_000_000_000
_POWERSHELL_SOFTWARE_COMMANDS_WITH_WHATIF = frozenset(
    {
        "install-module",
        "install-package",
        "install-script",
        "update-module",
        "update-package",
        "update-script",
    }
)
_DIRECT_PACKAGE_SOURCE_RE = re.compile(
    r"^(?:https?|ftp|file|git(?:\+[^:]+)?|ssh)://|^git@",
    re.IGNORECASE,
)
_DIRECT_PACKAGE_FILE_SUFFIXES = (
    ".appx",
    ".exe",
    ".gem",
    ".json",
    ".msi",
    ".msix",
    ".nupkg",
    ".tar.gz",
    ".tgz",
    ".whl",
    ".yaml",
    ".yml",
    ".zip",
)
_HIGH_RISK_PACKAGE_INSTALL_OPTIONS = frozenset(
    {
        "--allow-unofficial-build",
        "--custom",
        "--force",
        "--force-dependencies",
        "--ignore-checksums",
        "--ignore-local-archive-malware-scan",
        "--ignore-security-hash",
        "--install-arguments",
        "--installargs",
        "--location",
        "--manifest",
        "--override",
        "--override-arguments",
        "--package-parameters",
        "--params",
    }
)
_PACKAGE_MANAGER_ACTION_PREFIXES: dict[str, frozenset[tuple[str, ...]]] = {
    "cargo": frozenset({("install",)}),
    "choco": frozenset({("install",), ("upgrade",)}),
    "dotnet": frozenset({("tool", "install"), ("tool", "update")}),
    "gem": frozenset({("install",)}),
    "pipx": frozenset({("install",)}),
    "scoop": frozenset({("install",), ("update",)}),
    "uv": frozenset({("tool", "install"), ("tool", "upgrade")}),
    "winget": frozenset({("install",), ("upgrade",)}),
    "yarn": frozenset({("global", "add")}),
}
_SUPPLY_CHAIN_GUARDED_PACKAGE_MANAGERS = frozenset({"cargo", "pipx", "uv", "yarn"})
_HIGH_RISK_SOURCE_OPTIONS: dict[str, frozenset[str]] = {
    "choco": frozenset({"--source", "-s"}),
    "dotnet": frozenset({"--add-source"}),
    "gem": frozenset({"--source"}),
}


def detect_reverse_shell(action: RuntimeAction) -> BaselineResult:
    """Deny direct reverse shell execution patterns."""
    if _REVERSE_SHELL_TERMINAL_RE.search(action.normalized_payload):
        return result_for(terminal_rules.REVERSE_SHELL, action, rule_content="reverse_shell")
    return BaselineResult.no_signal()


def detect_obfuscated_terminal_command(action: RuntimeAction) -> BaselineResult:
    """Deny obfuscated wrappers that reconstruct terminal-deny commands."""
    if _OBFUSCATED_TERMINAL_RE.search(action.normalized_payload):
        return result_for(terminal_rules.OBFUSCATED_TERMINAL_COMMAND, action, rule_content="obfuscated_terminal_command")
    return BaselineResult.no_signal()


def detect_indirect_terminal_command(action: RuntimeAction) -> BaselineResult:
    """Deny indirect execution wrappers carrying terminal-deny commands."""
    command = action.normalized_payload
    if not re.search(r"\brm\s+-rf\s+/", command, re.IGNORECASE):
        return BaselineResult.no_signal()
    if not re.search(r"\b(?:at\s+now|xargs\b|(?:bash|sh|zsh)\s+-c|env\s+-i\s+(?:bash|sh|zsh)\s+-c)\b", command, re.IGNORECASE):
        return BaselineResult.no_signal()
    return result_for(terminal_rules.INDIRECT_TERMINAL_COMMAND, action, rule_content="indirect_terminal_command")


def detect_remote_script_execution(action: RuntimeAction) -> BaselineResult:
    """Deny direct download-and-execute shell patterns."""
    if match_trusted_installer(action) is not None:
        return BaselineResult.no_signal()
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()

    command = analyze_shell_text(action.normalized_payload).executable_text
    if any(pattern.search(command) for pattern in _REMOTE_SCRIPT_PATTERNS):
        return result_for(terminal_rules.REMOTE_SCRIPT_EXECUTION, action)

    return BaselineResult.no_signal()


def detect_resource_exhaustion(action: RuntimeAction) -> BaselineResult:
    """Detect commands likely to consume unbounded local resources."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    has_resource_command = any(
        invocation.canonical_name in {"ab", "cat", "yes"}
        for invocation in profile_shell_command(action.normalized_payload).invocations
    )
    if has_resource_command and _RESOURCE_EXHAUSTION_RE.search(analyze_shell_text(action.normalized_payload).executable_text):
        return result_for(ask_rules.RESOURCE_EXHAUSTION, action)
    executable = _normalize_powershell_variable_escapes(analyze_shell_text(action.normalized_payload).executable_text)
    if _WINDOWS_RESOURCE_EXHAUSTION_RE.search(executable) or any(
        _creates_oversized_windows_file(invocation.canonical_name, invocation.args)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.RESOURCE_EXHAUSTION, action)
    return BaselineResult.no_signal()


def _creates_oversized_windows_file(command: str, args: tuple[str, ...]) -> bool:
    if (
        command != "fsutil"
        or tuple(arg.casefold() for arg in args[:2]) != ("file", "createnew")
        or len(args) < _FSUTIL_CREATENEW_ARGUMENTS
    ):
        return False
    try:
        return int(args[3].replace("_", "")) >= _OVERSIZED_FILE_BYTES
    except ValueError:
        return False


def _normalize_powershell_variable_escapes(command: str) -> str:
    """Normalize PowerShell variable escapes preserved inside shell wrappers."""
    return command.replace("\\`$", "$").replace("`$", "$")


def detect_lite_powershell_dynamic_execution(action: RuntimeAction) -> BaselineResult:
    """Detect Lite-only PowerShell dynamic execution."""
    if match_trusted_installer(action) is not None:
        return BaselineResult.no_signal()
    raw_command = action.normalized_payload
    executable_command = analyze_shell_text(raw_command).executable_text
    if (
        any(
            pattern.search(executable_command)
            for pattern in (
                _LITE_POWERSHELL_EXPRESSION_RE,
                _LITE_POWERSHELL_ENCODED_RE,
                _LITE_POWERSHELL_SCRIPTBLOCK_RE,
            )
        )
        or _LITE_POWERSHELL_DOWNLOAD_EXECUTE_RE.search(executable_command)
        or _LITE_POWERSHELL_NATIVE_TYPE_RE.search(raw_command)
    ):
        return result_for(ask_rules.LITE_POWERSHELL_DYNAMIC_EXECUTION, action)
    return BaselineResult.no_signal()


def detect_lite_windows_software_install(action: RuntimeAction) -> BaselineResult:
    """Detect explicit system or global software installation on Lite Windows."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    executable = analyze_shell_text(action.normalized_payload).executable_text
    if _LITE_WINDOWS_SOFTWARE_INSTALL_RE.search(executable) or any(
        _windows_software_install_requires_approval(invocation.canonical_name, invocation.command_args)
        or (
            invocation.canonical_name in {"start-process", "saps"}
            and _start_process_runs_installer(invocation.args)
        )
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.LITE_WINDOWS_SOFTWARE_INSTALL, action)
    return BaselineResult.no_signal()


def _windows_software_install_requires_approval(command: str, args: tuple[str, ...]) -> bool:
    """Return whether an install crosses the high-risk approval boundary."""
    lowered = tuple(arg.strip("\"'`").casefold() for arg in args)
    if command == "winget" and lowered[:1] == ("import",):
        return True

    install_args = _package_manager_install_args(command, lowered)
    if install_args is not None:
        if command == "cargo" and "--list" in lowered:
            return False
        if command == "dotnet" and not any(arg in {"-g", "--global"} for arg in install_args):
            return False
        return _high_risk_package_install_args(command, install_args)

    return _direct_windows_installer_requires_approval(command, lowered)


def _package_manager_install_args(command: str, args: tuple[str, ...]) -> tuple[str, ...] | None:
    for prefix in _PACKAGE_MANAGER_ACTION_PREFIXES.get(command, frozenset()):
        if args[: len(prefix)] == prefix:
            return args[len(prefix) :]
    return None


def _direct_windows_installer_requires_approval(command: str, args: tuple[str, ...]) -> bool:
    detected = False
    if command == "msiexec":
        detected = any(arg in {"/i", "-i", "/p", "-p", "/package", "/update"} for arg in args)
    elif command in {
        "add-appxpackage",
        "add-windowspackage",
        "enable-windowsoptionalfeature",
        *_POWERSHELL_SOFTWARE_COMMANDS_WITH_WHATIF,
    }:
        detected = True
    elif command == "dism":
        detected = any(arg.startswith(("/add-package", "/enable-feature")) for arg in args)
    elif command == "wusa":
        detected = bool(args) and not any(arg in {"/?", "/uninstall"} for arg in args)
    has_supported_what_if = command in _POWERSHELL_SOFTWARE_COMMANDS_WITH_WHATIF and "-whatif" in args
    return detected and not has_supported_what_if


def _high_risk_package_install_args(
    command: str,
    args: tuple[str, ...],
) -> bool:
    source_options = _HIGH_RISK_SOURCE_OPTIONS.get(command, frozenset())
    for arg in args:
        option, separator, value = arg.partition("=")
        if arg in {"--all", "all", "*"} or option in _HIGH_RISK_PACKAGE_INSTALL_OPTIONS or option in source_options:
            return True
        if command not in _SUPPLY_CHAIN_GUARDED_PACKAGE_MANAGERS and _looks_like_direct_package_source(value if separator else arg):
            return True
    return False


def _looks_like_direct_package_source(value: str) -> bool:
    normalized = value.strip("\"'`").casefold()
    return bool(_DIRECT_PACKAGE_SOURCE_RE.match(normalized)) or normalized.endswith(_DIRECT_PACKAGE_FILE_SUFFIXES)


def _start_process_runs_installer(args: tuple[str, ...]) -> bool:
    """Recognize installer filenames passed to PowerShell Start-Process."""
    executable = ""
    index = 0
    while index < len(args):
        raw_arg = args[index]
        arg = raw_arg.strip().strip("\"'`")
        option, separator, inline = arg.partition(":")
        if not separator:
            option, separator, inline = arg.partition("=")
        lowered_option = option.casefold()
        if lowered_option == "-filepath":
            if separator:
                executable = inline
            elif index + 1 < len(args):
                index += 1
                executable = args[index].strip().strip("\"'`")
            break
        if not arg.startswith("-"):
            executable = arg
            break
        index += 1

    filename = executable.replace("\\", "/").rsplit("/", 1)[-1]
    return _WINDOWS_INSTALLER_FILENAME_RE.search(filename) is not None
