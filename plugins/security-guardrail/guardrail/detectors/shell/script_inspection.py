"""Bounded inspection of local scripts referenced by shell commands."""

from __future__ import annotations

from ...runtime import ContextUnavailableError, execution_environment
from ...types import OperatingSystem

import ast
import re
from dataclasses import dataclass
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath
from typing import TYPE_CHECKING

from .profile import CommandInvocation, profile_shell_command
from ...path_policy import contains_host_system_mutation_path

if TYPE_CHECKING:
    from ...action import RuntimeAction
    from .profile import ShellCommandProfile

_MAX_SCRIPT_BYTES = 1024 * 1024
_MAX_REFERENCED_SCRIPTS = 4
_SUPPORTED_SCRIPT_SUFFIXES = frozenset({".bat", ".cmd", ".ps1", ".psm1", ".py", ".sh"})
_POWERSHELL_NAMES = frozenset({"powershell", "pwsh"})
_PYTHON_NAMES = frozenset({"py", "python", "python3", "pythonw"})
_SHELL_NAMES = frozenset({"bash", "dash", "ksh", "sh", "zsh"})
_DIRECTORY_NAMES = frozenset({"cd", "chdir", "set-location", "sl"})
_PYTHON_OPTIONS_WITH_VALUE = frozenset({"-c", "-m", "-w", "-x"})
_PYTHON_MUTATING_METHODS = frozenset(
    {
        "chmod",
        "mkdir",
        "rename",
        "replace",
        "rmdir",
        "touch",
        "unlink",
        "write_bytes",
        "write_text",
    }
)
_PYTHON_MUTATING_FUNCTIONS = frozenset(
    {
        "chmod",
        "chown",
        "copy",
        "copy2",
        "copyfile",
        "makedirs",
        "mkdir",
        "move",
        "remove",
        "removedirs",
        "rename",
        "replace",
        "rmdir",
        "rmtree",
        "unlink",
    }
)
_PYTHON_NETWORK_SEND_METHODS = frozenset({"send", "sendall", "sendto"})
_PYTHON_NETWORK_PACING_METHODS = frozenset({"sleep"})
_PYTHON_NETWORK_RECEIVE_METHODS = frozenset({"accept", "recv", "recvfrom", "recv_into", "recvfrom_into"})
_BCD_REFERENCE_RE = re.compile(r"\b(?:bcd\d{8}|(?:offline|temp)_bcd[\w-]*|bcd_test)\b", re.IGNORECASE)
_PYTHON_BCD_HIVE_MUTATING_METHODS = frozenset({"create_key", "delete_key", "flush", "set_value"})
_PYTHON_BCD_WIN32_MUTATING_FUNCTIONS = frozenset(
    {
        "regcreatekeyexw",
        "regdeletekeyw",
        "regdeletetreew",
        "regreplacekeyw",
        "regrestorekeyw",
        "regsavekeyexw",
        "regsetvalueexw",
    }
)
_PYTHON_SUBPROCESS_METHODS = frozenset({"call", "check_call", "check_output", "popen", "run"})
_REG_MUTATION_MIN_ARGUMENTS = 3


@dataclass(frozen=True)
class ReferencedScript:
    """A readable local script explicitly selected for execution."""

    path: PurePath
    content: str


def load_referenced_scripts(
    action: RuntimeAction,
    *,
    command_profile: ShellCommandProfile | None = None,
) -> tuple[ReferencedScript, ...]:
    """Read a small bounded set of local scripts explicitly executed by an action."""
    scripts: list[ReferencedScript] = []
    seen: set[str] = set()
    profile = command_profile or profile_shell_command(action.normalized_payload)
    current_dir = action.cwd
    for invocation in profile.invocations:
        if invocation.canonical_name in _DIRECTORY_NAMES:
            directory = _directory_argument(invocation.args)
            current_dir = str(_resolve_script_path(directory, current_dir)) if directory else None
            continue
        raw_path = _script_argument(invocation)
        if not raw_path:
            continue
        path = _resolve_script_path(raw_path, current_dir)
        key = str(path).casefold() if execution_environment().operating_system == OperatingSystem.WINDOWS else str(path)
        if key in seen:
            continue
        seen.add(key)
        content = _read_script(path)
        if content is None:
            continue
        scripts.append(ReferencedScript(path=path, content=content))
        if len(scripts) >= _MAX_REFERENCED_SCRIPTS:
            break
    return tuple(scripts)


