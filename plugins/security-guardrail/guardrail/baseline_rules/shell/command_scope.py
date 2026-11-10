"""Command prefilter scopes for all terminal-deny shell rules."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from enum import Enum

from .commands import COMMAND_POLICIES, COMMAND_RULES
from .terminal import TERMINAL_RULES as CONTEXT_TERMINAL_RULES


class ShellCommandScopeKind(str, Enum):
    """Supported shell command prefilter modes."""

    NAMES = "names"
    SUFFIXES = "suffixes"
    ANY = "any"


@dataclass(frozen=True)
class ShellCommandScope:
    """A necessary command condition used only to narrow detector candidates."""

    kind: ShellCommandScopeKind
    values: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        """Reject ambiguous empty or populated scope definitions."""
        if self.kind == ShellCommandScopeKind.ANY and self.values:
            message = "ANY shell command scopes cannot declare values"
            raise ValueError(message)
        if self.kind != ShellCommandScopeKind.ANY and not self.values:
            message = f"{self.kind.value} shell command scopes require values"
            raise ValueError(message)


def _names(*values: str) -> ShellCommandScope:
    return ShellCommandScope(ShellCommandScopeKind.NAMES, frozenset(value.casefold() for value in values))


def _suffixes(*values: str) -> ShellCommandScope:
    return ShellCommandScope(ShellCommandScopeKind.SUFFIXES, frozenset(value.casefold() for value in values))


ANY_SHELL_COMMAND = ShellCommandScope(ShellCommandScopeKind.ANY)


def _command_policy_scopes() -> dict[str, ShellCommandScope]:
    names_by_rule_id: dict[str, set[str]] = defaultdict(set)
    for policy in COMMAND_POLICIES:
        for command_rule in policy.rules:
            names_by_rule_id[command_rule.rule.id].add(policy.canonical_name.casefold())
    return {rule_id: _names(*sorted(names)) for rule_id, names in names_by_rule_id.items()}


_CONTEXT_COMMAND_SCOPES: dict[str, ShellCommandScope] = {
    "common.windows.bcdedit": _names("bcdedit", "py", "python", "python3", "powershell", "pwsh", "reg"),
    "common.shell.host_credential_store_access": ANY_SHELL_COMMAND,
    "pro.shell.host_bridge_command": _suffixes(".bat", ".cmd", ".exe", ".ps1"),
    "common.shell.linux_sensitive_path_read": _names("awk", "cat", "grep", "head", "less", "more", "sed", "tail"),
    "common.shell.host_system_path_mutation": ANY_SHELL_COMMAND,
    "common.shell.linux_system_path_mutation": ANY_SHELL_COMMAND,
    "common.shell.audit_service_tampering": _names("auditctl", "kill", "killall", "pkill", "service", "systemctl"),
    "common.shell.destructive_encryption": _names("cryptsetup", "find", "gpg", "openssl"),
    "common.shell.container_escape": _names("docker"),
    "common.shell.host_root_mount_destructive_container": _names("docker"),
    "common.shell.k8s_mass_delete": _names("kubectl"),
    "common.shell.network_flood": ANY_SHELL_COMMAND,
    "common.shell.docker_destructive_terminal": _names("docker"),
    "common.shell.cloud_destructive_terminal": _names("aws", "curl", "gcloud"),
    "common.shell.network_attack_terminal": _names("curl", "hydra", "masscan", "sqlmap"),
    "common.shell.persisted_reverse_shell": _names("bash", "echo", "ksh", "nc", "ncat", "sh", "socat", "zsh"),
    "common.shell.persistence_terminal": _names("echo", "launchctl", "printf", "systemctl"),
    "common.shell.reverse_shell": _names("bash", "ksh", "msfvenom", "nc", "ncat", "perl", "php", "python", "python3", "ruby", "sh", "socat", "zsh"),
    "common.shell.remote_script_execution": _names(
        "bash",
        "curl",
        "eval",
        "iex",
        "invoke-expression",
        "invoke-restmethod",
        "invoke-webrequest",
        "irm",
        "iwr",
        "powershell",
        "python",
        "python3",
        "sh",
        "wget",
    ),
    "common.shell.system_stability_destroy": _names("killall5", "pkill", "umount"),
    "common.shell.windows_destructive_command": _names("del", "format", "reg", "remove-item"),
    "common.shell.windows_root_recursive_delete": _names("cmd", "gci", "get-childitem", "rd", "remove-item", "ri", "rm", "rmdir"),
    "common.shell.destructive_filesystem": _names("chmod", "chown", "find", "mv", "rm"),
    "common.shell.system_file_truncate": ANY_SHELL_COMMAND,
    "common.shell.obfuscated_terminal_command": ANY_SHELL_COMMAND,
    "common.shell.indirect_terminal_command": _names("at", "bash", "env", "sh", "xargs", "zsh"),
    "common.shell.raw_device_redirect": ANY_SHELL_COMMAND,
    "common.shell.rm_root": _names("rm"),
    "common.shell.rm_system_dir": _names("rm"),
    "common.shell.rm_home": _names("rm"),
    "common.shell.raw_device_write": _names("dd"),
    "common.shell.fork_bomb": ANY_SHELL_COMMAND,
    "common.shell.kill_all": _names("kill"),
    "common.shell.telinit_power": _names("telinit"),
    "common.windows.format_drive": _names("format"),
    "common.windows.cipher_wipe": _names("cipher"),
    "pro.vm.host_mount_sensitive_access": ANY_SHELL_COMMAND,
    "pro.vm.host_mount_boundary_tampering": _names("fusermount", "fusermount3", "mount", "umount"),
    "pro.vm.host_mount_root_destruction": _names("chmod", "chown", "find", "rm", "shred"),
    "pro.vm.guest_security_control_tampering": ANY_SHELL_COMMAND,
    "pro.vm.host_control_socket_access": _names(
        "cat", "chmod", "chown", "cp", "curl", "docker", "mount", "mv", "nc", "ncat", "rm", "socat", "tee", "umount"
    ),
    "pro.vm.escape_primitive": _names("chroot", "docker", "insmod", "modprobe", "mount", "nsenter", "pivot_root", "rmmod", "switch_root"),
    "pro.vm.resource_exhaustion": _names("dd", "fallocate", "stress", "stress-ng", "truncate", "yes"),
}


SHELL_COMMAND_SCOPES: dict[str, ShellCommandScope] = {
    **_command_policy_scopes(),
    **_CONTEXT_COMMAND_SCOPES,
}


def validate_shell_command_scopes() -> None:
    """Require an explicit scope for every terminal-deny shell rule."""
    expected_ids = {rule.id for rule in (*COMMAND_RULES, *CONTEXT_TERMINAL_RULES)}
    actual_ids = set(SHELL_COMMAND_SCOPES)
    if missing := expected_ids - actual_ids:
        message = f"shell terminal rules missing command scopes: {sorted(missing)!r}"
        raise ValueError(message)
    if unknown := actual_ids - expected_ids:
        message = f"command scopes reference unknown shell terminal rules: {sorted(unknown)!r}"
        raise ValueError(message)


validate_shell_command_scopes()
