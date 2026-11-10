"""Filesystem terminal-deny and approval detectors."""

from __future__ import annotations

from ..runtime import path_exists

from typing import TYPE_CHECKING

from ..action import RuntimeOperation, ToolType, WorkspaceScope
from ..baseline_rules import filesystem as rules
from ..baseline_rules import result_for
from ..baseline_rules.shell import ask as shell_ask_rules
from ..path_policy import (
    contains_hexagent_self_protection_path,
    is_current_windows_temporary_delete_target,
    is_hexagent_public_skill_descendant,
    is_host_credential_store_path,
    is_host_system_mutation_path,
    is_linux_critical_system_path,
    is_linux_sensitive_path,
    is_managed_session_workspace,
    is_path_within_protected_root,
    is_recognized_temporary_descendant,
    is_user_persistence_path,
    is_vm_control_socket_path,
    is_vm_guest_security_control_path,
    is_vm_host_sensitive_path,
    paths_are_at_or_below_windows_user_sessions,
    paths_are_strictly_within_managed_session_workspace,
)
from ..signals import BaselineResult, BaselineVerdict
from ..types import BuildProfile, OperatingSystem

if TYPE_CHECKING:
    from ..action import RuntimeAction
    from ..baseline_rules.selection import ActiveRuleSet

_RAW_DEVICE_MUTATION_PREFIXES = (
    "/dev/sd",
    "/dev/vd",
    "/dev/xvd",
    "/dev/nvme",
)


def detect_terminal_deny(action: RuntimeAction) -> BaselineResult:
    """Detect filesystem actions that must be denied."""
    for detector in (
        detect_product_install_dir_access,
        detect_linux_sensitive_path_read,
        detect_system_path_mutation,
        detect_host_system_path_mutation,
        detect_host_credential_store_access,
        detect_vm_host_mount_sensitive_access,
        detect_vm_guest_security_control_tampering,
        detect_vm_control_socket_access,
    ):
        result = detector(action)
        if result.verdict == BaselineVerdict.TERMINAL_DENY:
            return result
    return BaselineResult.no_signal()


def detect_product_install_dir_access(action: RuntimeAction) -> BaselineResult:
    """Deny every agent filesystem access at or below the packaged app root."""
    if action.tool_type != ToolType.FILESYSTEM or action.app_dir is None:
        return BaselineResult.no_signal()
    if any(
        is_path_within_protected_root(path, action.app_dir, action.app_dir_exclusions)
        for path in _path_values(action)
    ):
        return result_for(rules.PRODUCT_INSTALL_DIR_ACCESS, action, rule_content="product_install_dir_access")
    return BaselineResult.no_signal()


def detect_linux_sensitive_path_read(action: RuntimeAction) -> BaselineResult:
    """Deny filesystem reads of critical Linux account and privilege files."""
    if action.tool_type != ToolType.FILESYSTEM or action.operation != RuntimeOperation.READ:
        return BaselineResult.no_signal()
    if any(is_linux_sensitive_path(path) for path in _path_values(action)):
        return result_for(rules.LINUX_SENSITIVE_PATH_READ, action, rule_content="linux_sensitive_path_read")
    return BaselineResult.no_signal()


def detect_ask(action: RuntimeAction, *, active_rules: ActiveRuleSet | None = None) -> BaselineResult:
    """Require approval for protected or workspace-external mutations."""
    for detector in (
        detect_hexagent_config_write,
        detect_user_persistence_mutation,
        detect_delete_mutation,
        detect_workspace_external_mutation,
    ):
        result = detector(action)
        if result.verdict == BaselineVerdict.ASK_REQUIRED and (active_rules is None or active_rules.contains(result.rule_id)):
            return result
    return BaselineResult.no_signal()


def detect_hexagent_config_write(action: RuntimeAction) -> BaselineResult:
    """Detect mutations of critical Windows product configuration files."""
    if action.operation not in {RuntimeOperation.WRITE, RuntimeOperation.DELETE}:
        return BaselineResult.no_signal()
    if any(contains_hexagent_self_protection_path(path) for path in _path_values(action)):
        return result_for(rules.HEXAGENT_CONFIG_WRITE, action)
    return BaselineResult.no_signal()


