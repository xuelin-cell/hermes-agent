"""Shell detector facade with explicitly ordered domain registries."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ...action import ToolType
from ...baseline_rules import filesystem as filesystem_rules
from ...baseline_rules import result_for, select_active_rules
from ...baseline_rules.shell import COMMAND_RULES
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import commands as command_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ...baseline_rules.shell.terminal import TERMINAL_RULES as CONTEXT_TERMINAL_RULES
from . import (
    audit,
    command_policy,
    communication,
    control_plane,
    database,
    destruction,
    development_workflow,
    execution,
    host_boundary,
    network_abuse,
    persistence,
    script_inspection,
    vm_boundary,
    workspace,
)
from .delete_exempt import is_lite_windows_sessions_delete_exempt
from .profile import profile_shell_command
from .rule_filter import filter_rules_for_shell_commands
from ...normalizer import normalize_runtime_action
from ...signals import BaselineResult, BaselineVerdict

if TYPE_CHECKING:
    from collections.abc import Callable

    from ...action import RuntimeAction
    from ...baseline_rules.core import BaselineRuleDefinition
    from ...baseline_rules.selection import ActiveRuleSet
    from .profile import ShellCommandProfile


@dataclass(frozen=True)
class _TerminalDetectorSpec:
    detector: Callable[[RuntimeAction, ActiveRuleSet], BaselineResult]
    rule_ids: frozenset[str]


@dataclass(frozen=True)
class _AskDetectorSpec:
    detector: Callable[[RuntimeAction], BaselineResult]
    rule_ids: frozenset[str]


def _terminal_spec(
    detector: Callable[[RuntimeAction], BaselineResult],
    *rules: BaselineRuleDefinition,
) -> _TerminalDetectorSpec:
    def run(action: RuntimeAction, _active_rules: ActiveRuleSet) -> BaselineResult:
        return detector(action)

    return _TerminalDetectorSpec(
        detector=run,
        rule_ids=frozenset(rule.id for rule in rules),
    )


def _filtered_terminal_spec(
    detector: Callable[[RuntimeAction, ActiveRuleSet], BaselineResult],
    *rules: BaselineRuleDefinition,
) -> _TerminalDetectorSpec:
    return _TerminalDetectorSpec(
        detector=detector,
        rule_ids=frozenset(rule.id for rule in rules),
    )


def _ask_spec(
    detector: Callable[[RuntimeAction], BaselineResult],
    *rules: BaselineRuleDefinition,
) -> _AskDetectorSpec:
    return _AskDetectorSpec(detector=detector, rule_ids=frozenset(rule.id for rule in rules))


_CONTEXT_TERMINAL_DETECTORS: tuple[_TerminalDetectorSpec, ...] = (
    _terminal_spec(host_boundary.detect_windows_bcd_store_mutation, command_rules.WINDOWS_BCDEDIT),
    _terminal_spec(host_boundary.detect_host_credential_store_access, terminal_rules.HOST_CREDENTIAL_STORE_ACCESS),
    _terminal_spec(host_boundary.detect_pro_host_bridge_command, terminal_rules.HOST_BRIDGE_COMMAND),
    _terminal_spec(host_boundary.detect_linux_sensitive_path_read, terminal_rules.LINUX_SENSITIVE_PATH_READ),
    _terminal_spec(host_boundary.detect_shell_host_system_mutation, terminal_rules.HOST_SYSTEM_PATH_MUTATION),
    _terminal_spec(host_boundary.detect_linux_system_path_mutation, terminal_rules.LINUX_SYSTEM_PATH_MUTATION),
    _terminal_spec(audit.detect_audit_service_tampering, terminal_rules.AUDIT_SERVICE_TAMPERING),
    _terminal_spec(destruction.detect_destructive_encryption, terminal_rules.DESTRUCTIVE_ENCRYPTION),
    _terminal_spec(control_plane.detect_container_escape, terminal_rules.CONTAINER_ESCAPE),
    _terminal_spec(
        control_plane.detect_host_root_mount_destructive_container,
        terminal_rules.HOST_ROOT_MOUNT_DESTRUCTIVE_CONTAINER,
    ),
    _terminal_spec(control_plane.detect_k8s_mass_delete, terminal_rules.K8S_MASS_DELETE),
    _terminal_spec(network_abuse.detect_network_flood, terminal_rules.NETWORK_FLOOD),
    _terminal_spec(control_plane.detect_docker_destructive_terminal, terminal_rules.DOCKER_DESTRUCTIVE_TERMINAL),
    _terminal_spec(control_plane.detect_cloud_destructive_terminal, terminal_rules.CLOUD_DESTRUCTIVE_TERMINAL),
    _terminal_spec(network_abuse.detect_network_attack_terminal, terminal_rules.NETWORK_ATTACK_TERMINAL),
    _terminal_spec(persistence.detect_persisted_reverse_shell, terminal_rules.PERSISTED_REVERSE_SHELL),
    _terminal_spec(persistence.detect_persistence_terminal, terminal_rules.PERSISTENCE_TERMINAL),
    _terminal_spec(execution.detect_reverse_shell, terminal_rules.REVERSE_SHELL),
    _terminal_spec(execution.detect_remote_script_execution, terminal_rules.REMOTE_SCRIPT_EXECUTION),
    _terminal_spec(destruction.detect_system_stability_destroy, terminal_rules.SYSTEM_STABILITY_DESTROY),
    _terminal_spec(
        destruction.detect_windows_destructive_command,
        terminal_rules.WINDOWS_ROOT_RECURSIVE_DELETE,
        terminal_rules.HOST_SYSTEM_PATH_MUTATION,
        terminal_rules.WINDOWS_DESTRUCTIVE_COMMAND,
    ),
    _terminal_spec(destruction.detect_destructive_filesystem, terminal_rules.DESTRUCTIVE_FILESYSTEM),
    _terminal_spec(destruction.detect_system_file_truncate, terminal_rules.SYSTEM_FILE_TRUNCATE),
    _terminal_spec(execution.detect_obfuscated_terminal_command, terminal_rules.OBFUSCATED_TERMINAL_COMMAND),
    _terminal_spec(execution.detect_indirect_terminal_command, terminal_rules.INDIRECT_TERMINAL_COMMAND),
    _terminal_spec(destruction.detect_raw_device_redirect, terminal_rules.RAW_DEVICE_REDIRECT),
    _filtered_terminal_spec(
        destruction.detect_builtin_terminal_patterns,
        terminal_rules.RM_ROOT,
        terminal_rules.RM_SYSTEM_DIR,
        terminal_rules.RM_HOME,
        terminal_rules.RAW_DEVICE_WRITE,
        terminal_rules.FORK_BOMB,
        terminal_rules.KILL_ALL,
        terminal_rules.TELINIT_POWER,
        terminal_rules.WINDOWS_FORMAT_DRIVE,
        terminal_rules.WINDOWS_CIPHER_WIPE,
    ),
    _terminal_spec(vm_boundary.detect_host_mount_sensitive_access, terminal_rules.VM_HOST_MOUNT_SENSITIVE_ACCESS),
    _terminal_spec(vm_boundary.detect_host_mount_boundary_tampering, terminal_rules.VM_HOST_MOUNT_BOUNDARY_TAMPERING),
    _terminal_spec(vm_boundary.detect_host_mount_root_destruction, terminal_rules.VM_HOST_MOUNT_ROOT_DESTRUCTION),
    _terminal_spec(vm_boundary.detect_guest_security_control_tampering, terminal_rules.VM_GUEST_SECURITY_CONTROL_TAMPERING),
    _terminal_spec(vm_boundary.detect_host_control_socket_access, terminal_rules.VM_HOST_CONTROL_SOCKET_ACCESS),
    _terminal_spec(vm_boundary.detect_escape_primitive, terminal_rules.VM_ESCAPE_PRIMITIVE),
    _terminal_spec(vm_boundary.detect_resource_exhaustion, terminal_rules.VM_RESOURCE_EXHAUSTION),
)

_ASK_DETECTORS: tuple[_AskDetectorSpec, ...] = (
    _ask_spec(host_boundary.detect_hexagent_config_write, filesystem_rules.HEXAGENT_CONFIG_WRITE),
    _ask_spec(audit.detect_command_history_evasion, ask_rules.COMMAND_HISTORY_EVASION),
    _ask_spec(audit.detect_log_audit_destruction, ask_rules.LOG_AUDIT_DESTRUCTION),
    _ask_spec(audit.detect_lite_windows_event_log_clear, ask_rules.LITE_WINDOWS_EVENT_LOG_CLEAR),
    _ask_spec(persistence.detect_persistence_change, ask_rules.PERSISTENCE_CHANGE),
    _ask_spec(development_workflow.detect_git_destructive_operation, ask_rules.GIT_DESTRUCTIVE_OPERATION),
    _ask_spec(development_workflow.detect_external_repository_mutation, ask_rules.EXTERNAL_REPOSITORY_MUTATION),
    _ask_spec(communication.detect_external_communication, ask_rules.EXTERNAL_COMMUNICATION),
    _ask_spec(development_workflow.detect_supply_chain_execution, ask_rules.SUPPLY_CHAIN_EXECUTION),
    _ask_spec(database.detect_database_destructive_operation, ask_rules.DATABASE_DESTRUCTIVE_OPERATION),
    _ask_spec(control_plane.detect_cloud_destructive_operation, ask_rules.CLOUD_DESTRUCTIVE_OPERATION),
    _ask_spec(control_plane.detect_container_privileged_operation, ask_rules.CONTAINER_PRIVILEGED_OPERATION),
    _ask_spec(control_plane.detect_control_plane_destructive_operation, ask_rules.CONTROL_PLANE_DESTRUCTIVE_OPERATION),
    _ask_spec(control_plane.detect_external_control_plane_mutation, ask_rules.EXTERNAL_CONTROL_PLANE_MUTATION),
    _ask_spec(control_plane.detect_docker_destructive_operation, ask_rules.DOCKER_DESTRUCTIVE_OPERATION),
    _ask_spec(network_abuse.detect_network_attack_tool, ask_rules.NETWORK_ATTACK_TOOL),
    _ask_spec(execution.detect_resource_exhaustion, ask_rules.RESOURCE_EXHAUSTION),
    _ask_spec(destruction.detect_force_process_termination, ask_rules.FORCE_PROCESS_TERMINATION),
    _ask_spec(
        destruction.detect_delete_mutation,
        filesystem_rules.DELETE_MUTATION,
    ),
    _ask_spec(persistence.detect_dangerous_unix_permission_change, ask_rules.DANGEROUS_PERMISSION_CHANGE),
    _ask_spec(persistence.detect_lite_windows_permission_change, ask_rules.LITE_WINDOWS_PERMISSION_CHANGE),
    _ask_spec(persistence.detect_lite_windows_persistence, ask_rules.LITE_WINDOWS_PERSISTENCE),
    _ask_spec(host_boundary.detect_lite_windows_security_change, ask_rules.LITE_WINDOWS_SECURITY_CHANGE),
    _ask_spec(host_boundary.detect_lite_windows_registry_mutation, ask_rules.LITE_WINDOWS_REGISTRY_MUTATION),
    _ask_spec(execution.detect_lite_powershell_dynamic_execution, ask_rules.LITE_POWERSHELL_DYNAMIC_EXECUTION),
    _ask_spec(execution.detect_lite_windows_software_install, ask_rules.LITE_WINDOWS_SOFTWARE_INSTALL),
    _ask_spec(workspace.detect_workspace_external_mutation, filesystem_rules.WORKSPACE_EXTERNAL_MUTATION),
)

_MAX_SCRIPT_INSPECTION_DEPTH = 2
_SESSIONS_DELETE_EXEMPT_RULE_IDS = frozenset(
    {
        filesystem_rules.DELETE_MUTATION.id,
        filesystem_rules.WORKSPACE_EXTERNAL_MUTATION.id,
    }
)


def detect_terminal_deny(
    action: RuntimeAction,
    *,
    active_rules: ActiveRuleSet | None = None,
    _script_depth: int = 0,
) -> BaselineResult:
    """Run shell terminal-deny detectors in stable policy order."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()

    selected_rules = active_rules or select_active_rules(
        (*COMMAND_RULES, *CONTEXT_TERMINAL_RULES, filesystem_rules.PRODUCT_INSTALL_DIR_ACCESS),
        profile=action.profile,
        operating_system=action.operating_system,
        verdict=BaselineVerdict.TERMINAL_DENY,
    )
    script_rules = selected_rules
    if selected_rules.contains(filesystem_rules.PRODUCT_INSTALL_DIR_ACCESS):
        install_result = host_boundary.detect_product_install_dir_access(action)
        if install_result.verdict == BaselineVerdict.TERMINAL_DENY:
            return install_result
    selected_rules = selected_rules.intersect((*COMMAND_RULES, *CONTEXT_TERMINAL_RULES))
    command_profile = profile_shell_command(action.normalized_payload)
    selected_rules = filter_rules_for_shell_commands(selected_rules, command_profile)

    command_result = command_policy.detect_command_policy_terminal_deny(
        action,
        active_rules=selected_rules,
        command_profile=command_profile,
    )
    if command_result.verdict == BaselineVerdict.TERMINAL_DENY:
        return command_result

    for spec in _CONTEXT_TERMINAL_DETECTORS:
        if selected_rules.isdisjoint(spec.rule_ids):
            continue
        result = spec.detector(action, selected_rules)
        if result.verdict == BaselineVerdict.TERMINAL_DENY and selected_rules.contains(result.rule_id):
            return result

    if _script_depth < _MAX_SCRIPT_INSPECTION_DEPTH:
        script_result = _detect_referenced_script_terminal_deny(action, script_rules, command_profile, _script_depth)
        if script_result.verdict == BaselineVerdict.TERMINAL_DENY:
            return script_result

    return BaselineResult.no_signal()