def _directory_argument(args: tuple[str, ...]) -> str:
    return next((arg for arg in args if arg.casefold() != "/d" and not arg.startswith("-")), "")


def python_script_mutates_host_system_path(content: str) -> bool:
    """Return whether Python source mutates a statically visible host system path."""
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return False

    tainted_names = _host_path_names(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if _is_mutating_python_call(node, tainted_names):
            return True
    return False


def python_script_performs_network_flood(content: str) -> bool:
    """Return whether Python source contains an unpaced socket send loop."""
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return False

    socket_names = _python_socket_names(tree)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.For, ast.While)):
            continue
        calls = tuple(child for child in ast.walk(node) if isinstance(child, ast.Call))
        if not any(_is_socket_method_call(call, socket_names, _PYTHON_NETWORK_SEND_METHODS) for call in calls):
            continue
        if any(_is_method_call(call, _PYTHON_NETWORK_PACING_METHODS | _PYTHON_NETWORK_RECEIVE_METHODS) for call in calls):
            continue
        return True
    return False


def python_script_mutates_bcd_store(content: str) -> bool:
    """Return whether Python source mutates a statically visible Windows BCD store."""
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return False

    bcd_names = _bcd_reference_names(tree)
    if not bcd_names and not _expression_targets_bcd(tree, bcd_names):
        return False
    hive_names = _python_bcd_hive_names(tree, bcd_names)
    calls = (node for node in ast.walk(tree) if isinstance(node, ast.Call))
    return any(
        _is_bcd_hive_mutation(node, hive_names)
        or _is_bcd_win32_mutation(node, bcd_names)
        or _is_bcd_reg_subprocess_mutation(node, bcd_names)
        or _is_bcd_file_mutation(node, bcd_names)
        for node in calls
    )


def _script_argument(invocation: CommandInvocation) -> str:
    executable_suffix = Path(invocation.executable.strip().strip("\"'`")).suffix.casefold()
    if executable_suffix in _SUPPORTED_SCRIPT_SUFFIXES:
        return invocation.executable
    if invocation.canonical_name in _POWERSHELL_NAMES:
        return _powershell_script_argument(invocation.args)
    if invocation.canonical_name in _PYTHON_NAMES:
        return _python_script_argument(invocation.args)
    if invocation.canonical_name in _SHELL_NAMES:
        return _positional_script_argument(invocation.args, ".sh")
    return ""


def _python_socket_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if not isinstance(value, ast.Call) or not _is_socket_constructor(value.func):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else (node.target,)
        names.update(target.id for target in targets if isinstance(target, ast.Name))
    return names