def detect_user_persistence_mutation(action: RuntimeAction) -> BaselineResult:
    """Require approval for direct mutations of active user startup files."""
    if action.tool_type != ToolType.FILESYSTEM or action.operation not in {RuntimeOperation.WRITE, RuntimeOperation.DELETE}:
        return BaselineResult.no_signal()
    if any(is_user_persistence_path(path) for path in _path_values(action)):
        return result_for(shell_ask_rules.PERSISTENCE_CHANGE, action)
    return BaselineResult.no_signal()


def detect_delete_mutation(action: RuntimeAction) -> BaselineResult:
    """Require approval for direct file or directory deletion."""
    if action.tool_type != ToolType.FILESYSTEM or action.operation != RuntimeOperation.DELETE:
        return BaselineResult.no_signal()
    if _is_lite_windows_sessions_delete(action) or _deletes_current_lite_windows_temporary_targets(action):
        return BaselineResult.no_signal()
    if paths_are_strictly_within_managed_session_workspace(action.resolved_paths, action.workspace_root):
        return BaselineResult.no_signal()
    return result_for(rules.DELETE_MUTATION, action)


def detect_workspace_external_mutation(action: RuntimeAction) -> BaselineResult:
    """Require approval for mutations outside a user-selected workspace."""
    if action.tool_type != ToolType.FILESYSTEM or action.operation not in {RuntimeOperation.WRITE, RuntimeOperation.DELETE}:
        return BaselineResult.no_signal()
    if (
        _is_lite_windows_sessions_delete(action)
        or _deletes_current_lite_windows_temporary_targets(action)
        or _writes_current_public_skill(action)
    ):
        return BaselineResult.no_signal()
    if is_managed_session_workspace(action.workspace_root):
        return BaselineResult.no_signal()
    if any(_is_system_mutation_target(path) or is_host_system_mutation_path(path) for path in action.resolved_paths):
        return BaselineResult.no_signal()
    if _creates_missing_lite_windows_temporary_file(action) or action.workspace_scope not in {
        WorkspaceScope.OUTSIDE,
        WorkspaceScope.MIXED,
    }:
        return BaselineResult.no_signal()
    return result_for(
        rules.WORKSPACE_EXTERNAL_MUTATION,
        action,
        reason=_workspace_external_reason(action.resolved_paths),
    )


def _creates_missing_lite_windows_temporary_file(action: RuntimeAction) -> bool:
    """Allow a direct Write to a new literal file below a host temporary root."""
    raw_target = action.target_value.strip().strip("\"'`").replace("\\", "/")
    return (
        action.profile == BuildProfile.LITE
        and action.operating_system == OperatingSystem.WINDOWS
        and action.canonical_tool_name in {"FileWrite", "Write"}
        and len(action.resolved_paths) == 1
        and bool(raw_target)
        and not any(char in raw_target for char in "$%*?[]`")
        and ".." not in raw_target.split("/")
        and is_recognized_temporary_descendant(action.resolved_paths[0])
        and not path_exists(action.resolved_paths[0])
    )


def _deletes_current_lite_windows_temporary_targets(action: RuntimeAction) -> bool:
    return (
        action.operation == RuntimeOperation.DELETE
        and action.profile == BuildProfile.LITE
        and action.operating_system == OperatingSystem.WINDOWS
        and bool(action.resolved_paths)
        and all(is_current_windows_temporary_delete_target(path) for path in action.resolved_paths)
    )


def _writes_current_public_skill(action: RuntimeAction) -> bool:
    return (
        action.operation == RuntimeOperation.WRITE
        and bool(action.resolved_paths)
        and all(is_hexagent_public_skill_descendant(path) for path in action.resolved_paths)
    )


