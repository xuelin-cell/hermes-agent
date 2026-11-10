"""Filesystem, system stability, and encryption shell detectors."""

from __future__ import annotations

from ...runtime import path_exists, path_is_directory

import ast
import re
import shlex
from typing import TYPE_CHECKING

from ...action import ToolType, WorkspaceScope
from ...baseline_rules import filesystem as filesystem_rules
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _BLOCK_DEVICE, _CMDPOS
from .profile import is_help_or_version_only_invocation, profile_shell_command
from .workspace import (
    mutation_paths,
    mutation_target_values,
    mutation_workspace_scope,
    resolve_shell_path,
)
from ...path_policy import (
    current_windows_mcp_service_root,
    is_current_windows_temporary_delete_target,
    is_host_system_mutation_path,
    normalize_path_for_policy,
    paths_are_strictly_within_managed_session_workspace,
)
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult
from ...types import BuildProfile, OperatingSystem

if TYPE_CHECKING:
    from ...action import RuntimeAction
    from ...baseline_rules.core import BaselineRuleDefinition
    from ...baseline_rules.selection import ActiveRuleSet
    from .profile import CommandInvocation

_RAW_DEVICE_REDIRECT_RE = re.compile(rf"{_CMDPOS}[^\n;|&]*>\s*/dev/{_BLOCK_DEVICE}\b")
_ENCRYPTION_TERMINAL_RE = re.compile(
    _CMDPOS + r"cryptsetup\s+luksFormat\b|"
    r"\bfind\s+(?:/|~|\$HOME)(?:\s|/)[^\n;]*-exec\s+(?:openssl\s+enc|gpg\b[^\n;]*(?:-c|--symmetric))",
    re.IGNORECASE | re.DOTALL,
)
_DESTRUCTIVE_FILESYSTEM_RE = re.compile(
    _CMDPOS + r"(?:rm\s+(?:-[^\s]*r[^\s]*\s+)+(?:\*|\./\*|\.)(?=$|[\s;|&\n`)])|"
    r"mv\s+/\s+/dev/null\b|chmod\s+-R\s+(?:000|777)\s+/(?=$|[\s;|&\n`)])|"
    r"chown\s+-R\s+(?:\$\([^)]+\)|\S+)\s+/(?=$|[\s;|&\n`)])|"
    r"find\s+/\s+[^\n;]*(?:-delete\b|-exec\s+rm\b|\|\s*xargs\s+rm\b))",
    re.IGNORECASE,
)
_SYSTEM_FILE_TRUNCATE_RE = re.compile(
    _CMDPOS + r"(?:truncate\b[^\n;|&]*/etc/(?:hosts|resolv\.conf|crontab)\b|"
    r"tee\b[^\n;|&]*/etc/(?:hosts|resolv\.conf|crontab)\b|"
    r"printf\b[^\n;|&]*>\s*/etc/(?:hosts|resolv\.conf|crontab)\b)|"
    r"(?:^|[;&|\n])\s*(?::\s*)?>\s*/etc/(?:hosts|resolv\.conf|crontab)\b",
    re.IGNORECASE,
)
_WINDOWS_DESTRUCTIVE_RE = re.compile(
    _CMDPOS + r"(?:del\b(?=[^\n;]*(?:/s|/q))(?=[^\n;]*[a-z]:[\\/]\*)|reg\s+delete\s+hk(?:lm|cu|cr|u|cc)[\\/]|"
    r"Remove-Item\b(?=[^\n;]*-Recurse)(?=[^\n;]*-Force)(?=[^\n;]*[a-z]:[\\/](?:\*|$|[\s;|&\n])))",
    re.IGNORECASE,
)
_WINDOWS_CMD_COMMAND_POS = rf"(?:{_CMDPOS}|\(\s*)"
_WINDOWS_RECURSIVE_DELETE_RE = re.compile(
    _WINDOWS_CMD_COMMAND_POS + r"(?:(?:cmd(?:\.exe)?\s+/[ck]\s+)?)(?:rd|rmdir)\b(?=[^;&|\n]*\s/s(?:\s|$))[^;&|\n]*",
    re.IGNORECASE,
)
_WINDOWS_DRIVE_ROOT_RE = re.compile(r"^[a-z]:/(?:\*)?$", re.IGNORECASE)
_POWERSHELL_ROOT_PIPELINE_DELETE_RE = re.compile(
    r"(?:Get-ChildItem|gci)\b[^|\n]*(?:-Path\s+)?['\"]?[a-z]:[\\/](?:\*)?['\"]?(?=\s|$|\|)[^|\n]*\|\s*"
    r"(?:Remove-Item|ri|rm)\b(?=[^;\n]*-Recurse)(?=[^;\n]*-Force)",
    re.IGNORECASE,
)
_POWERSHELL_ROOT_ASSIGNMENT_RE = re.compile(
    r"(?m)^\s*\$(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*['\"](?P<root>[a-z]:[\\/])['\"]",
    re.IGNORECASE,
)
_SYSTEM_STABILITY_RE = re.compile(
    _CMDPOS
    + r"killall5\s+-9\b|"
    + _CMDPOS
    + r"pkill\s+-f\s+(?:sshd|systemd)\b|"
    + _CMDPOS
    + r"umount\s+-R\s+/(?=$|[\s;|&\n)])",
    re.IGNORECASE,
)
_FIND_DELETE_RE = re.compile(_CMDPOS + r"find\b[^\n;]*(?:-delete\b|-exec\s+rm\b)", re.IGNORECASE)
_XARGS_DELETE_RE = re.compile(_CMDPOS + r"xargs\b[^\n;]*\brm\b", re.IGNORECASE)
_POWERSHELL_FILE_API_DELETE_RE = re.compile(
    r"\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\s*\(",
    re.IGNORECASE,
)
_SAFE_CLEANUP_BASENAMES = frozenset(
    {
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "__pycache__",
        "node_modules",
        "tmp",
    }
)
_DELETE_COMMANDS = frozenset({"del", "erase", "rd", "remove-item", "ri", "rm", "rmdir", "shred", "unlink"})
_FORCE_SIGNALS = frozenset({"-9", "-kill", "-sigkill"})
_PYTHON_NAMES = frozenset({"py", "python", "python3", "pythonw"})
_MCP_CLEANUP_COMMAND_RE = re.compile(
    r"^\s*(?:cd|rm|rmdir|unlink|ls|cat|head|tail|echo|printf|py|python|python3|pythonw)(?:\.exe)?(?=\s|$)",
    re.IGNORECASE,
)
_MCP_CLEANUP_OPTIONS = {
    "rm": r"--(?:force|recursive|verbose|dir)|-[frRvd]+|--",
    "rmdir": r"--verbose|-v|--",
    "unlink": r"--",
    "ls": r"-[alh1]+|--",
    "cat": r"-[benstuvAET]+|--",
    "head": r"-(?:[nc]\d*|\d+)|--",
    "tail": r"-(?:[nc]\d*|\d+)|--",
}

