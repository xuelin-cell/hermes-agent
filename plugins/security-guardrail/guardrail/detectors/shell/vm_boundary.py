"""Pro VM boundary, control-plane, and availability detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...baseline_rules import result_for
from ...baseline_rules.shell import terminal as rules
from .profile import CommandInvocation, profile_shell_command
from ...path_policy import (
    is_vm_control_socket_path,
    is_vm_guest_security_control_path,
    is_vm_host_mount_path,
    is_vm_host_mount_root,
    is_vm_host_sensitive_path,
    normalize_path_for_policy,
)
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult, BaselineVerdict

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from ...action import RuntimeAction

_MOUNT_COMMANDS = frozenset({"mount", "umount", "fusermount", "fusermount3"})
_ALWAYS_ESCAPE_COMMANDS = frozenset({"insmod", "modprobe", "nsenter", "pivot_root", "rmmod", "switch_root"})
_CONTROL_SOCKET_COMMANDS = frozenset(
    {"cat", "chmod", "chown", "cp", "curl", "docker", "mount", "mv", "nc", "ncat", "rm", "socat", "tee", "umount"},
)
_DIRECT_PATH_MUTATION_COMMANDS = frozenset({"chmod", "chown", "mkdir", "rm", "shred", "tee", "touch", "truncate"})
_GUEST_CONTROL_REDIRECT_RE = re.compile(r">>?\s*(?:['\"])?(?P<path>/[^\s'\";|&]+)", re.IGNORECASE)
_YES_REDIRECT_RE = re.compile(r"(?:^|[;&|\n])\s*yes\b[^;|\n]*>\s*(?!/dev/null(?:\s|$))\S+", re.IGNORECASE)
_HUGE_ALLOCATION_RE = re.compile(r"^(?P<amount>\d+(?:\.\d+)?)(?P<unit>[kmgtpe])(?:i?b)?$", re.IGNORECASE)
_HUGE_ALLOCATION_BYTES = 100 * 1024**3
_SIZE_MULTIPLIERS = {
    "k": 1024,
    "m": 1024**2,
    "g": 1024**3,
    "t": 1024**4,
    "p": 1024**5,
    "e": 1024**6,
}


def detect_terminal_deny(action: RuntimeAction) -> BaselineResult:
    """Run Pro VM terminal-deny detectors in stable policy order."""
    detectors: tuple[Callable[[RuntimeAction], BaselineResult], ...] = (
        detect_host_mount_sensitive_access,
        detect_host_mount_boundary_tampering,
        detect_host_mount_root_destruction,
        detect_guest_security_control_tampering,
        detect_host_control_socket_access,
        detect_escape_primitive,
        detect_resource_exhaustion,
    )
    for detector in detectors:
        result = detector(action)
        if result.verdict == BaselineVerdict.TERMINAL_DENY:
            return result
    return BaselineResult.no_signal()


def detect_host_mount_sensitive_access(action: RuntimeAction) -> BaselineResult:
    """Deny shell access to credentials exposed through known VM mounts."""
    if any(is_vm_host_sensitive_path(value) for invocation in _invocations(action) for value in _argument_views(invocation.args)):
        return result_for(rules.VM_HOST_MOUNT_SENSITIVE_ACCESS, action, rule_content="host_mount_sensitive_access")
    return BaselineResult.no_signal()


def detect_host_mount_boundary_tampering(action: RuntimeAction) -> BaselineResult:
    """Deny mount mutations involving a recognizable host-mounted path."""
    for invocation in _invocations(action):
        if invocation.canonical_name not in _MOUNT_COMMANDS or not invocation.args:
            continue
        if any(is_vm_host_mount_path(value) for value in _argument_views(invocation.args)):
            return result_for(rules.VM_HOST_MOUNT_BOUNDARY_TAMPERING, action, rule_content="host_mount_boundary_tampering")
    return BaselineResult.no_signal()


def detect_host_mount_root_destruction(action: RuntimeAction) -> BaselineResult:
    """Deny destructive operations aimed at an explicit host-mount root."""
    for invocation in _invocations(action):
        args = invocation.args
        roots = tuple(value for value in _argument_views(args) if is_vm_host_mount_root(value))
        if not roots:
            continue
        command = invocation.canonical_name
        if command == "rm" and _has_recursive_flag(args):
            return result_for(rules.VM_HOST_MOUNT_ROOT_DESTRUCTION, action, rule_content="host_mount_root_destruction")
        if command in {"chmod", "chown"} and _has_recursive_flag(args):
            return result_for(rules.VM_HOST_MOUNT_ROOT_DESTRUCTION, action, rule_content="host_mount_root_destruction")
        if command == "find" and _find_is_destructive(args):
            return result_for(rules.VM_HOST_MOUNT_ROOT_DESTRUCTION, action, rule_content="host_mount_root_destruction")
        if command == "shred":
            return result_for(rules.VM_HOST_MOUNT_ROOT_DESTRUCTION, action, rule_content="host_mount_root_destruction")
    return BaselineResult.no_signal()


def detect_guest_security_control_tampering(action: RuntimeAction) -> BaselineResult:
    """Deny writes to managed guest controls without consulting workspace state."""
    for invocation in _invocations(action):
        if _mutates_guest_security_control(invocation):
            return result_for(rules.VM_GUEST_SECURITY_CONTROL_TAMPERING, action, rule_content="guest_security_control_tampering")
    return BaselineResult.no_signal()


def detect_host_control_socket_access(action: RuntimeAction) -> BaselineResult:
    """Deny direct use or mutation of recognized VM and container control sockets."""
    for invocation in _invocations(action):
        if invocation.canonical_name not in _CONTROL_SOCKET_COMMANDS:
            continue
        if any(is_vm_control_socket_path(value) for value in _argument_views(invocation.args)):
            return result_for(rules.VM_HOST_CONTROL_SOCKET_ACCESS, action, rule_content="host_control_socket_access")
    return BaselineResult.no_signal()


def detect_escape_primitive(action: RuntimeAction) -> BaselineResult:
    """Deny explicit guest-boundary escape and kernel-control primitives."""
    for invocation in _invocations(action):
        command = invocation.canonical_name
        args = invocation.args
        if command in _ALWAYS_ESCAPE_COMMANDS:
            return result_for(rules.VM_ESCAPE_PRIMITIVE, action, rule_content="escape_primitive")
        if command == "chroot" and any(is_vm_host_mount_path(value) for value in _argument_views(args)):
            return result_for(rules.VM_ESCAPE_PRIMITIVE, action, rule_content="escape_primitive")
        if command == "docker" and _privileged_container_uses_host_mount(args):
            return result_for(rules.VM_ESCAPE_PRIMITIVE, action, rule_content="escape_primitive")
        if command == "mount" and _mounts_kernel_control_filesystem(args):
            return result_for(rules.VM_ESCAPE_PRIMITIVE, action, rule_content="escape_primitive")
    return BaselineResult.no_signal()


def detect_resource_exhaustion(action: RuntimeAction) -> BaselineResult:
    """Deny explicit unbounded or oversized VM resource consumption."""
    executable_text = analyze_shell_text(action.normalized_payload).executable_text
    if _YES_REDIRECT_RE.search(executable_text):
        return result_for(rules.VM_RESOURCE_EXHAUSTION, action, rule_content="resource_exhaustion")

    for invocation in _invocations(action):
        command = invocation.canonical_name
        args = invocation.args
        if command == "dd" and _is_unbounded_zero_fill(args):
            return result_for(rules.VM_RESOURCE_EXHAUSTION, action, rule_content="resource_exhaustion")
        if command in {"fallocate", "truncate"} and _has_huge_allocation(args):
            return result_for(rules.VM_RESOURCE_EXHAUSTION, action, rule_content="resource_exhaustion")
        if command in {"stress", "stress-ng"} and not _has_timeout(args):
            return result_for(rules.VM_RESOURCE_EXHAUSTION, action, rule_content="resource_exhaustion")
    return BaselineResult.no_signal()


def _invocations(action: RuntimeAction) -> tuple[CommandInvocation, ...]:
    return profile_shell_command(action.normalized_payload).invocations


def _argument_views(args: Iterable[str]) -> tuple[str, ...]:
    views: list[str] = []
    for arg in args:
        cleaned = arg.strip().strip("\"'`").lstrip("<>").removeprefix("@")
        if not cleaned:
            continue
        if cleaned.casefold().startswith("unix://"):
            cleaned = cleaned[7:]
        for prefix in ("unix-connect:", "unix-listen:"):
            if cleaned.casefold().startswith(prefix):
                cleaned = cleaned[len(prefix) :]
                break
        views.append(cleaned)

        for fragment in cleaned.split(","):
            _key, separator, value = fragment.partition("=")
            if separator and value:
                views.append(value)

        if cleaned.startswith("/") and ":" in cleaned:
            views.append(cleaned.split(":", 1)[0])
    return tuple(dict.fromkeys(views))


def _has_recursive_flag(args: tuple[str, ...]) -> bool:
    return any(
        arg.casefold() == "--recursive" or (arg.startswith("-") and not arg.startswith("--") and "r" in arg.casefold()[1:])
        for arg in args
    )


def _find_is_destructive(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if "-delete" in lowered:
        return True
    if "-exec" not in lowered and "-execdir" not in lowered:
        return False
    return any(normalize_path_for_policy(arg).rsplit("/", 1)[-1] in {"gpg", "openssl", "rm", "shred"} for arg in args)


def _mutates_guest_security_control(invocation: CommandInvocation) -> bool:
    command = invocation.canonical_name
    args = invocation.args
    protected = tuple(value for value in _argument_views(args) if is_vm_guest_security_control_path(value))
    mutates = False
    if (
        (command == "sysctl" and any(arg.casefold() in {"-w", "--write"} for arg in args))
        or (command == "systemctl" and args and args[0].casefold() in {"disable", "edit", "enable", "link", "mask", "reenable", "unmask"})
        or (protected and (command in _DIRECT_PATH_MUTATION_COMMANDS or command == "mv"))
    ):
        mutates = True
    elif protected and command == "sed":
        mutates = any(arg.casefold() == "--in-place" or arg.casefold().startswith("-i") for arg in args)
    elif protected and command in {"cp", "install", "ln"}:
        mutates = is_vm_guest_security_control_path(next(reversed(_argument_views(args)), ""))
    elif protected and command == "dd":
        mutates = any(arg.casefold().startswith("of=") and is_vm_guest_security_control_path(arg.partition("=")[2]) for arg in args)
    elif protected:
        mutates = any(
            is_vm_guest_security_control_path(match.group("path"))
            for match in _GUEST_CONTROL_REDIRECT_RE.finditer(invocation.raw_segment)
        )
    return mutates


def _privileged_container_uses_host_mount(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if not lowered or lowered[0] != "run" or "--privileged" not in lowered:
        return False
    return any(is_vm_host_mount_path(value) for value in _argument_views(args))


def _mounts_kernel_control_filesystem(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    filesystem_types = {"proc", "sysfs"}
    type_values = {lowered[index + 1] for index, arg in enumerate(lowered[:-1]) if arg in {"-t", "--types"}}
    binds_kernel_path = any(arg in {"--bind", "--rbind"} for arg in lowered) and any(
        normalize_path_for_policy(value) in {"/dev", "/proc", "/sys"} for value in _argument_views(args)
    )
    return bool(type_values & filesystem_types) or binds_kernel_path


def _is_unbounded_zero_fill(args: tuple[str, ...]) -> bool:
    assignments = {key.casefold(): value for arg in args for key, separator, value in (arg.partition("="),) if separator}
    output = normalize_path_for_policy(assignments.get("of", ""))
    return assignments.get("if", "").casefold() == "/dev/zero" and bool(output) and output != "/dev/null" and "count" not in assignments


def _has_huge_allocation(args: tuple[str, ...]) -> bool:
    for index, arg in enumerate(args):
        option, separator, value = arg.partition("=")
        if option.casefold() not in {"-l", "--length", "-s", "--size"}:
            continue
        candidate = value if separator else (args[index + 1] if index + 1 < len(args) else "")
        match = _HUGE_ALLOCATION_RE.fullmatch(candidate.strip())
        if match is None:
            continue
        amount = float(match.group("amount"))
        if amount * _SIZE_MULTIPLIERS[match.group("unit").casefold()] >= _HUGE_ALLOCATION_BYTES:
            return True
    return False


def _has_timeout(args: tuple[str, ...]) -> bool:
    return any(arg.casefold() in {"-t", "--timeout"} or arg.casefold().startswith("--timeout=") for arg in args)
