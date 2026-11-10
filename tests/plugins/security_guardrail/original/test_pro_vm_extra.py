"""Tests for Pro VM-specific terminal-deny rules."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from _guardrail_migrated.guardrail.baseline import check_terminal_baseline
from _guardrail_migrated.guardrail.baseline_rules import ALL_RULES, BaselineRuleSet
from _guardrail_migrated.guardrail.detectors.shell import vm_boundary
from _guardrail_migrated.guardrail.normalizer import normalize_runtime_action
from _guardrail_migrated.guardrail.signals import BaselineResult, BaselineVerdict
from _guardrail_migrated.guardrail.types import BuildProfile, OperatingSystem, PermissionMode, ToolCallOrigin

if TYPE_CHECKING:
    from _guardrail_migrated.guardrail.action import RuntimeAction

_VM_RULE_IDS = {
    "pro.filesystem.vm_guest_security_control_tampering",
    "pro.filesystem.vm_host_control_socket_access",
    "pro.filesystem.vm_host_mount_sensitive_access",
    "pro.vm.escape_primitive",
    "pro.vm.guest_security_control_tampering",
    "pro.vm.host_control_socket_access",
    "pro.vm.host_mount_boundary_tampering",
    "pro.vm.host_mount_root_destruction",
    "pro.vm.host_mount_sensitive_access",
    "pro.vm.resource_exhaustion",
}


def _action(
    tool_name: str,
    tool_input: dict[str, object],
    *,
    profile: BuildProfile = BuildProfile.PRO,
    cwd: str | None = None,
) -> RuntimeAction:
    return normalize_runtime_action(
        tool_call_id="pro-vm-test",
        tool_name=tool_name,
        tool_input=tool_input,
        cwd=cwd,
        origin=ToolCallOrigin(kind="agent"),
        profile=profile,
        mode=PermissionMode.AUTO,
        operating_system=OperatingSystem.LINUX,
    )


def _terminal(tool_name: str, tool_input: dict[str, object], *, profile: BuildProfile = BuildProfile.PRO) -> BaselineResult:
    return check_terminal_baseline(_action(tool_name, tool_input, profile=profile))


def test_vm_rules_are_linux_pro_extra_rules() -> None:
    rules = {rule.id: rule for rule in ALL_RULES if rule.id in _VM_RULE_IDS}

    assert set(rules) == _VM_RULE_IDS
    assert all(rule.rule_set == BaselineRuleSet.PRO_EXTRA for rule in rules.values())
    assert all(rule.operating_systems == {OperatingSystem.LINUX} for rule in rules.values())


@pytest.mark.parametrize(
    ("tool_name", "tool_input"),
    [
        ("Bash", {"command": "mount --bind /tmp /sessions/alice/mnt/project"}),
        ("Bash", {"command": "rm -rf /sessions/alice/mnt/project"}),
        ("Read", {"file_path": "/sessions/alice/mnt/home/.ssh/id_ed25519"}),
        ("Bash", {"command": "printf x > /etc/wsl.conf"}),
        ("Bash", {"command": "nsenter --target 1 --mount /bin/sh"}),
        ("Bash", {"command": "curl --unix-socket /var/run/docker.sock http://localhost/info"}),
        ("Bash", {"command": "yes > /tmp/fill"}),
    ],
)
def test_vm_extra_rules_do_not_apply_to_lite(tool_name: str, tool_input: dict[str, object]) -> None:
    result = _terminal(tool_name, tool_input, profile=BuildProfile.LITE)

    assert result.verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    "command",
    [
        "env MODE=test /mnt/c/Tools/runner.exe --version",
        'bash -c "C:\\Tools\\cleanup.cmd /q"',
        "sudo powershell.exe -NoProfile -Command Get-ChildItem",
        "/mnt/c/scripts/setup.ps1",
    ],
)
def test_pro_windows_host_executable_bridge_is_terminal_deny(command: str) -> None:
    result = _terminal("Bash", {"command": command})

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == "pro.shell.host_bridge_command"


def test_quoted_host_executable_text_and_lite_execution_are_not_pro_bridge_denies() -> None:
    quoted = _terminal("Bash", {"command": "echo 'powershell.exe -Command Get-ChildItem'"})
    no_execution_bridge = _terminal("Bash", {"command": "diskutil list"})
    lite = _terminal("Bash", {"command": "tool.exe --version"}, profile=BuildProfile.LITE)

    assert quoted.verdict == BaselineVerdict.NO_SIGNAL
    assert no_execution_bridge.verdict == BaselineVerdict.NO_SIGNAL
    assert lite.verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    "command",
    [
        "mount --bind /tmp /sessions/alice/mnt/project",
        "mount -o remount,rw /mnt/c",
        "umount /mnt/hostmnt/home",
    ],
)
def test_host_mount_boundary_tampering_is_terminal_deny(command: str) -> None:
    result = _terminal("Bash", {"command": command})

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == "pro.vm.host_mount_boundary_tampering"


def test_read_only_mount_inspection_is_not_boundary_tampering() -> None:
    result = _terminal("Bash", {"command": "findmnt /sessions/alice/mnt/project"})

    assert result.verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf /sessions/alice/mnt/project",
        "rm --recursive --force /mnt/c/*",
        "chmod -R 000 /mnt/hostmnt/home",
        "find /sessions/alice/mnt/project -delete",
    ],
)
def test_host_mount_root_destruction_is_terminal_deny(command: str) -> None:
    result = _terminal("Bash", {"command": command})

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == "pro.vm.host_mount_root_destruction"


def test_vm_root_rule_does_not_use_working_directory_or_block_nested_cleanup() -> None:
    relative = _action("Bash", {"command": "rm -rf ."}, cwd="/sessions/alice/mnt/project")
    nested = _action("Bash", {"command": "rm -rf /sessions/alice/mnt/project/build"})

    assert vm_boundary.detect_terminal_deny(relative).verdict == BaselineVerdict.NO_SIGNAL
    assert vm_boundary.detect_terminal_deny(nested).verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    ("tool_name", "tool_input", "expected_rule_id"),
    [
        (
            "Bash",
            {"command": "cat /mnt/hostmnt/home/Library/Keychains/login.keychain-db"},
            "pro.vm.host_mount_sensitive_access",
        ),
        (
            "Read",
            {"file_path": "/sessions/alice/mnt/home/.ssh/id_ed25519"},
            "pro.filesystem.vm_host_mount_sensitive_access",
        ),
        (
            "Read",
            {"file_path": "/mnt/c/Windows/System32/config/SAM"},
            "common.filesystem.host_credential_store_access",
        ),
    ],
)
def test_host_mount_sensitive_access_is_terminal_deny(
    tool_name: str,
    tool_input: dict[str, object],
    expected_rule_id: str,
) -> None:
    result = _terminal(tool_name, tool_input)

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == expected_rule_id


def test_regular_host_mount_file_is_not_vm_sensitive_access() -> None:
    result = _terminal("Read", {"file_path": "/sessions/alice/mnt/project/README.md"})

    assert result.verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    ("tool_name", "tool_input", "expected_rule_id"),
    [
        ("Bash", {"command": "printf x > /etc/wsl.conf"}, "pro.vm.guest_security_control_tampering"),
        ("Bash", {"command": "sysctl -w kernel.core_pattern=/tmp/core"}, "pro.vm.guest_security_control_tampering"),
        ("Bash", {"command": "systemctl enable updater.service"}, "pro.vm.guest_security_control_tampering"),
        (
            "Write",
            {"file_path": "/etc/fstab", "content": "x"},
            "pro.filesystem.vm_guest_security_control_tampering",
        ),
    ],
)
def test_guest_security_control_tampering_is_terminal_deny(
    tool_name: str,
    tool_input: dict[str, object],
    expected_rule_id: str,
) -> None:
    result = _terminal(tool_name, tool_input)

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == expected_rule_id


def test_guest_security_control_read_is_not_vm_tampering() -> None:
    result = _terminal("Read", {"file_path": "/etc/wsl.conf"})

    assert result.verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    "command",
    [
        "nsenter --target 1 --mount /bin/sh",
        "docker run --privileged -v /mnt/c:/host ubuntu:latest",
        "chroot /mnt/hostmnt/home /bin/sh",
        "mount -t sysfs sysfs /tmp/sys",
    ],
)
def test_vm_escape_primitive_is_terminal_deny(command: str) -> None:
    result = _terminal("Bash", {"command": command})

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == "pro.vm.escape_primitive"


@pytest.mark.parametrize(
    ("tool_name", "tool_input", "expected_rule_id"),
    [
        (
            "Bash",
            {"command": "curl --unix-socket /var/run/docker.sock http://localhost/info"},
            "pro.vm.host_control_socket_access",
        ),
        (
            "Bash",
            {"command": "socat - UNIX-CONNECT:/run/wsl/123_interop"},
            "pro.vm.host_control_socket_access",
        ),
        (
            "Read",
            {"file_path": "/run/containerd/containerd.sock"},
            "pro.filesystem.vm_host_control_socket_access",
        ),
    ],
)
def test_vm_control_socket_access_is_terminal_deny(
    tool_name: str,
    tool_input: dict[str, object],
    expected_rule_id: str,
) -> None:
    result = _terminal(tool_name, tool_input)

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == expected_rule_id


def test_quoted_control_socket_text_is_not_vm_socket_access() -> None:
    result = _terminal("Bash", {"command": "echo '/var/run/docker.sock'"})

    assert result.verdict == BaselineVerdict.NO_SIGNAL


@pytest.mark.parametrize(
    "command",
    [
        "yes > /tmp/fill",
        "dd if=/dev/zero of=/tmp/fill bs=1M",
        "fallocate -l 100G /tmp/fill",
        "stress-ng --cpu 4",
    ],
)
def test_vm_resource_exhaustion_is_terminal_deny(command: str) -> None:
    result = _terminal("Bash", {"command": command})

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == "pro.vm.resource_exhaustion"


@pytest.mark.parametrize(
    "command",
    [
        "dd if=/dev/zero of=/tmp/test.bin bs=1M count=1",
        "fallocate -l 1G /tmp/test.bin",
        "stress-ng --cpu 1 --timeout 2s",
    ],
)
def test_bounded_vm_resource_commands_are_not_terminal_deny(command: str) -> None:
    result = _terminal("Bash", {"command": command})

    assert result.verdict == BaselineVerdict.NO_SIGNAL