_SHELL_TERMINAL_PATTERNS: tuple[tuple[re.Pattern[str], BaselineRuleDefinition], ...] = (
    (re.compile(_CMDPOS + r"rm\s+(?:-[^\s]*\s+)*(/|/\*|/ \*)(?=$|[\s;|&\n`)])"), terminal_rules.RM_ROOT),
    (
        re.compile(
            _CMDPOS + r"rm\s+(?:-[^\s]*\s+)*(?:/home|/home/\*|/root|/root/\*|/etc|/etc/\*|"
            r"/usr(?!/local)|/usr/\*|/var|/var/\*|/bin|/bin/\*|/sbin|/sbin/\*|/boot|/boot/\*|/lib|/lib/\*)"
            r"(?=$|[\s;|&\n`)])"
        ),
        terminal_rules.RM_SYSTEM_DIR,
    ),
    (re.compile(_CMDPOS + r"rm\s+(?:-[^\s]*\s+)*(~|\$HOME)(?:/?|/\*)?(?=$|[\s;|&\n`)])"), terminal_rules.RM_HOME),
    (re.compile(rf"{_CMDPOS}dd\b[^\n;|&]*\bof=/dev/{_BLOCK_DEVICE}\b"), terminal_rules.RAW_DEVICE_WRITE),
    (re.compile(r"(?:^|[;&|\n`]|\$\()\s*:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"), terminal_rules.FORK_BOMB),
    (re.compile(_CMDPOS + r"kill\s+(?:-[^\s]+\s+)*-1\s*(?:$|[;&|\n])"), terminal_rules.KILL_ALL),
    (re.compile(_CMDPOS + r"telinit\s+[06]\b"), terminal_rules.TELINIT_POWER),
)
_WINDOWS_SHELL_TERMINAL_PATTERNS: tuple[tuple[re.Pattern[str], BaselineRuleDefinition], ...] = (
    (re.compile(_CMDPOS + r"format(?:\.com)?\s+[A-Za-z]:", re.IGNORECASE), terminal_rules.WINDOWS_FORMAT_DRIVE),
    (re.compile(_CMDPOS + r"cipher(?:\.exe)?\s+/w:", re.IGNORECASE), terminal_rules.WINDOWS_CIPHER_WIPE),
)


