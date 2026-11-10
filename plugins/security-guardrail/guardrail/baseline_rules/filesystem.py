"""Filesystem baseline rule definitions."""

from .core import BaselineRuleSet, ask_rule, terminal_rule
from ..signals import RiskCategory as C
from ..types import OperatingSystem

_UNIX = frozenset({OperatingSystem.LINUX, OperatingSystem.MACOS})
_LINUX = frozenset({OperatingSystem.LINUX})

PRODUCT_INSTALL_DIR_ACCESS = terminal_rule(
    "common.filesystem.product_install_dir_access",
    C.SELF_PROTECTION,
    "禁止访问 UniClaw 产品安装目录",
)
LINUX_SENSITIVE_PATH_READ = terminal_rule(
    "common.filesystem.linux_sensitive_path_read",
    C.CREDENTIAL_EXPOSURE,
    "Linux 凭据或权限文件读取已被阻止",
    operating_systems=_LINUX,
)
SYSTEM_PATH_MUTATION = terminal_rule(
    "common.filesystem.system_path_mutation",
    C.FILESYSTEM_MODIFICATION,
    "系统路径修改已被阻止",
    operating_systems=_UNIX,
)
HOST_SYSTEM_PATH_MUTATION = terminal_rule("common.filesystem.host_system_path_mutation", C.FILESYSTEM_MODIFICATION, "宿主机系统路径修改已被阻止")
HOST_CREDENTIAL_STORE_ACCESS = terminal_rule("common.filesystem.host_credential_store_access", C.CREDENTIAL_EXPOSURE, "宿主机凭据存储访问已被阻止")
VM_HOST_MOUNT_SENSITIVE_ACCESS = terminal_rule(
    "pro.filesystem.vm_host_mount_sensitive_access",
    C.CREDENTIAL_EXPOSURE,
    "虚拟机宿主挂载中的敏感凭据访问已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=frozenset({OperatingSystem.LINUX}),
)
VM_GUEST_SECURITY_CONTROL_TAMPERING = terminal_rule(
    "pro.filesystem.vm_guest_security_control_tampering",
    C.SELF_PROTECTION,
    "虚拟机安全控制面修改已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=frozenset({OperatingSystem.LINUX}),
)
VM_HOST_CONTROL_SOCKET_ACCESS = terminal_rule(
    "pro.filesystem.vm_host_control_socket_access",
    C.PRIVILEGE_CHANGE,
    "虚拟机控制套接字访问已被阻止",
    rule_set=BaselineRuleSet.PRO_EXTRA,
    operating_systems=frozenset({OperatingSystem.LINUX}),
)

HEXAGENT_CONFIG_WRITE = ask_rule(
    "common.filesystem.hexagent_config_write",
    C.SELF_PROTECTION,
    "修改产品关键配置",
)
DELETE_MUTATION = ask_rule(
    "common.filesystem.delete_mutation",
    C.FILESYSTEM_MODIFICATION,
    "删除文件或目录",
)
WORKSPACE_EXTERNAL_MUTATION = ask_rule(
    "common.filesystem.workspace_external_mutation",
    C.FILESYSTEM_MODIFICATION,
    "修改工作区外文件",
)

TERMINAL_RULES = (
    PRODUCT_INSTALL_DIR_ACCESS,
    LINUX_SENSITIVE_PATH_READ,
    SYSTEM_PATH_MUTATION,
    HOST_SYSTEM_PATH_MUTATION,
    HOST_CREDENTIAL_STORE_ACCESS,
    VM_HOST_MOUNT_SENSITIVE_ACCESS,
    VM_GUEST_SECURITY_CONTROL_TAMPERING,
    VM_HOST_CONTROL_SOCKET_ACCESS,
)
ASK_RULES = (HEXAGENT_CONFIG_WRITE, DELETE_MUTATION, WORKSPACE_EXTERNAL_MUTATION)
RULES = (*TERMINAL_RULES, *ASK_RULES)