def _bcd_reference_names(tree: ast.AST) -> set[str]:
    tainted: set[str] = set()
    assignments: list[tuple[str, ast.expr]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            assignments.extend((target.id, node.value) for target in node.targets if isinstance(target, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            assignments.append((node.target.id, node.value))

    changed = True
    while changed:
        changed = False
        for name, value in assignments:
            if name not in tainted and _expression_targets_bcd(value, tainted):
                tainted.add(name)
                changed = True
    return tainted


def _expression_targets_bcd(node: ast.AST, tainted_names: set[str]) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id in tainted_names:
            return True
        if isinstance(child, ast.Constant) and isinstance(child.value, str) and _BCD_REFERENCE_RE.search(child.value):
            return True
    return False


def _python_bcd_hive_names(tree: ast.AST, bcd_names: set[str]) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if not isinstance(value, ast.Call) or _python_call_name(value).casefold() != "registryhive":
            continue
        if not value.args or not _expression_targets_bcd(value.args[0], bcd_names):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else (node.target,)
        names.update(target.id for target in targets if isinstance(target, ast.Name))
    return names


def _is_bcd_hive_mutation(node: ast.Call, hive_names: set[str]) -> bool:
    function = node.func
    return (
        isinstance(function, ast.Attribute)
        and function.attr.casefold() in _PYTHON_BCD_HIVE_MUTATING_METHODS
        and isinstance(function.value, ast.Name)
        and function.value.id in hive_names
    )


def _is_bcd_win32_mutation(node: ast.Call, bcd_names: set[str]) -> bool:
    name = _python_call_name(node).casefold()
    return name in _PYTHON_BCD_WIN32_MUTATING_FUNCTIONS and any(_expression_targets_bcd(arg, bcd_names) for arg in node.args)


def _is_bcd_reg_subprocess_mutation(node: ast.Call, bcd_names: set[str]) -> bool:
    if _python_call_name(node).casefold() not in _PYTHON_SUBPROCESS_METHODS or not node.args:
        return False
    arguments = node.args[0]
    if not isinstance(arguments, (ast.List, ast.Tuple)) or len(arguments.elts) < _REG_MUTATION_MIN_ARGUMENTS:
        return False
    executable = _string_constant(arguments.elts[0]).casefold()
    operation = _string_constant(arguments.elts[1]).casefold()
    return (
        executable in {"reg", "reg.exe"}
        and operation in {"add", "delete", "restore"}
        and any(_expression_targets_bcd(arg, bcd_names) for arg in arguments.elts[2:])
    )


def _is_bcd_file_mutation(node: ast.Call, bcd_names: set[str]) -> bool:
    function = node.func
    if isinstance(function, ast.Name) and function.id == "open":
        return bool(node.args) and _expression_targets_bcd(node.args[0], bcd_names) and _call_uses_write_mode(node)
    if not isinstance(function, ast.Attribute):
        return False
    method = function.attr.casefold()
    if method == "open":
        return _expression_targets_bcd(function.value, bcd_names) and _call_uses_write_mode(node)
    if method in _PYTHON_MUTATING_METHODS:
        return _expression_targets_bcd(function.value, bcd_names)
    if method in _PYTHON_MUTATING_FUNCTIONS:
        return any(_expression_targets_bcd(arg, bcd_names) for arg in node.args)
    return False


def _python_call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return ""


def _string_constant(node: ast.AST) -> str:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else ""


def _is_socket_constructor(function: ast.expr) -> bool:
    return (isinstance(function, ast.Attribute) and function.attr.casefold() == "socket") or (
        isinstance(function, ast.Name) and function.id.casefold() == "socket"
    )


def _is_socket_method_call(node: ast.Call, socket_names: set[str], methods: frozenset[str]) -> bool:
    function = node.func
    return (
        isinstance(function, ast.Attribute)
        and function.attr.casefold() in methods
        and isinstance(function.value, ast.Name)
        and function.value.id in socket_names
    )


def _is_method_call(node: ast.Call, methods: frozenset[str]) -> bool:
    return isinstance(node.func, ast.Attribute) and node.func.attr.casefold() in methods


def _powershell_script_argument(args: tuple[str, ...]) -> str:
    for index, raw_arg in enumerate(args):
        option, separator, inline_value = raw_arg.partition(":")
        if not separator:
            option, separator, inline_value = raw_arg.partition("=")
        if option.casefold() not in {"-f", "-file"}:
            continue
        if separator and inline_value:
            return inline_value
        return args[index + 1] if index + 1 < len(args) else ""
    return ""


def _python_script_argument(args: tuple[str, ...]) -> str:
    index = 0
    while index < len(args):
        arg = args[index]
        option = arg.casefold()
        if option in _PYTHON_OPTIONS_WITH_VALUE:
            index += 2
            continue
        if arg.startswith("-"):
            index += 1
            continue
        return arg if Path(arg.strip("\"'`")).suffix.casefold() == ".py" else ""
    return ""


def _positional_script_argument(args: tuple[str, ...], suffix: str) -> str:
    for arg in args:
        if arg.startswith("-"):
            continue
        if Path(arg.strip("\"'`")).suffix.casefold() == suffix:
            return arg
        return ""
    return ""


def _resolve_script_path(raw_path: str, cwd: str | None) -> PurePath:
    environment = execution_environment()
    def expand(match):
        name = next(value for value in match.groups() if value is not None)
        if name not in environment.variables:
            raise ContextUnavailableError("Script variable is not supplied by the execution host")
        return environment.variables[name]
    expanded = re.sub(r"\$(?:\{(\w+)\}|(\w+))|%(\w+)%", expand, raw_path.strip().strip("\"'`"))
    if expanded == "~" or expanded.startswith(("~/", "~\\")):
        if environment.home is None:
            raise ContextUnavailableError("Script home is unknown")
        expanded = environment.home + expanded[1:]
    if environment.resolve_path is not None:
        expanded = environment.resolve_path(expanded, cwd)
    cls = PureWindowsPath if environment.operating_system == OperatingSystem.WINDOWS else PurePosixPath
    path = cls(expanded)
    if not path.is_absolute():
        if not cwd:
            raise ContextUnavailableError("Script working directory is unknown")
        path = cls(cwd) / path
    return path


def _read_script(path: PurePath) -> str | None:
    if path.suffix.casefold() not in _SUPPORTED_SCRIPT_SUFFIXES:
        return None
    reader = execution_environment().script_reader
    if reader is None:
        raise ContextUnavailableError("Execution host has not supplied a script reader")
    data = reader(str(path), _MAX_SCRIPT_BYTES + 1)
    if data is None:
        return None
    if not isinstance(data, bytes):
        raise ContextUnavailableError("Script reader must return bytes or confirmed absence")
    if len(data) > _MAX_SCRIPT_BYTES:
        raise ContextUnavailableError("Referenced script exceeds inspection limit")
    return _decode_script(data)


def _decode_script(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    if data.count(b"\x00") > len(data) // 4:
        return data.decode("utf-16-le", errors="replace")
    return data.decode("utf-8-sig", errors="replace")


def _host_path_names(tree: ast.AST) -> set[str]:
    tainted: set[str] = set()
    assignments: list[tuple[str, ast.expr]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            assignments.extend((target.id, node.value) for target in node.targets if isinstance(target, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            assignments.append((node.target.id, node.value))

    changed = True
    while changed:
        changed = False
        for name, value in assignments:
            if name not in tainted and _expression_targets_host_path(value, tainted):
                tainted.add(name)
                changed = True
    return tainted


def _expression_targets_host_path(node: ast.AST, tainted_names: set[str]) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id in tainted_names:
            return True
        if isinstance(child, ast.Constant) and isinstance(child.value, str) and contains_host_system_mutation_path(child.value):
            return True
    return False


def _is_mutating_python_call(node: ast.Call, tainted_names: set[str]) -> bool:
    function = node.func
    if isinstance(function, ast.Name) and function.id == "open":
        return bool(node.args) and _expression_targets_host_path(node.args[0], tainted_names) and _call_uses_write_mode(node)
    if not isinstance(function, ast.Attribute):
        return False

    method = function.attr.casefold()
    if method == "open":
        return _expression_targets_host_path(function.value, tainted_names) and _call_uses_write_mode(node)
    if method in _PYTHON_MUTATING_METHODS:
        return _expression_targets_host_path(function.value, tainted_names)
    if method in _PYTHON_MUTATING_FUNCTIONS:
        return any(_expression_targets_host_path(arg, tainted_names) for arg in node.args)
    return False


def _call_uses_write_mode(node: ast.Call) -> bool:
    mode: ast.expr | None = node.args[1] if len(node.args) > 1 else None
    for keyword in node.keywords:
        if keyword.arg == "mode":
            mode = keyword.value
            break
    return isinstance(mode, ast.Constant) and isinstance(mode.value, str) and any(flag in mode.value for flag in "wax+")