def detect_destructive_encryption(action: RuntimeAction) -> BaselineResult:
    """Deny broad disk or filesystem encryption patterns."""
    if _ENCRYPTION_TERMINAL_RE.search(action.normalized_payload):
        return result_for(terminal_rules.DESTRUCTIVE_ENCRYPTION, action, rule_content="destructive_encryption")
    return BaselineResult.no_signal()


def detect_system_stability_destroy(action: RuntimeAction) -> BaselineResult:
    """Deny process and mount operations that can destabilize the host."""
    if _SYSTEM_STABILITY_RE.search(action.normalized_payload):
        return result_for(terminal_rules.SYSTEM_STABILITY_DESTROY, action, rule_content="system_stability_destroy")
    return BaselineResult.no_signal()


def detect_windows_destructive_command(action: RuntimeAction) -> BaselineResult:
    """Deny Windows host destructive commands as a common fallback."""
    if _contains_powershell_root_recursive_delete(action.normalized_payload):
        return result_for(terminal_rules.WINDOWS_ROOT_RECURSIVE_DELETE, action, rule_content="windows_root_recursive_delete")
    if _contains_windows_recursive_delete(action):
        if any(_WINDOWS_DRIVE_ROOT_RE.fullmatch(path.replace("\\", "/")) for path in action.resolved_paths):
            return result_for(terminal_rules.WINDOWS_ROOT_RECURSIVE_DELETE, action, rule_content="windows_root_recursive_delete")
        if any(is_host_system_mutation_path(path) for path in action.resolved_paths):
            return result_for(terminal_rules.HOST_SYSTEM_PATH_MUTATION, action, rule_content="host_system_path_mutation")
    if _WINDOWS_DESTRUCTIVE_RE.search(action.normalized_payload):
        return result_for(terminal_rules.WINDOWS_DESTRUCTIVE_COMMAND, action, rule_content="windows_destructive_command")
    return BaselineResult.no_signal()


def detect_destructive_filesystem(action: RuntimeAction) -> BaselineResult:
    """Deny broad filesystem destruction outside project cleanup."""
    if _DESTRUCTIVE_FILESYSTEM_RE.search(action.normalized_payload):
        return result_for(terminal_rules.DESTRUCTIVE_FILESYSTEM, action, rule_content="destructive_filesystem")
    return BaselineResult.no_signal()


def detect_system_file_truncate(action: RuntimeAction) -> BaselineResult:
    """Deny truncation of critical system configuration files."""
    if _SYSTEM_FILE_TRUNCATE_RE.search(action.normalized_payload):
        return result_for(terminal_rules.SYSTEM_FILE_TRUNCATE, action, rule_content="system_file_truncate")
    return BaselineResult.no_signal()


