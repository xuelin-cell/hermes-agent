"""High-confidence shell operations that require user approval."""

from ..core import BaselineRuleDefinition, BaselineRuleSet, ask_rule
from ...signals import RiskCategory as C
from ...types import ALL_OPERATING_SYSTEMS, OperatingSystem

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
    return ask_rule(
        rule_id,
        category,
        reason,
        rule_set=rule_set,
        operating_systems=operating_systems,
    )


COMMAND_HISTORY_EVASION = _rule(
    "common.shell.command_history_evasion",
    C.SELF_PROTECTION,
    "清除或关闭命令历史记录",
)
LOG_AUDIT_DESTRUCTION = _rule(
    "common.shell.log_audit_destruction",
    C.SELF_PROTECTION,
    "删除或截断系统日志与审计记录",
    operating_systems=_UNIX,
)
GIT_DESTRUCTIVE_OPERATION = _rule(
    "common.shell.git_destructive_operation",
    C.FILESYSTEM_MODIFICATION,
    "可能丢失本地修改或重写远端历史的 Git 操作",
)
EXTERNAL_REPOSITORY_MUTATION = _rule(
    "common.shell.external_repository_mutation",
    C.NETWORK_EGRESS,
    "向共享代码仓库推送、发布或修改远端状态",
)
EXTERNAL_COMMUNICATION = _rule(
    "common.shell.external_communication",
    C.NETWORK_EGRESS,
    "向外部消息、邮件或 Webhook 目标发送内容",
)
SUPPLY_CHAIN_EXECUTION = _rule(
    "common.shell.supply_chain_execution",
    C.COMMAND_EXECUTION,
    "将从直接 URL 或 Git 仓库安装或运行代码",
)
SUPPLY_CHAIN_SHELL_CALL_REASON = "将通过包管理器执行 Shell 命令字符串; 当前无法完整检查其内部操作"
RESOURCE_EXHAUSTION = _rule("common.shell.resource_exhaustion", C.COMMAND_EXECUTION, "可能大量消耗计算或网络资源的操作")
FORCE_PROCESS_TERMINATION = _rule(
    "common.shell.force_process_termination",
    C.COMMAND_EXECUTION,
    "强制终止一个或多个进程可能导致未保存数据丢失",
)
PERSISTENCE_CHANGE = _rule(
    "common.shell.persistence_change",
    C.PERSISTENCE,
    "安装启动项或其他持久化配置",
)
DOCKER_DESTRUCTIVE_OPERATION = _rule(
    "common.shell.docker_destructive_operation",
    C.FILESYSTEM_MODIFICATION,
    "删除容器卷数据",
)
CLOUD_DESTRUCTIVE_OPERATION = _rule(
    "common.shell.cloud_destructive_operation",
    C.COMMAND_EXECUTION,
    "删除云资源或云端数据",
)
NETWORK_ATTACK_TOOL = _rule("common.shell.network_attack_tool", C.NETWORK_EGRESS, "运行网络扫描、爆破或攻击工具")
CONTROL_PLANE_DESTRUCTIVE_OPERATION = _rule(
    "common.shell.control_plane_destructive_operation",
    C.FILESYSTEM_MODIFICATION,
    "执行容器/集群或基础设施控制面的破坏性操作",
)
EXTERNAL_CONTROL_PLANE_MUTATION = _rule(
    "common.shell.external_control_plane_mutation",
    C.COMMAND_EXECUTION,
    "修改外部服务、集群或基础设施状态",
)
CONTAINER_PRIVILEGED_OPERATION = _rule(
    "common.shell.container_privileged_operation",
    C.PRIVILEGE_CHANGE,
    "启动特权容器或挂载宿主根目录",
)
DATABASE_DESTRUCTIVE_OPERATION = _rule(
    "common.shell.database_destructive_operation",
    C.FILESYSTEM_MODIFICATION,
    "执行删除数据库、结构或数据表的语句",
)
DANGEROUS_PERMISSION_CHANGE = _rule(
    "common.shell.dangerous_permission_change",
    C.PRIVILEGE_CHANGE,
    "递归设置危险权限或所有者",
)

LITE_WINDOWS_PERMISSION_CHANGE = _rule(
    "lite.shell.windows_permission_change",
    C.PRIVILEGE_CHANGE,
    "修改 Windows 权限或所有者",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)
LITE_WINDOWS_PERSISTENCE = _rule(
    "lite.shell.windows_persistence",
    C.PERSISTENCE,
    "修改 Windows 启动项或服务",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)
LITE_WINDOWS_SECURITY_CHANGE = _rule(
    "lite.shell.windows_security_change",
    C.PRIVILEGE_CHANGE,
    "修改 Windows 账户或安全配置",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)
LITE_POWERSHELL_DYNAMIC_EXECUTION = _rule(
    "lite.shell.powershell_dynamic_execution",
    C.COMMAND_EXECUTION,
    "动态执行 PowerShell 代码",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)
LITE_WINDOWS_EVENT_LOG_CLEAR = _rule(
    "lite.shell.windows_event_log_clear",
    C.SELF_PROTECTION,
    "清除或关闭 Windows 事件日志",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)
LITE_WINDOWS_REGISTRY_MUTATION = _rule(
    "lite.shell.windows_registry_mutation",
    C.PRIVILEGE_CHANGE,
    "修改 Windows 系统级注册表会影响宿主机全局配置",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)
LITE_WINDOWS_SOFTWARE_INSTALL = _rule(
    "lite.shell.windows_software_install",
    C.COMMAND_EXECUTION,
    "在 Windows 宿主机执行高风险软件安装或系统组件变更",
    rule_set=BaselineRuleSet.LITE_EXTRA,
    operating_systems=_WINDOWS,
)

ASK_RULES = tuple(value for name, value in tuple(globals().items()) if name.isupper() and hasattr(value, "verdict"))