def _detect_referenced_script_terminal_deny(
    action: RuntimeAction,
    active_rules: ActiveRuleSet,
    command_profile: ShellCommandProfile,
    script_depth: int,
) -> BaselineResult:
    for script in script_inspection.load_referenced_scripts(action, command_profile=command_profile):
        suffix = script.path.suffix.casefold()
        if suffix == ".py":
            if active_rules.contains(command_rules.WINDOWS_BCDEDIT) and script_inspection.python_script_mutates_bcd_store(script.content):
                return result_for(
                    command_rules.WINDOWS_BCDEDIT,
                    action,
                    rule_content="referenced_python_bcd_store_mutation",
                )
            if active_rules.contains(terminal_rules.NETWORK_FLOOD) and script_inspection.python_script_performs_network_flood(script.content):
                return result_for(
                    terminal_rules.NETWORK_FLOOD,
                    action,
                    rule_content="referenced_python_network_flood",
                )
            if active_rules.contains(terminal_rules.HOST_SYSTEM_PATH_MUTATION) and script_inspection.python_script_mutates_host_system_path(
                script.content
            ):
                return result_for(
                    terminal_rules.HOST_SYSTEM_PATH_MUTATION,
                    action,
                    rule_content="referenced_python_host_system_path_mutation",
                )
            continue

        tool_name = "PowerShell" if suffix in {".ps1", ".psm1"} else "Bash"
        child_action = normalize_runtime_action(
            tool_call_id=action.tool_call_id,
            tool_name=tool_name,
            tool_input={"command": script.content},
            cwd=str(script.path.parent),
            origin=action.origin,
            profile=action.profile,
            mode=action.mode,
            operating_system=action.operating_system,
            app_dir=action.app_dir,
            app_dir_exclusions=action.app_dir_exclusions,
        workspace_root=action.workspace_root,
        )
        if suffix in {".ps1", ".psm1"} and active_rules.contains(command_rules.WINDOWS_BCDEDIT):
            bcd_result = host_boundary.detect_windows_bcd_store_mutation(child_action)
            if bcd_result.verdict == BaselineVerdict.TERMINAL_DENY:
                return bcd_result
        result = detect_terminal_deny(
            child_action,
            active_rules=active_rules,
            _script_depth=script_depth + 1,
        )
        if result.verdict == BaselineVerdict.TERMINAL_DENY:
            return result
    return BaselineResult.no_signal()


def detect_ask(action: RuntimeAction, *, active_rules: ActiveRuleSet) -> BaselineResult:
    """Run active approval detectors in stable policy order."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()

    sessions_delete_exempt = is_lite_windows_sessions_delete_exempt(action)
    for spec in _ASK_DETECTORS:
        if active_rules.isdisjoint(spec.rule_ids):
            continue
        result = spec.detector(action)
        if (
            result.verdict == BaselineVerdict.ASK_REQUIRED
            and active_rules.contains(result.rule_id)
            and not (sessions_delete_exempt and result.rule_id in _SESSIONS_DELETE_EXEMPT_RULE_IDS)
        ):
            return result

    return BaselineResult.no_signal()