def detect_force_process_termination(action: RuntimeAction) -> BaselineResult:
    """Require approval for forceful process-name or process-tree termination."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if is_help_or_version_only_invocation(invocation):
            continue
        command = invocation.canonical_name
        args = invocation.args
        if command in {"pkill", "killall"} and _has_sigkill(command, args) and _has_unix_process_selector(args):
            return result_for(ask_rules.FORCE_PROCESS_TERMINATION, action)
        if command == "taskkill" and _forceful_taskkill_is_broad(args):
            return result_for(ask_rules.FORCE_PROCESS_TERMINATION, action)
        if command == "stop-process" and _forceful_stop_process_is_broad(args):
            return result_for(ask_rules.FORCE_PROCESS_TERMINATION, action)
    return BaselineResult.no_signal()


def _has_sigkill(command: str, args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if any(arg in _FORCE_SIGNALS or arg in {"--signal=9", "--signal=kill", "--signal=sigkill"} for arg in lowered):
        return True
    signal_options = {"--signal", "-s"} if command == "killall" else {"--signal"}
    return any(lowered[index] in signal_options and lowered[index + 1] in {"9", "kill", "sigkill"} for index in range(len(lowered) - 1))


def _has_unix_process_selector(args: tuple[str, ...]) -> bool:
    index = 0
    while index < len(args):
        arg = args[index].casefold()
        if arg == "--signal":
            index += 2
            continue
        if arg not in _FORCE_SIGNALS and not arg.startswith("--signal=") and not arg.startswith("-"):
            return True
        index += 1
    return False


def _forceful_taskkill_is_broad(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    return "/f" in lowered and ("/im" in lowered or any(arg.startswith("/im:") for arg in lowered) or "/t" in lowered)


def _forceful_stop_process_is_broad(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if "-force" not in lowered:
        return False
    if any(arg in {"-name", "-inputobject"} or arg.startswith(("-name:", "-inputobject:")) for arg in lowered):
        return True
    has_id = any(arg == "-id" or arg.startswith("-id:") for arg in lowered)
    return not has_id and bool(args) and not args[0].startswith("-")


def detect_delete_mutation(action: RuntimeAction) -> BaselineResult:
    """Require approval for explicit file or directory deletion."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    profile = profile_shell_command(action.normalized_payload)
    python_delete_targets = _explicit_python_file_delete_targets(profile.invocations)
    has_delete = any(
        invocation.canonical_name in _DELETE_COMMANDS and not is_help_or_version_only_invocation(invocation)
        for invocation in profile.invocations
    ) or bool(python_delete_targets)
    has_bulk_delete = any(
        pattern.search(action.normalized_payload) is not None
        for pattern in (_XARGS_DELETE_RE, _FIND_DELETE_RE, _POWERSHELL_FILE_API_DELETE_RE)
    )
    if not has_delete and not has_bulk_delete:
        return BaselineResult.no_signal()
    if (
        _is_filtered_cache_find(action)
        or _only_deletes_known_workspace_caches(action)
        or _only_cleans_mcp_python_caches(action)
        or _only_deletes_current_lite_windows_temporary_targets(action, python_delete_targets)
        or _only_deletes_missing_lite_windows_workspace_targets(action)
    ):
        return BaselineResult.no_signal()
    paths = mutation_paths(action)
    raw_targets = mutation_target_values(action)
    if (
        len(paths) == len(raw_targets)
        and paths_are_strictly_within_managed_session_workspace(paths, action.cwd)
    ):
        return BaselineResult.no_signal()
    return result_for(filesystem_rules.DELETE_MUTATION, action)


