"""Host boundary and critical system-path shell detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...baseline_rules import filesystem as filesystem_rules
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import commands as command_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _CMDPOS
from .profile import profile_shell_command
from .workspace import (
    mutation_paths,
    mutation_target_values,
    resolve_shell_path,
)
from ...path_policy import (
    contains_hexagent_self_protection_path,
    contains_host_credential_store_path,
    contains_host_system_mutation_path,
    contains_protected_app_dir_reference,
    is_hexagent_installed_skill_script,
    is_host_credential_store_path,
    is_host_system_mutation_path,
    is_linux_critical_system_path,
    is_path_within_protected_root,
)
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult
from ...types import BuildProfile

if TYPE_CHECKING:
    from ...action import RuntimeAction
    from .profile import CommandInvocation

_WINDOWS_HOST_EXECUTABLE_SUFFIXES = (".bat", ".cmd", ".exe", ".ps1")
_HOST_SYSTEM_MUTATION_COMMAND_RE = re.compile(
    _CMDPOS + r"(?:rm|rd|rmdir|chmod|chown|cp|mv|tee|touch|mkdir|truncate|"
    r"Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item)\b|"
    + _CMDPOS
    + r"icacls(?:\.exe)?\b(?=[^\n;|&]*(?:/(?:grant(?::r)?|deny|remove(?::[gd])?|setowner|reset|inheritance(?::[edr])?)\b))|"
    + _CMDPOS
    + r"sed\s+-i\b",
    re.IGNORECASE,
)
_HOST_SYSTEM_MUTATION_API_RE = re.compile(
    r"\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|"
    r"Create|CreateDirectory|Delete|Move|Replace)\b",
    re.IGNORECASE,
)
_HOST_SYSTEM_REDIRECT_RE = re.compile(r">>?\s*(?:['\"])?\S+", re.IGNORECASE)
_LINUX_ACCOUNT_SECURITY_PATH = (
    r"(?<![A-Za-z0-9_.~/-])(?:/etc/(?:passwd|shadow|sudoers)(?=$|[/\s'\"`;|&])|"
    r"/etc/sudoers\.d(?=$|[/\s'\"`;|&]))"
)
_LINUX_SENSITIVE_READ_RE = re.compile(
    _CMDPOS + rf"(?:cat|less|more|tail|head|grep|awk|sed)\b[^\n;|&]*{_LINUX_ACCOUNT_SECURITY_PATH}",
    re.IGNORECASE,
)
_LITE_WINDOWS_SECURITY_CHANGE_RE = re.compile(
    r"(?:\bnet(?:\.exe)?\s+(?:user|localgroup)\b[^\n;]*/(?:add|delete)\b|"
    r"\bnet(?:\.exe)?\s+user\s+[^\s;/|&]+\s+(?!/)[^\s;|&]+(?:\s|$)|"
    r"\bnetsh(?:\.exe)?\s+advfirewall\s+(?:set|add|delete|reset)\b|"
    r"\bSet-MpPreference\b[^\n;]*DisableRealtimeMonitoring\s+\$true\b|"
    r"\bStart-Process\b[^\n;]*\bRunAs\b|"
    r"\b(?:New|Remove|Set)-LocalUser\b|\b(?:Add|Remove)-LocalGroupMember\b|"
    r"\b(?:Disable|Enable|New|Set|Remove)-NetFirewallRule\b|\bSet-NetFirewallProfile\b|"
    r"\bAdd-MpPreference\b(?=[^\n;]*-Exclusion(?:Extension|IpAddress|Path|Process)\b)[^\n;]*|"
    r"\bSet-MpPreference\b(?=[^\n;]*(?:"
    r"-(?:DisableBehaviorMonitoring|DisableIOAVProtection|DisableScriptScanning)\s+\$true\b|"
    r"-Exclusion(?:Extension|IpAddress|Path|Process)\b|"
    r"-MAPSReporting\s+(?:0|Disabled)\b|-SubmitSamplesConsent\s+(?:2|NeverSend)\b))[^\n;]*|"
    r"\bImport-Certificate\b(?=[^\n;]*-CertStoreLocation\s+(?:['\"])?Cert:\\LocalMachine\\"
    r"(?:Root|TrustedPublisher)\b)[^\n;]*|"
    r"\bcertutil(?:\.exe)?\s+-addstore\s+(?:Root|TrustedPublisher)\b)",
    re.IGNORECASE,
)
_BCD_STORE_NAME_PATTERN = r"(?:bcd\d{8}|(?:offline|temp)_bcd[\w-]*|bcd_test)"
_BCD_STORE_REFERENCE_RE = re.compile(rf"\b{_BCD_STORE_NAME_PATTERN}\b", re.IGNORECASE)
_REG_BCD_MUTATION_RE = re.compile(
    _CMDPOS + rf"reg(?:\.exe)?\s+(?:add|delete|restore)\b(?=[^\n;|&]*\b{_BCD_STORE_NAME_PATTERN}\b)",
    re.IGNORECASE,
)
_POWERSHELL_BCD_MUTATION_RE = re.compile(
    r"\b(?:CreateSubKey|DeleteSubKey(?:Tree)?|SetValue|SetAccessControl)\s*\(|"
    r"(?:New|Set|Remove)-Item(?:Property)?\b",
    re.IGNORECASE,
)


def detect_product_install_dir_access(action: RuntimeAction) -> BaselineResult:
    """Deny shell commands that reference the packaged application directory."""
    if action.app_dir is None:
        return BaselineResult.no_signal()
    if any(
        is_path_within_protected_root(path, action.app_dir, action.app_dir_exclusions)
        for path in action.resolved_paths
    ) or contains_protected_app_dir_reference(
        action.normalized_payload,
        action.app_dir,
        action.app_dir_exclusions,
    ):
        return result_for(
            filesystem_rules.PRODUCT_INSTALL_DIR_ACCESS,
            action,
            rule_content="product_install_dir_access",
        )
    return BaselineResult.no_signal()


def detect_pro_host_bridge_command(action: RuntimeAction) -> BaselineResult:
    """Deny host-control commands and Windows executable bridges in Pro."""
    if action.profile == BuildProfile.LITE:
        return BaselineResult.no_signal()
    if any(
        invocation.executable.strip().strip("\"'`").casefold().endswith(_WINDOWS_HOST_EXECUTABLE_SUFFIXES)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(terminal_rules.HOST_BRIDGE_COMMAND, action, rule_content="host_bridge_command")
    return BaselineResult.no_signal()


def detect_host_credential_store_access(action: RuntimeAction) -> BaselineResult:
    """Deny shell access to OS-level credential stores."""
    if contains_host_credential_store_path(action.normalized_payload) or any(is_host_credential_store_path(path) for path in action.resolved_paths):
        return result_for(terminal_rules.HOST_CREDENTIAL_STORE_ACCESS, action, rule_content="host_credential_store_access")
    return BaselineResult.no_signal()


def detect_shell_host_system_mutation(action: RuntimeAction) -> BaselineResult:
    """Deny shell mutations against host system paths."""
    command = action.normalized_payload
    if any(is_host_system_mutation_path(path) for path in mutation_paths(action)):
        return result_for(terminal_rules.HOST_SYSTEM_PATH_MUTATION, action, rule_content="host_system_path_mutation")
    has_host_system_path = contains_host_system_mutation_path(command) or any(is_host_system_mutation_path(path) for path in action.resolved_paths)
    if not has_host_system_path:
        return BaselineResult.no_signal()
    executable_command = analyze_shell_text(command).executable_text
    if (
        _HOST_SYSTEM_MUTATION_COMMAND_RE.search(executable_command)
        or _HOST_SYSTEM_MUTATION_API_RE.search(executable_command)
        or _redirects_to_host_system_path(command)
    ):
        return result_for(terminal_rules.HOST_SYSTEM_PATH_MUTATION, action, rule_content="host_system_path_mutation")
    return BaselineResult.no_signal()


def detect_windows_bcd_store_mutation(action: RuntimeAction) -> BaselineResult:
    """Deny direct registry and PowerShell mutations of Windows BCD stores."""
    command = action.normalized_payload
    if not _BCD_STORE_REFERENCE_RE.search(command):
        return BaselineResult.no_signal()
    executable_command = analyze_shell_text(command).executable_text
    if _REG_BCD_MUTATION_RE.search(command) or _POWERSHELL_BCD_MUTATION_RE.search(executable_command):
        return result_for(command_rules.WINDOWS_BCDEDIT, action, rule_content="windows_bcd_store_mutation")
    return BaselineResult.no_signal()


def detect_linux_sensitive_path_read(action: RuntimeAction) -> BaselineResult:
    """Deny direct shell reads of Linux credential and privilege files."""
    if _LINUX_SENSITIVE_READ_RE.search(action.normalized_payload):
        return result_for(terminal_rules.LINUX_SENSITIVE_PATH_READ, action, rule_content="linux_sensitive_path_read")
    return BaselineResult.no_signal()


def detect_linux_system_path_mutation(action: RuntimeAction) -> BaselineResult:
    """Deny shell mutations against critical Linux system paths."""
    if any(is_linux_critical_system_path(path) for path in mutation_paths(action)):
        return result_for(terminal_rules.LINUX_SYSTEM_PATH_MUTATION, action, rule_content="linux_system_path_mutation")
    return BaselineResult.no_signal()


def detect_hexagent_config_write(action: RuntimeAction) -> BaselineResult:
    """Detect shell mutations of critical Windows product configuration files."""
    if _mutates_hexagent_config(action):
        return result_for(filesystem_rules.HEXAGENT_CONFIG_WRITE, action)
    return BaselineResult.no_signal()


def _mutates_hexagent_config(action: RuntimeAction) -> bool:
    targets = (*mutation_paths(action), *mutation_target_values(action))
    return any(contains_hexagent_self_protection_path(target) for target in targets)


def detect_lite_windows_security_change(action: RuntimeAction) -> BaselineResult:
    """Detect Lite-only Windows security configuration changes."""
    invocations = profile_shell_command(action.normalized_payload).invocations
    if _contains_persistent_execution_policy_change(invocations):
        return result_for(ask_rules.LITE_WINDOWS_SECURITY_CHANGE, action)
    if _contains_untrusted_bypass_execution(
        action,
        invocations,
    ):
        return result_for(
            ask_rules.LITE_WINDOWS_SECURITY_CHANGE,
            action,
            reason="以绕过执行策略的方式运行非已安装技能脚本",
        )
    if any(
        _LITE_WINDOWS_SECURITY_CHANGE_RE.search(invocation.raw_segment)
        for invocation in invocations
        if invocation.canonical_name
        in {
            "add-localgroupmember",
            "add-mppreference",
            "certutil",
            "disable-netfirewallrule",
            "enable-netfirewallrule",
            "import-certificate",
            "net",
            "netsh",
            "new-localuser",
            "new-netfirewallrule",
            "remove-localgroupmember",
            "remove-localuser",
            "remove-netfirewallrule",
            "set-localuser",
            "set-mppreference",
            "set-netfirewallprofile",
            "set-netfirewallrule",
            "start-process",
        }
    ):
        return result_for(ask_rules.LITE_WINDOWS_SECURITY_CHANGE, action)
    return BaselineResult.no_signal()


def _contains_persistent_execution_policy_change(invocations: tuple[CommandInvocation, ...]) -> bool:
    for invocation in invocations:
        if invocation.canonical_name != "set-executionpolicy":
            continue
        lowered = tuple(arg.casefold() for arg in invocation.args)
        scope = _option_value(lowered, "-scope")
        if "-force" in lowered or not scope or scope in {"currentuser", "localmachine"}:
            return True
    return False


def _contains_untrusted_bypass_execution(
    action: RuntimeAction,
    invocations: tuple[CommandInvocation, ...],
) -> bool:
    current_dir = action.cwd
    for invocation in invocations:
        if invocation.canonical_name in {"cd", "chdir", "set-location", "sl"}:
            target = _directory_argument(invocation.args)
            current_dir = resolve_shell_path(target, current_dir) if target else ""
            continue
        if invocation.canonical_name not in {"powershell", "pwsh"}:
            continue
        lowered = tuple(arg.casefold() for arg in invocation.args)
        if _option_value(lowered, "-executionpolicy") != "bypass":
            continue
        script = _option_value(invocation.args, "-file")
        if not script:
            if any(arg in {"-command", "-encodedcommand", "-enc"} for arg in lowered):
                return True
            continue
        resolved_script = resolve_shell_path(script, current_dir)
        if not is_hexagent_installed_skill_script(resolved_script):
            return True
    return False


def _option_value(args: tuple[str, ...], option: str) -> str:
    lowered_option = option.casefold()
    for index, arg in enumerate(args):
        lowered = arg.casefold()
        if lowered == lowered_option and index + 1 < len(args):
            return args[index + 1]
        if lowered.startswith((f"{lowered_option}:", f"{lowered_option}=")):
            return arg[len(option) + 1 :]
    return ""


def _directory_argument(args: tuple[str, ...]) -> str:
    return next((arg for arg in args if arg.casefold() != "/d" and not arg.startswith("-")), "")


def detect_lite_windows_registry_mutation(action: RuntimeAction) -> BaselineResult:
    """Detect opaque imports or explicit system-hive mutations on Lite Windows."""
    executable = analyze_shell_text(action.normalized_payload).executable_text
    if _contains_registry_mutation_api(executable) and _contains_system_registry_hive(action.normalized_payload):
        return result_for(ask_rules.LITE_WINDOWS_REGISTRY_MUTATION, action)
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if _mutates_windows_registry(invocation.canonical_name, invocation.args, invocation.raw_segment):
            return result_for(ask_rules.LITE_WINDOWS_REGISTRY_MUTATION, action)
    return BaselineResult.no_signal()


def _mutates_windows_registry(command: str, args: tuple[str, ...], raw_segment: str) -> bool:
    if command == "reg":
        return _mutates_registry_with_reg(args)
    if command == "regedit":
        return any(arg.casefold() == "/s" for arg in args) and any(not arg.startswith("/") for arg in args)
    if command == "regini":
        return bool(args) and not any(arg.casefold() in {"/?", "-?", "--help"} for arg in args)
    if command in {"new-item", "new-itemproperty", "remove-item", "remove-itemproperty", "set-item", "set-itemproperty"}:
        return _contains_system_registry_hive(raw_segment)
    if command in {"powershell", "pwsh"}:
        return _contains_registry_mutation_api(raw_segment) and _contains_system_registry_hive(raw_segment)
    return False


def _mutates_registry_with_reg(args: tuple[str, ...]) -> bool:
    if not args or any(arg.casefold() in {"/?", "/h", "/help", "help"} for arg in args):
        return False
    operation = args[0].casefold()
    if operation == "import":
        return len(args) > 1
    target_index = 2 if operation == "copy" else 1
    if operation not in {"add", "copy", "delete", "load", "restore", "unload"} or len(args) <= target_index:
        return False
    return _is_system_registry_hive(args[target_index])


def _is_system_registry_hive(value: str) -> bool:
    key = value.strip().strip("\"'`").replace("/", "\\").casefold()
    roots = {
        "hkcc",
        "hkcr",
        "hklm",
        "hku",
        "hkey_classes_root",
        "hkey_current_config",
        "hkey_local_machine",
        "hkey_users",
    }
    return any(key == root or key.startswith(f"{root}\\") for root in roots)


def _contains_system_registry_hive(command: str) -> bool:
    normalized = command.replace("/", "\\").casefold()
    return re.search(
        r"(?:registry::)?(?:hkey_local_machine|hkey_classes_root|hkey_users|hkey_current_config)\\|"
        r"(?:hklm|hkcr|hku|hkcc):?\\",
        normalized,
    ) is not None


def _contains_registry_mutation_api(command: str) -> bool:
    return re.search(
        r"\b(?:CreateSubKey|DeleteSubKey(?:Tree)?|SetValue|SetAccessControl)\s*\(",
        command,
        re.IGNORECASE,
    ) is not None


def _redirects_to_host_system_path(command: str) -> bool:
    for match in _HOST_SYSTEM_REDIRECT_RE.finditer(command):
        target = match.group(0).lstrip("> ").strip()
        if is_host_system_mutation_path(target):
            return True
    return False
