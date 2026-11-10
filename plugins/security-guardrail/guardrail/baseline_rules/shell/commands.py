"""Command-level and simple argument-level terminal-deny rules."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from typing import TYPE_CHECKING

from ..core import terminal_rule
from ...signals import RiskCategory as C
from ...types import OperatingSystem

if TYPE_CHECKING:
    from ..core import BaselineRuleDefinition


class CommandMatchKind(str, Enum):
    """Supported deterministic command matching modes."""

    COMMAND = "command"
    ARGUMENTS = "arguments"


@dataclass(frozen=True)
class ArgumentCondition:
    """Small token-level condition for one command invocation."""

    subcommands_any: tuple[str, ...] = ()
    require_all: tuple[str, ...] = ()
    require_any: tuple[str, ...] = ()
    exclude_any: tuple[str, ...] = ()
    requires_operand: bool = False


@dataclass(frozen=True)
class CommandRule:
    """One baseline rule attached to a canonical command."""

    rule: BaselineRuleDefinition
    match_kind: CommandMatchKind = CommandMatchKind.COMMAND
    condition: ArgumentCondition | None = None
    include_command_name_in_reason: bool = True

    def __post_init__(self) -> None:
        """Require a condition for argument-level rules."""
        if self.match_kind == CommandMatchKind.ARGUMENTS and self.condition is None:
            message = f"argument rule {self.rule.id!r} requires a condition"
            raise ValueError(message)


@dataclass(frozen=True)
class CommandPolicy:
    """Rules attached to one canonical command."""

    canonical_name: str
    rules: tuple[CommandRule, ...]


def _terminal(
    operating_system: OperatingSystem,
    command: str,
    category: C,
    reason: str,
    *,
    operating_systems: frozenset[OperatingSystem] | None = None,
) -> CommandPolicy:
    rule_name = command.replace("-", "_").replace(".", "_")
    rule = terminal_rule(
        f"common.{operating_system.value}.{rule_name}",
        category,
        reason,
        operating_systems=operating_systems or frozenset({operating_system}),
    )
    return CommandPolicy(command, (CommandRule(rule),))


def _argument_rule(
    operating_system: OperatingSystem,
    command: str,
    rule_id: str,
    category: C,
    reason: str,
    condition: ArgumentCondition,
    *,
    operating_systems: frozenset[OperatingSystem] | None = None,
) -> CommandPolicy:
    rule = terminal_rule(
        rule_id,
        category,
        reason,
        operating_systems=operating_systems or frozenset({operating_system}),
    )
    command_rule = CommandRule(
        rule,
        CommandMatchKind.ARGUMENTS,
        condition,
        include_command_name_in_reason=False,
    )
    return CommandPolicy(command, (command_rule,))


WINDOWS_BCDEDIT = terminal_rule(
    "common.windows.bcdedit",
    C.COMMAND_EXECUTION,
    "Windows 启动配置修改已被阻止",
    operating_systems=frozenset({OperatingSystem.WINDOWS}),
)
_WINDOWS_BCDEDIT_MUTATION_ARGUMENTS = (
    "/bootdebug",
    "/bootsequence",
    "/copy",
    "/create",
    "/createstore",
    "/dbgsettings",
    "/debug",
    "/default",
    "/delete",
    "/deletevalue",
    "/displayorder",
    "/ems",
    "/emssettings",
    "/hypervisorsettings",
    "/import",
    "/set",
    "/sysstore",
    "/timeout",
    "/toolsdisplayorder",
)


WINDOWS_POLICIES: tuple[CommandPolicy, ...] = (
    CommandPolicy(
        "bcdedit",
        (
            CommandRule(
                WINDOWS_BCDEDIT,
                CommandMatchKind.ARGUMENTS,
                ArgumentCondition(require_any=_WINDOWS_BCDEDIT_MUTATION_ARGUMENTS),
                include_command_name_in_reason=False,
            ),
        ),
    ),
    _terminal(OperatingSystem.WINDOWS, "clear-disk", C.FILESYSTEM_MODIFICATION, "磁盘清除命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "clear-tpm", C.SELF_PROTECTION, "TPM 密钥清除命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "diskpart", C.FILESYSTEM_MODIFICATION, "磁盘分区操作已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "format-volume", C.FILESYSTEM_MODIFICATION, "卷格式化命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "remove-partition", C.FILESYSTEM_MODIFICATION, "分区删除命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "remove-virtualdisk", C.FILESYSTEM_MODIFICATION, "虚拟磁盘删除命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "restart-computer", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "shutdown", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
    _terminal(OperatingSystem.WINDOWS, "stop-computer", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
)

_LINUX_FORMAT_COMMANDS = (
    "mkfs",
    "mkfs.bfs",
    "mkfs.btrfs",
    "mkfs.cramfs",
    "mkfs.ext2",
    "mkfs.ext3",
    "mkfs.ext4",
    "mkfs.fat",
    "mkfs.minix",
    "mkfs.msdos",
    "mkfs.udf",
    "mkfs.vfat",
    "mkfs.xfs",
)

LINUX_POLICIES: tuple[CommandPolicy, ...] = (
    _terminal(OperatingSystem.LINUX, "blkdiscard", C.FILESYSTEM_MODIFICATION, "块设备数据丢弃命令已被阻止"),
    _argument_rule(
        OperatingSystem.LINUX,
        "cryptsetup",
        "common.linux.cryptsetup_key_erase",
        C.COMMAND_EXECUTION,
        "磁盘加密密钥清除命令已被阻止",
        ArgumentCondition(subcommands_any=("erase", "luksErase"), requires_operand=True),
    ),
    _terminal(OperatingSystem.LINUX, "halt", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
    _argument_rule(
        OperatingSystem.LINUX,
        "init",
        "common.linux.init_power",
        C.COMMAND_EXECUTION,
        "通过 init 关机或重启已被阻止",
        ArgumentCondition(subcommands_any=("0", "6")),
    ),
    _terminal(OperatingSystem.LINUX, "lvremove", C.FILESYSTEM_MODIFICATION, "逻辑卷删除命令已被阻止"),
    *(_terminal(OperatingSystem.LINUX, command, C.FILESYSTEM_MODIFICATION, "文件系统格式化命令已被阻止") for command in _LINUX_FORMAT_COMMANDS),
    _terminal(OperatingSystem.LINUX, "mkswap", C.FILESYSTEM_MODIFICATION, "交换分区格式化命令已被阻止"),
    _terminal(OperatingSystem.LINUX, "poweroff", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
    _terminal(OperatingSystem.LINUX, "pvremove", C.FILESYSTEM_MODIFICATION, "物理卷元数据删除命令已被阻止"),
    _terminal(OperatingSystem.LINUX, "reboot", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
    _terminal(OperatingSystem.LINUX, "shutdown", C.COMMAND_EXECUTION, "主机电源控制命令已被阻止"),
    _argument_rule(
        OperatingSystem.LINUX,
        "systemctl",
        "common.linux.systemctl_power",
        C.COMMAND_EXECUTION,
        "通过 systemctl 关机或重启已被阻止",
        ArgumentCondition(subcommands_any=("poweroff", "reboot", "halt", "kexec")),
    ),
    _terminal(OperatingSystem.LINUX, "vgremove", C.FILESYSTEM_MODIFICATION, "卷组删除命令已被阻止"),
    _terminal(OperatingSystem.LINUX, "wipefs", C.FILESYSTEM_MODIFICATION, "文件系统签名擦除命令已被阻止"),
)

_MACOS_NEWFS_COMMANDS = ("newfs_apfs", "newfs_exfat", "newfs_fskit", "newfs_hfs", "newfs_msdos", "newfs_udf")
_MACOS_COMMAND_OPERATING_SYSTEMS = frozenset({OperatingSystem.LINUX, OperatingSystem.MACOS})

MACOS_POLICIES: tuple[CommandPolicy, ...] = (
    _argument_rule(
        OperatingSystem.MACOS,
        "diskutil",
        "common.macos.diskutil_erase_disk",
        C.FILESYSTEM_MODIFICATION,
        "磁盘擦除已被阻止",
        ArgumentCondition(subcommands_any=("eraseDisk",), requires_operand=True),
        operating_systems=_MACOS_COMMAND_OPERATING_SYSTEMS,
    ),
    _terminal(
        OperatingSystem.MACOS,
        "halt",
        C.COMMAND_EXECUTION,
        "主机电源控制命令已被阻止",
        operating_systems=_MACOS_COMMAND_OPERATING_SYSTEMS,
    ),
    *(
        _terminal(
            OperatingSystem.MACOS,
            command,
            C.FILESYSTEM_MODIFICATION,
            "文件系统创建命令已被阻止",
            operating_systems=_MACOS_COMMAND_OPERATING_SYSTEMS,
        )
        for command in _MACOS_NEWFS_COMMANDS
    ),
    _terminal(
        OperatingSystem.MACOS,
        "reboot",
        C.COMMAND_EXECUTION,
        "主机电源控制命令已被阻止",
        operating_systems=_MACOS_COMMAND_OPERATING_SYSTEMS,
    ),
    _terminal(
        OperatingSystem.MACOS,
        "shutdown",
        C.COMMAND_EXECUTION,
        "主机电源控制命令已被阻止",
        operating_systems=_MACOS_COMMAND_OPERATING_SYSTEMS,
    ),
)

THIRD_PARTY_POLICIES: tuple[CommandPolicy, ...] = ()
COMMAND_POLICIES = (*WINDOWS_POLICIES, *LINUX_POLICIES, *MACOS_POLICIES, *THIRD_PARTY_POLICIES)
COMMAND_RULES = tuple(command_rule.rule for policy in COMMAND_POLICIES for command_rule in policy.rules)


def lookup_command_policies(canonical_name: str) -> tuple[CommandPolicy, ...]:
    """Return command policies matching a canonical executable name."""
    return _policy_index().get(_canonical_key(canonical_name), ())


@lru_cache(maxsize=1)
def _policy_index() -> dict[str, tuple[CommandPolicy, ...]]:
    index: dict[str, list[CommandPolicy]] = defaultdict(list)
    for policy in COMMAND_POLICIES:
        index[_canonical_key(policy.canonical_name)].append(policy)
    return {key: tuple(value) for key, value in index.items()}


def _canonical_key(command: str) -> str:
    return command.strip().casefold()