def _only_cleans_mcp_python_caches(action: RuntimeAction) -> bool:  # noqa: PLR0911 - Exemption checks fail closed at each boundary.
    if action.profile != BuildProfile.LITE or action.operating_system != OperatingSystem.WINDOWS:
        return False
    command = action.normalized_payload
    try:
        shlex.split(command, posix="\\" not in command)
    except ValueError:
        return False
    analysis = analyze_shell_text(command)
    text = analysis.top_level_executable_text
    # Only && chains: failed directory changes must prevent relative deletions.
    if (
        analysis.nested_commands
        or any(char in command for char in "$%`")
        or re.search(r"[<>()[\]{}#!;|\\\r\n]|(?<!&)&(?!&)", text)
        or any(not _MCP_CLEANUP_COMMAND_RE.match(segment) for segment in text.split("&&"))
    ):
        return False
    paths = mutation_paths(action)
    raw_targets = mutation_target_values(action)
    service_roots = {current_windows_mcp_service_root(path) for path in paths}
    if (
        not paths
        or len(paths) != len(raw_targets)
        or not all(_is_literal_delete_target(target) for target in raw_targets)
        or not all(path.endswith("/__pycache__") for path in paths)
        or None in service_roots
    ):
        return False
    current_dir = action.cwd
    for invocation in profile_shell_command(command).invocations:
        if invocation.canonical_name == "cd":
            if len(invocation.args) != 1 or not _is_literal_delete_target(invocation.args[0]):
                return False
            current_dir = resolve_shell_path(invocation.args[0], current_dir)
            if not current_dir:
                return False
        elif not _is_mcp_cleanup_companion(invocation, current_dir, service_roots):
            return False
    return True


def _is_mcp_cleanup_companion(invocation: CommandInvocation, cwd: str | None, service_roots: set[str | None]) -> bool:
    name, args = invocation.canonical_name, invocation.args
    if name in _MCP_CLEANUP_OPTIONS:
        return all(re.fullmatch(_MCP_CLEANUP_OPTIONS[name], arg) if arg.startswith("-") else _is_literal_delete_target(arg) for arg in args)
    if name in _PYTHON_NAMES:
        match args:
            case ("-c", source):
                return _is_readonly_json_validation(source)
            case ("-m", "py_compile", *targets):
                return bool(targets) and all(
                    not target.startswith("-")
                    and target.endswith(".py")
                    and _is_literal_delete_target(target)
                    and current_windows_mcp_service_root(resolve_shell_path(target, cwd)) in service_roots
                    for target in targets
                )
        return False
    return _is_literal_status_output(invocation)


def _is_readonly_json_validation(source: str) -> bool:
    """Recognize import json, read-only json.load(open(...)), and literal print."""
    try:
        statements = ast.parse(source).body
    except (SyntaxError, ValueError):
        return False
    match statements:
        case [ast.Import(names=[ast.alias(name="json", asname=None)]), *body]:
            pass
        case _:
            return False
    has_read = False
    for statement in body:
        match statement:
            case ast.Expr(value=ast.Call(func=ast.Name(id="print"), args=args, keywords=[])):
                if not all(isinstance(arg, ast.Constant) and isinstance(arg.value, str) for arg in args):
                    return False
            case ast.Expr(value=ast.Call(func=ast.Attribute(value=ast.Name(id="json"), attr="load"), args=[opened], keywords=[])):
                if not _is_readonly_json_open(opened):
                    return False
                has_read = True
            case _:
                return False
    return has_read


def _is_readonly_json_open(node: ast.expr) -> bool:
    match node:
        case ast.Call(func=ast.Name(id="open"), args=[ast.Constant(value=str()), *modes], keywords=keywords):
            if modes and (
                len(modes) != 1
                or not isinstance(modes[0], ast.Constant)
                or modes[0].value not in {"r", "rt"}
                or any(keyword.arg == "mode" for keyword in keywords)
            ):
                return False
            return len({keyword.arg for keyword in keywords}) == len(keywords) and all(
                keyword.arg in {"mode", "encoding"}
                and isinstance(keyword.value, ast.Constant)
                and isinstance(keyword.value.value, str)
                and (keyword.arg != "mode" or keyword.value.value in {"r", "rt"})
                for keyword in keywords
            )
        case _:
            return False