def _is_lite_windows_sessions_delete(action: RuntimeAction) -> bool:
    return (
        action.operation == RuntimeOperation.DELETE
        and action.profile == BuildProfile.LITE
        and action.operating_system == OperatingSystem.WINDOWS
        and paths_are_at_or_below_windows_user_sessions(action.resolved_paths)
    )


def _workspace_external_reason(paths: tuple[str, ...]) -> str:
    target = next(iter(paths), "")
    return f"修改工作区外文件 {target}" if target else rules.WORKSPACE_EXTERNAL_MUTATION.reason


def detect_system_path_mutation(action: RuntimeAction) -> BaselineResult:
    """Deny direct filesystem writes to critical system paths."""
    if action.tool_type != ToolType.FILESYSTEM or action.operation not in {RuntimeOperation.WRITE, RuntimeOperation.DELETE}:
        return BaselineResult.no_signal()

    for path in action.resolved_paths:
        if _is_system_mutation_target(path):
            return result_for(rules.SYSTEM_PATH_MUTATION, action, rule_content="system_path_mutation")

    return BaselineResult.no_signal()


def detect_host_system_path_mutation(action: RuntimeAction) -> BaselineResult:
    """Deny host system path mutations if VM/mount isolation missed them."""
    if action.tool_type != ToolType.FILESYSTEM or action.operation not in {RuntimeOperation.WRITE, RuntimeOperation.DELETE}:
        return BaselineResult.no_signal()

    if any(is_host_system_mutation_path(path) for path in _path_values(action)):
        return result_for(rules.HOST_SYSTEM_PATH_MUTATION, action, rule_content="host_system_path_mutation")

    return BaselineResult.no_signal()


def detect_host_credential_store_access(action: RuntimeAction) -> BaselineResult:
    """Deny filesystem access to OS-level credential stores."""
    if action.tool_type != ToolType.FILESYSTEM:
        return BaselineResult.no_signal()

    if any(is_host_credential_store_path(path) for path in _path_values(action)):
        return result_for(rules.HOST_CREDENTIAL_STORE_ACCESS, action, rule_content="host_credential_store_access")

    return BaselineResult.no_signal()


def detect_vm_host_mount_sensitive_access(action: RuntimeAction) -> BaselineResult:
    """Deny filesystem access to credentials exposed through known VM mounts."""
    if action.tool_type == ToolType.FILESYSTEM and is_vm_host_sensitive_path(action.target_value):
        return result_for(rules.VM_HOST_MOUNT_SENSITIVE_ACCESS, action, rule_content="host_mount_sensitive_access")
    return BaselineResult.no_signal()


def detect_vm_guest_security_control_tampering(action: RuntimeAction) -> BaselineResult:
    """Deny filesystem writes to managed VM guest controls."""
    if (
        action.tool_type == ToolType.FILESYSTEM
        and action.operation in {RuntimeOperation.WRITE, RuntimeOperation.DELETE}
        and is_vm_guest_security_control_path(action.target_value)
    ):
        return result_for(rules.VM_GUEST_SECURITY_CONTROL_TAMPERING, action, rule_content="guest_security_control_tampering")
    return BaselineResult.no_signal()


def detect_vm_control_socket_access(action: RuntimeAction) -> BaselineResult:
    """Deny direct filesystem access to VM and container control sockets."""
    if action.tool_type == ToolType.FILESYSTEM and is_vm_control_socket_path(action.target_value):
        return result_for(rules.VM_HOST_CONTROL_SOCKET_ACCESS, action, rule_content="host_control_socket_access")
    return BaselineResult.no_signal()


def _is_system_mutation_target(path: str) -> bool:
    normalized = path.replace("\\", "/").rstrip("/")
    return is_linux_critical_system_path(normalized) or any(
        normalized == prefix.rstrip("/") or normalized.startswith(prefix) for prefix in _RAW_DEVICE_MUTATION_PREFIXES
    )


def _path_values(action: RuntimeAction) -> tuple[str, ...]:
    return tuple(value for value in (*action.resolved_paths, action.target_value) if value)
