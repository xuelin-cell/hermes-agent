"""Context-aware terminal-deny shell rule definitions."""

from ..core import BaselineRuleDefinition, BaselineRuleSet, terminal_rule
from ...signals import RiskCategory as C
from ...types import ALL_OPERATING_SYSTEMS, OperatingSystem

_LINUX = frozenset({OperatingSystem.LINUX})
_WINDOWS = frozenset({OperatingSystem.WINDOWS})
_UNIX = frozenset({OperatingSystem.LINUX, OperatingSystem.MACOS})


def _rule(
    rule_id: str,
    category: C,
    reason: str,
    *,
    rule_set: BaselineRuleSet = BaselineRuleSet.COMMON,
    operating_systems: frozenset[OperatingSystem] = ALL_OPERATING_SYSTEMS,
) -> BaselineRuleDefinition:
    return terminal_rule(
        rule_id,
        category,
        reason,
        rule_set=rule_set,
        operating_systems=operating_systems,
    )


AUDIT_SERVICE_TAMPERING = _rule(
    "common.shell.audit_service_tampering",
    C.SELF_PROTECTION,
    "审计服务篡改已被阻止",
    operating_systems=_LINUX,
)
DESTRUCTIVE_ENCRYPTION = _rule(
    "common.shell.destructive_encryption",
    C.FILESYSTEM_MODIFICATION,
    "破坏性加密模式已被阻止",
    operating_systems=_UNIX,
)
CONTAINER_ESCAPE = _rule("common.shell.container_escape", C.PRIVILEGE_CHANGE, "容器逃逸原语已被阻止")
HOST_ROOT_MOUNT_DESTRUCTIVE_CONTAINER = _rule(
    "common.shell.host_root_mount_destructive_container",
    C.FILESYSTEM_MODIFICATION,
    "通过挂载宿主机根目录执行破坏性容器命令已被阻止",
)
K8S_MASS_DELETE = _rule("common.shell.k8s_mass_delete", C.FILESYSTEM_MODIFICATION, "大范围 Kubernetes 删除操作已被阻止")
NETWORK_FLOOD = _rule("common.shell.network_flood", C.NETWORK_EGRESS, "网络洪泛命令已被阻止")
DOCKER_DESTRUCTIVE_TERMINAL = _rule("common.shell.docker_destructive_terminal", C.FILESYSTEM_MODIFICATION, "大范围 Docker 数据删除已被阻止")
CLOUD_DESTRUCTIVE_TERMINAL = _rule("common.shell.cloud_destructive_terminal", C.COMMAND_EXECUTION, "云控制面高危删除操作已被阻止")
NETWORK_ATTACK_TERMINAL = _rule("common.shell.network_attack_terminal", C.NETWORK_EGRESS, "高风险网络攻击命令已被阻止")
PERSISTED_REVERSE_SHELL = _rule(
    "common.shell.persisted_reverse_shell",
    C.PERSISTENCE,
    "启动文件中的反向 Shell 持久化已被阻止",
    operating_systems=_UNIX,
)
PERSISTENCE_TERMINAL = _rule(
    "common.shell.persistence_terminal",
    C.PERSISTENCE,
    "显式后门持久化安装已被阻止",
    operating_systems=_UNIX,
)
REVERSE_SHELL = _rule(
    "common.shell.reverse_shell",
    C.COMMAND_EXECUTION,
    "反向 Shell 执行已被阻止",
)
REMOTE_SCRIPT_EXECUTION = _rule(
    "common.shell.remote_script_execution",
    C.COMMAND_EXECUTION,
    "远程脚本下载并执行已被阻止",
)
SYSTEM_STABILITY_DESTROY = _rule(
    "common.shell.system_stability_destroy",
    C.COMMAND_EXECUTION,
    "破坏系统稳定性的命令已被阻止",
    operating_systems=_UNIX,
)
WINDOWS_DESTRUCTIVE_COMMAND = _rule(
    "common.shell.windows_destructive_command",
    C.FILESYSTEM_MODIFICATION,
    "Windows 破坏性命令已被阻止",
    operating_systems=_WINDOWS,
)
WINDOWS_ROOT_RECURSIVE_DELETE = _rule(
    "common.shell.windows_root_recursive_delete",
    C.FILESYSTEM_MODIFICATION,
    "Windows 盘符根目录递归删除已被阻止",
    operating_systems=_WINDOWS,
)
HOST_SYSTEM_PATH_MUTATION = _rule(
    "common.shell.host_system_path_mutation",
    C.FILESYSTEM_MODIFICATION,
    "宿主机系统路径修改已被阻止",
)
DESTRUCTIVE_FILESYSTEM = _rule(
    "common.shell.destructive_filesystem",
    C.FILESYSTEM_MODIFICATION,
    "大范围文件系统破坏操作已被阻止",
    operating_systems=_UNIX,
)
SYSTEM_FILE_TRUNCATE = _rule(
    "common.shell.system_file_truncate",
    C.FILESYSTEM_MODIFICATION,
    "系统文件截断操作已被阻止",
    operating_systems=_UNIX,
)
OBFUSCATED_TERMINAL_COMMAND = _rule(
    "common.shell.obfuscated_terminal_command",
    C.COMMAND_EXECUTION,
    "混淆的终止拒绝命令已被阻止",
    operating_systems=_UNIX,
)
INDIRECT_TERMINAL_COMMAND = _rule(
    "common.shell.indirect_terminal_command",
    C.COMMAND_EXECUTION,
    "间接执行终止拒绝命令已被阻止",
    operating_systems=_UNIX,
)
RAW_DEVICE_REDIRECT = _rule(
    "common.shell.raw_device_redirect",
    C.FILESYSTEM_MODIFICATION,
    "原始块设备重定向已被阻止",
    operating_systems=_LINUX,
)
HOST_CREDENTIAL_STORE_ACCESS = _rule("common.shell.host_credential_store_access", C.CREDENTIAL_EXPOSURE, "宿主机凭据存储访问已被阻止")
HOST_BRIDGE_COMMAND = _rule(
    "pro.shell.host_bridge_command",
    C.COMMAND_EXECUTION,
    "沙箱环境调用宿主机命令桥已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
)
VM_HOST_MOUNT_BOUNDARY_TAMPERING = _rule(
    "pro.vm.host_mount_boundary_tampering",
    C.FILESYSTEM_MODIFICATION,
    "虚拟机宿主挂载边界修改已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
VM_HOST_MOUNT_ROOT_DESTRUCTION = _rule(
    "pro.vm.host_mount_root_destruction",
    C.FILESYSTEM_MODIFICATION,
    "虚拟机宿主挂载根破坏操作已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
VM_HOST_MOUNT_SENSITIVE_ACCESS = _rule(
    "pro.vm.host_mount_sensitive_access",
    C.CREDENTIAL_EXPOSURE,
    "虚拟机宿主挂载中的敏感凭据访问已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
VM_GUEST_SECURITY_CONTROL_TAMPERING = _rule(
    "pro.vm.guest_security_control_tampering",
    C.SELF_PROTECTION,
    "虚拟机安全控制面修改已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
VM_ESCAPE_PRIMITIVE = _rule(
    "pro.vm.escape_primitive",
    C.PRIVILEGE_CHANGE,
    "虚拟机边界越权操作已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
VM_HOST_CONTROL_SOCKET_ACCESS = _rule(
    "pro.vm.host_control_socket_access",
    C.PRIVILEGE_CHANGE,
    "虚拟机控制套接字访问已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
VM_RESOURCE_EXHAUSTION = _rule(
    "pro.vm.resource_exhaustion",
    C.COMMAND_EXECUTION,
    "虚拟机资源耗尽操作已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=_LINUX,
)
LINUX_SENSITIVE_PATH_READ = _rule(
    "common.shell.linux_sensitive_path_read",
    C.CREDENTIAL_EXPOSURE,
    "Linux 凭据或权限文件读取已被阻止",
    operating_systems=_LINUX,
)
LINUX_SYSTEM_PATH_MUTATION = _rule(
    "common.shell.linux_system_path_mutation",
    C.FILESYSTEM_MODIFICATION,
    "关键 Linux 系统路径修改已被阻止",
    operating_systems=_LINUX,
)
RM_ROOT = _rule("common.shell.rm_root", C.FILESYSTEM_MODIFICATION, "递归删除文件系统根目录已被阻止", operating_systems=_UNIX)
RM_SYSTEM_DIR = _rule("common.shell.rm_system_dir", C.FILESYSTEM_MODIFICATION, "递归删除关键系统目录已被阻止", operating_systems=_UNIX)
RM_HOME = _rule("common.shell.rm_home", C.FILESYSTEM_MODIFICATION, "递归删除用户主目录已被阻止", operating_systems=_UNIX)
RAW_DEVICE_WRITE = _rule("common.shell.raw_device_write", C.FILESYSTEM_MODIFICATION, "原始块设备写入已被阻止", operating_systems=_LINUX)
FORK_BOMB = _rule("common.shell.fork_bomb", C.COMMAND_EXECUTION, "Fork Bomb 已被阻止", operating_systems=_UNIX)
KILL_ALL = _rule("common.shell.kill_all", C.COMMAND_EXECUTION, "终止所有进程已被阻止", operating_systems=_UNIX)
TELINIT_POWER = _rule("common.shell.telinit_power", C.COMMAND_EXECUTION, "通过 telinit 关机或重启已被阻止", operating_systems=_LINUX)
WINDOWS_FORMAT_DRIVE = _rule(
    "common.windows.format_drive",
    C.FILESYSTEM_MODIFICATION,
    "Windows 驱动器格式化已被阻止",
    operating_systems=_WINDOWS,
)
WINDOWS_CIPHER_WIPE = _rule(
    "common.windows.cipher_wipe",
    C.FILESYSTEM_MODIFICATION,
    "Windows 安全磁盘擦除已被阻止",
    operating_systems=_WINDOWS,
)

TERMINAL_RULES = tuple(value for name, value in tuple(globals().items()) if name.isupper() and hasattr(value, "verdict"))