def _explicit_python_file_delete_targets(invocations: tuple[CommandInvocation, ...]) -> tuple[str, ...]:
    """Extract targets from an explicit ``python script.py --delete --files`` contract."""
    targets: list[str] = []
    for invocation in invocations:
        args = invocation.args
        if invocation.canonical_name not in _PYTHON_NAMES or "--delete" not in args:
            continue
        if not any(arg.strip("\"'`").casefold().endswith(".py") for arg in args):
            continue
        for index, arg in enumerate(args):
            value = ""
            if arg == "--files" and index + 1 < len(args):
                value = args[index + 1]
            elif arg.startswith("--files="):
                value = arg.partition("=")[2]
            if value:
                targets.extend(item.strip() for item in value.split(",") if item.strip())
    return tuple(dict.fromkeys(targets))


def _only_deletes_current_lite_windows_temporary_targets(
    action: RuntimeAction,
    python_delete_targets: tuple[str, ...],
) -> bool:
    if action.profile != BuildProfile.LITE or action.operating_system != OperatingSystem.WINDOWS:
        return False
    paths = mutation_paths(action)
    raw_targets = mutation_target_values(action)
    if len(paths) != len(raw_targets):
        return False
    targets = (
        *(path for path, raw in zip(paths, raw_targets, strict=True) if not _is_redirection_artifact(raw)),
        *python_delete_targets,
    )
    return bool(targets) and all(is_current_windows_temporary_delete_target(target) for target in targets)


def _is_redirection_artifact(value: str) -> bool:
    return re.match(r"^(?:\d+|&)?[<>]", value.strip().strip("\"'`")) is not None


def _only_deletes_known_workspace_caches(action: RuntimeAction) -> bool:
    if mutation_workspace_scope(action) != WorkspaceScope.INSIDE:
        return False
    paths = mutation_paths(action)
    if not paths or len(paths) != len(mutation_target_values(action)):
        return False
    workspace_prefix = normalize_path_for_policy(action.cwd or "").rstrip("/") + "/"
    if not all(_is_at_or_below_known_workspace_cache(path, workspace_prefix) for path in paths):
        return False
    executable_text = analyze_shell_text(action.normalized_payload).executable_text
    if ">" in executable_text or "<" in executable_text:
        return False
    return all(
        invocation.canonical_name in _DELETE_COMMANDS or _is_literal_status_output(invocation)
        for invocation in profile_shell_command(action.normalized_payload).invocations
        if invocation.canonical_name not in {"cd", "chdir", "popd", "pushd", "set-location", "sl"}
    )


def _only_deletes_missing_lite_windows_workspace_targets(action: RuntimeAction) -> bool:
    """Allow literal deletes that cannot remove a pre-existing host file."""
    if action.profile != BuildProfile.LITE or action.operating_system != OperatingSystem.WINDOWS:
        return False
    if not action.cwd or not path_is_directory(action.cwd) or mutation_workspace_scope(action) != WorkspaceScope.INSIDE:
        return False

    paths = mutation_paths(action)
    raw_targets = mutation_target_values(action)
    if not paths or len(paths) != len(raw_targets):
        return False
    workspace = normalize_path_for_policy(action.cwd)
    return all(
        _is_literal_delete_target(raw_target)
        and normalize_path_for_policy(path) != workspace
        and not path_exists(path)
        for path, raw_target in zip(paths, raw_targets, strict=True)
    )


def _is_literal_delete_target(value: str) -> bool:
    normalized = value.strip().strip("\"'`").replace("\\", "/")
    return bool(normalized) and not any(char in normalized for char in "$%*?[]`") and ".." not in normalized.split("/")


def _is_literal_status_output(invocation: CommandInvocation) -> bool:
    if invocation.executable not in {"echo", "printf"} or any(marker in invocation.raw_segment for marker in ("$", "`")):
        return False
    if invocation.executable == "echo":
        return True
    if not invocation.args:
        return False
    # Only literal text, %% and %s formats: printf -v and %n can mutate variables.
    format_string = invocation.args[0].strip("\"'")
    return not format_string.startswith("-") and "%" not in format_string.replace("%%", "").replace("%s", "")


def _is_filtered_cache_find(action: RuntimeAction) -> bool:
    command = action.normalized_payload
    normalized = command.casefold().replace('"', "").replace("'", "")
    if not re.search(r"(?:^|[;&|\n])\s*find\s+\.\s", normalized):
        return False
    if re.search(r"\s-(?:o|or)\s", normalized):
        return False
    selectors = re.findall(r"-(?:name|path)\s+([^\s;|&]+)", normalized)
    if not selectors:
        return False
    safe_markers = ("*.pyc", "*.pyo", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache")
    return all(any(marker in selector for marker in safe_markers) for selector in selectors) and mutation_workspace_scope(
        action
    ) == WorkspaceScope.INSIDE


def _is_at_or_below_known_workspace_cache(raw_target: str, workspace_prefix: str) -> bool:
    target = normalize_path_for_policy(raw_target)
    target = target.removesuffix("/*")
    if any(marker in target for marker in ("*", "?", "[")) or not target.startswith(workspace_prefix):
        return False
    relative_parts = target.removeprefix(workspace_prefix).split("/")
    return any(part in _SAFE_CLEANUP_BASENAMES for part in relative_parts)


def _contains_windows_recursive_delete(action: RuntimeAction) -> bool:
    return _WINDOWS_RECURSIVE_DELETE_RE.search(analyze_shell_text(action.normalized_payload).executable_text) is not None


def _contains_powershell_root_recursive_delete(command: str) -> bool:
    if _POWERSHELL_ROOT_PIPELINE_DELETE_RE.search(command):
        return True

    for root_match in _POWERSHELL_ROOT_ASSIGNMENT_RE.finditer(command):
        root_variable = re.escape(f"${root_match.group('name')}")
        collection_re = re.compile(
            rf"\$(?P<collection>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:Get-ChildItem|gci)\b[^\n;]*{root_variable}\b",
            re.IGNORECASE,
        )
        for collection_match in collection_re.finditer(command):
            collection_variable = re.escape(f"${collection_match.group('collection')}")
            foreach_re = re.compile(
                rf"foreach\s*\(\s*\$(?P<item>[A-Za-z_][A-Za-z0-9_]*)\s+in\s+{collection_variable}\s*\)",
                re.IGNORECASE,
            )
            for foreach_match in foreach_re.finditer(command):
                item_variable = re.escape(f"${foreach_match.group('item')}")
                remove_re = re.compile(
                    rf"(?:Remove-Item|ri|rm)\b(?=[^;\n]*{item_variable}(?:\.FullName)?\b)"
                    r"(?=[^;\n]*-Recurse)(?=[^;\n]*-Force)",
                    re.IGNORECASE,
                )
                if remove_re.search(command, foreach_match.end()):
                    return True
    return False


def _active_terminal_patterns() -> tuple[tuple[re.Pattern[str], BaselineRuleDefinition], ...]:
    return _SHELL_TERMINAL_PATTERNS + _WINDOWS_SHELL_TERMINAL_PATTERNS


def detect_raw_device_redirect(action: RuntimeAction) -> BaselineResult:
    """Deny shell redirection that writes to a block device."""
    if _RAW_DEVICE_REDIRECT_RE.search(analyze_shell_text(action.normalized_payload).executable_text):
        return result_for(terminal_rules.RAW_DEVICE_REDIRECT, action, rule_content=_RAW_DEVICE_REDIRECT_RE.pattern)
    return BaselineResult.no_signal()


def detect_builtin_terminal_patterns(action: RuntimeAction, active_rules: ActiveRuleSet) -> BaselineResult:
    """Run fallback terminal shell patterns."""
    invocations = profile_shell_command(action.normalized_payload).invocations
    if invocations and all(is_help_or_version_only_invocation(invocation) for invocation in invocations):
        return BaselineResult.no_signal()
    executable_command = analyze_shell_text(action.normalized_payload).executable_text
    for regex, rule in _active_terminal_patterns():
        if not active_rules.contains(rule):
            continue
        if regex.search(executable_command):
            return result_for(rule, action, rule_content=regex.pattern)
    return BaselineResult.no_signal()
