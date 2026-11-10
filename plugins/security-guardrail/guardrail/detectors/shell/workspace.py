"""High-confidence workspace-boundary approval checks for shell mutations."""

from __future__ import annotations

from ...runtime import path_exists

import posixpath
import re
from typing import TYPE_CHECKING

from ...action import ToolType, WorkspaceScope
from ...baseline_rules import filesystem as filesystem_rules
from ...baseline_rules import result_for
from .profile import CommandInvocation, profile_shell_command
from ...path_policy import (
    is_current_windows_temporary_delete_target,
    is_hexagent_public_skill_descendant,
    is_managed_session_workspace,
    is_recognized_temporary_descendant,
    normalize_path_for_policy,
)
from ...signals import BaselineResult
from ...types import BuildProfile, OperatingSystem

if TYPE_CHECKING:
    from ...action import RuntimeAction


_WINDOWS_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:[/\\]")
_REDIRECT_RE = re.compile(r"^(?:(?:\d+|&)?>{1,2})(?P<target>.*)$")
_POWERSHELL_FILE_API_CALL_RE = re.compile(
    r"\[(?:System\.)?IO\.(?:File|Directory)\]::"
    r"(?P<method>WriteAllText|WriteAllBytes|AppendAllText|Create|CreateDirectory|Copy|Delete|Move|Replace)"
    r"\s*\((?P<arguments>[^\n)]*)\)",
    re.IGNORECASE,
)
_POWERSHELL_LITERAL_ARGUMENT_RE = re.compile(r"(?:'(?P<single>[^']+)'|\"(?P<double>[^\"]+)\")")
_CMD_SWITCHES = frozenset(
    {
        "/a",
        "/b",
        "/c",
        "/d",
        "/e",
        "/f",
        "/g",
        "/h",
        "/i",
        "/j",
        "/k",
        "/l",
        "/m",
        "/n",
        "/o",
        "/p",
        "/q",
        "/r",
        "/s",
        "/t",
        "/u",
        "/v",
        "/w",
        "/x",
        "/y",
        "/z",
        "/-y",
    }
)
_CMD_SWITCH_PREFIXES = ("/a:", "/copy:", "/d:", "/dcopy:", "/exclude:")
_CMD_RMDIR_SWITCHES = frozenset({"/s", "/q"})
_ICACLS_MUTATION_SWITCHES = frozenset(
    {
        "/deny",
        "/grant",
        "/inheritance",
        "/remove",
        "/reset",
        "/restore",
        "/setintegritylevel",
        "/substitute",
    }
)
_MIN_COPY_ARGUMENTS = 2
_INLINE_OUTPUT_OPTION_LENGTH = 2

_POWERSHELL_PATH_OPTIONS = frozenset({"-destination", "-filepath", "-literalpath", "-path"})
_POWERSHELL_VALUE_OPTIONS = frozenset(
    {
        "-credential",
        "-encoding",
        "-exclude",
        "-filter",
        "-include",
        "-itemtype",
        "-name",
        "-newname",
        "-stream",
        "-value",
    }
)
_PUBLIC_SKILL_WRITE_COMMANDS = frozenset(
    {
        "add-content",
        "copy",
        "copy-item",
        "cp",
        "cpi",
        "echo",
        "install",
        "md",
        "mkdir",
        "new-item",
        "ni",
        "out-file",
        "printf",
        "robocopy",
        "set-content",
        "tee",
        "tee-object",
        "touch",
        "xcopy",
    }
)
_DELETE_COMMANDS = frozenset({"del", "erase", "rd", "remove-item", "ri", "rm", "rmdir", "shred", "unlink"})


def detect_workspace_external_mutation(action: RuntimeAction) -> BaselineResult:
    """Require approval when a mutation crosses a user-selected workspace."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if is_managed_session_workspace(action.workspace_root):
        return BaselineResult.no_signal()

    paths = mutation_paths(action)
    if (
        only_writes_current_public_skills(action)
        or _only_deletes_current_lite_windows_temporary_targets(action, paths)
        or _only_creates_missing_lite_windows_temporary_targets(action, paths)
    ):
        return BaselineResult.no_signal()
    scope = _workspace_scope(paths, action.workspace_root)
    if scope not in {WorkspaceScope.OUTSIDE, WorkspaceScope.MIXED}:
        return BaselineResult.no_signal()

    target = next((path for path in paths if not _is_inside_workspace(path, action.workspace_root)), "")
    reason = f"修改工作区外文件 {target}" if target else filesystem_rules.WORKSPACE_EXTERNAL_MUTATION.reason
    return result_for(filesystem_rules.WORKSPACE_EXTERNAL_MUTATION, action, reason=reason)


def _only_creates_missing_lite_windows_temporary_targets(
    action: RuntimeAction,
    paths: tuple[str, ...],
) -> bool:
    """Allow new literal files below host temporary roots without permitting overwrites."""
    if action.profile != BuildProfile.LITE or action.operating_system != OperatingSystem.WINDOWS:
        return False
    raw_targets = mutation_target_values(action)
    invocations = profile_shell_command(action.normalized_payload).invocations
    mutators = tuple(
        invocation
        for invocation in invocations
        if _mutation_targets(invocation, operating_system=action.operating_system)
        or _redirection_targets((*invocation.args, *invocation.redirection_args))
    )
    normalized_raw_targets = {
        normalize_path_for_policy(raw_target)
        for raw_target in raw_targets
        if _is_literal_target(raw_target)
    }
    return (
        bool(paths)
        and bool(mutators)
        and all(invocation.canonical_name not in _DELETE_COMMANDS for invocation in mutators)
        and len(normalized_raw_targets) == len(paths)
        and normalized_raw_targets == {normalize_path_for_policy(path) for path in paths}
        and len(normalized_raw_targets) == len({normalize_path_for_policy(raw_target) for raw_target in raw_targets})
        and all(
            is_recognized_temporary_descendant(path)
            and not path_exists(path)
            for path in paths
        )
    )


def _only_deletes_current_lite_windows_temporary_targets(
    action: RuntimeAction,
    paths: tuple[str, ...],
) -> bool:
    if action.profile != BuildProfile.LITE or action.operating_system != OperatingSystem.WINDOWS:
        return False
    invocations = profile_shell_command(action.normalized_payload).invocations
    mutators = tuple(
        invocation
        for invocation in invocations
        if _mutation_targets(invocation, operating_system=action.operating_system)
        or _redirection_targets((*invocation.args, *invocation.redirection_args))
    )
    raw_targets = mutation_target_values(action)
    if len(paths) != len(raw_targets):
        return False
    delete_paths = tuple(
        path
        for path, raw_target in zip(paths, raw_targets, strict=True)
        if re.match(r"^(?:\d+|&)?[<>]", raw_target.strip().strip("\"'`")) is None
    )
    return (
        bool(delete_paths)
        and bool(mutators)
        and all(invocation.canonical_name in _DELETE_COMMANDS for invocation in mutators)
        and all(is_current_windows_temporary_delete_target(path) for path in delete_paths)
    )


def only_writes_current_public_skills(action: RuntimeAction) -> bool:
    """Return whether every recognized shell mutation is a public skill write."""
    paths = mutation_paths(action)
    raw_targets = mutation_target_values(action)
    if not paths or len(paths) != len(raw_targets):
        return False
    invocations = profile_shell_command(action.normalized_payload).invocations
    mutators = tuple(
        invocation
        for invocation in invocations
        if _mutation_targets(invocation, operating_system=action.operating_system)
        or _redirection_targets((*invocation.args, *invocation.redirection_args))
    )
    return (
        bool(mutators)
        and all(invocation.canonical_name in _PUBLIC_SKILL_WRITE_COMMANDS for invocation in mutators)
        and all(_is_literal_target(target) for target in raw_targets)
        and all(is_hexagent_public_skill_descendant(path) for path in paths)
    )


def _is_literal_target(value: str) -> bool:
    normalized = value.strip().strip("\"'`").replace("\\", "/")
    return bool(normalized) and not any(char in normalized for char in "$%*?[]`") and ".." not in normalized.split("/")


def mutation_workspace_scope(action: RuntimeAction) -> WorkspaceScope:
    """Return the lexical workspace scope of explicit shell mutation targets."""
    return _workspace_scope(mutation_paths(action), action.workspace_root)


def resolve_shell_path(raw_path: str, current_dir: str | None) -> str:
    """Resolve one static shell path with the workspace detector's semantics."""
    return _resolve_path(raw_path, current_dir)


def mutation_paths(action: RuntimeAction) -> tuple[str, ...]:
    """Extract and resolve path targets of recognized mutating commands."""
    base_dir = _resolve_path(action.cwd or "", None)
    scope_directories: dict[tuple[int, ...], str] = {(): base_dir}
    scope_stacks: dict[tuple[int, ...], list[str]] = {}
    resolved: list[str] = []

    for raw_target in _powershell_file_api_targets(action.normalized_payload):
        path = _resolve_path(raw_target, base_dir)
        if path and path not in resolved:
            resolved.append(path)

    for invocation in profile_shell_command(action.normalized_payload).invocations:
        command = invocation.canonical_name
        scope = invocation.scope_path
        if scope not in scope_directories:
            scope_directories[scope] = scope_directories.get(scope[:-1], base_dir)
        current_dir = scope_directories[scope]

        if command in {"cd", "chdir", "set-location", "sl"}:
            target = _directory_target(invocation)
            scope_directories[scope] = _resolve_path(target, current_dir) if target else ""
            continue
        if command in {"pushd", "push-location"}:
            target = _directory_target(invocation)
            if not target:
                scope_directories[scope] = ""
                continue
            scope_stacks.setdefault(scope, []).append(current_dir)
            scope_directories[scope] = _resolve_path(target, current_dir)
            continue
        if command in {"popd", "pop-location"}:
            stack = scope_stacks.get(scope, [])
            scope_directories[scope] = stack.pop() if stack else ""
            continue

        raw_targets = (
            *_mutation_targets(invocation, operating_system=action.operating_system),
            *_redirection_targets((*invocation.args, *invocation.redirection_args)),
        )
        for raw_target in raw_targets:
            path = _resolve_path(raw_target, scope_directories[scope])
            if path and path not in resolved:
                resolved.append(path)

    return tuple(resolved)


def mutation_target_values(action: RuntimeAction) -> tuple[str, ...]:
    """Return raw target values of recognized filesystem mutations."""
    targets = list(_powershell_file_api_targets(action.normalized_payload))
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        targets.extend(
            (
                *_mutation_targets(invocation, operating_system=action.operating_system),
                *_redirection_targets((*invocation.args, *invocation.redirection_args)),
            )
        )
    return tuple(dict.fromkeys(target for target in targets if target))


def _directory_target(invocation: CommandInvocation) -> str:
    args = invocation.args
    if invocation.canonical_name in {"set-location", "sl", "push-location"}:
        return _powershell_option_value(args, "-path") or _powershell_option_value(args, "-literalpath") or next(
            (arg for arg in args if not arg.startswith("-")),
            "",
        )
    return next((arg for arg in args if arg.casefold() != "/d" and not arg.startswith("-")), "")


def _mutation_targets(
    invocation: CommandInvocation,
    *,
    operating_system: OperatingSystem | None,
) -> tuple[str, ...]:
    """Return write targets for a recognized mutating invocation."""
    # CMD's bare rmdir shares its name with the Unix executable. Only its known
    # slash switches are options; explicit executables and Unix syntax stay Unix.
    if (
        operating_system == OperatingSystem.WINDOWS
        and invocation.executable.casefold() == "rmdir"
        and any(arg.casefold() in _CMD_RMDIR_SWITCHES for arg in invocation.args)
        and not any(arg.startswith("-") for arg in invocation.args)
    ):
        return tuple(arg for arg in invocation.args if arg.casefold() not in _CMD_RMDIR_SWITCHES)
    for detector in (_unix_mutation_targets, _extended_unix_mutation_targets, _cmd_mutation_targets, _powershell_mutation_targets):
        targets = detector(invocation)
        if targets is not None:
            return targets
    return ()


def _unix_mutation_targets(invocation: CommandInvocation) -> tuple[str, ...] | None:
    command = invocation.canonical_name
    args = invocation.args
    targets: tuple[str, ...] | None = None
    if command in {"rm", "unlink", "rmdir", "mkdir", "mkfifo", "mknod", "shred", "touch", "tee"}:
        targets = _positional_args(args)
    elif command == "truncate":
        targets = _positional_args(args, options_with_values={"-o", "--offset", "-r", "--reference", "-s", "--size"})
    elif command in {"chmod", "chown"}:
        positional = _positional_args(args, options_with_values={"--reference"})
        targets = positional[1:] if len(positional) > 1 else ()
    elif command in {"cp", "install", "ln"}:
        target_dir = _option_value(args, {"-t", "--target-directory"})
        positional = _positional_args(args, options_with_values={"-t", "--target-directory"})
        targets = (target_dir,) if target_dir else positional[-1:]
    elif command == "mv":
        target_dir = _option_value(args, {"-t", "--target-directory"})
        positional = _positional_args(args, options_with_values={"-t", "--target-directory"})
        targets = (*positional, target_dir) if target_dir else positional
    elif command == "sed" and any(arg.casefold() == "--in-place" or arg.casefold().startswith("-i") for arg in args):
        has_explicit_script = any(arg.casefold() in {"-e", "--expression", "-f", "--file"} for arg in args)
        positional = _positional_args(args, options_with_values={"-e", "--expression", "-f", "--file"})
        targets = positional if has_explicit_script else positional[1:]
    elif command == "find" and _find_mutates(args):
        targets = _find_roots(args)
    return targets


def _extended_unix_mutation_targets(invocation: CommandInvocation) -> tuple[str, ...] | None:
    command = invocation.canonical_name
    args = invocation.args
    archive_targets = _archive_mutation_targets(command, args)
    if archive_targets is not None:
        return archive_targets
    targets: tuple[str, ...] | None = None
    if command == "rsync":
        positional = _positional_args(
            args,
            options_with_values={"-e", "--exclude", "--exclude-from", "--include", "--include-from", "--rsh"},
        )
        destination = positional[-1] if len(positional) >= _MIN_COPY_ARGUMENTS else ""
        targets = () if _is_remote_shell_path(destination) else (destination,)
    elif command == "curl":
        destination = _case_sensitive_option_value(args, "-o") or _option_value(args, {"--output"})
        targets = () if destination in {"/dev/null", "NUL", "nul"} else ((destination,) if destination else ())
    elif command == "wget":
        destination = _case_sensitive_option_value(args, "-O") or _option_value(args, {"--output-document"})
        targets = () if destination in {"/dev/null", "NUL", "nul"} else ((destination,) if destination else ())
    elif command == "dd":
        destination = next((arg.partition("=")[2] for arg in args if arg.casefold().startswith("of=") and "=" in arg), "")
        targets = () if destination in {"/dev/null", "NUL", "nul"} else ((destination,) if destination else ())
    elif command == "perl" and any(arg.startswith("-") and "p" in arg[1:] and "i" in arg[1:] for arg in args):
        targets = _positional_args(args, options_with_values={"-e"})
    elif command == "ditto":
        targets = _positional_args(args)[-1:]
    elif command == "patch":
        destination = _option_value(args, {"-d", "--directory"})
        targets = (destination,) if destination else ()
    elif command == "git":
        if _git_subcommand(args) == "clone":
            targets = _git_clone_destination(args)
        elif _git_mutates_worktree(args):
            targets = _git_explicit_worktree_paths(args)
    elif command in {"docker", "nerdctl", "podman"} and tuple(arg.casefold() for arg in args[:1]) == ("cp",):
        positional = _positional_args(args[1:])
        destination = positional[-1] if len(positional) >= _MIN_COPY_ARGUMENTS else ""
        targets = () if _is_remote_shell_path(destination) else ((destination,) if destination else ())
    return targets


def _archive_mutation_targets(command: str, args: tuple[str, ...]) -> tuple[str, ...] | None:
    tar_extracts = command == "tar" and (
        any("x" in arg.casefold().lstrip("-") or arg.casefold() == "--extract" for arg in args if arg.startswith("-"))
        or (bool(args) and re.fullmatch(r"[A-Za-z]*x[A-Za-z]*", args[0]) is not None)
    )
    if tar_extracts:
        return (_option_value(args, {"-c", "--directory"}) or ".",)
    if command == "unzip" and not any(arg.casefold() in {"-l", "-p", "-t", "-v"} for arg in args):
        return (_option_value(args, {"-d"}) or ".",)
    if command == "7z" and tuple(arg.casefold() for arg in args[:1]) in {("x",), ("e",)}:
        destination = next(
            (
                arg[_INLINE_OUTPUT_OPTION_LENGTH:]
                for arg in args
                if arg.casefold().startswith("-o") and len(arg) > _INLINE_OUTPUT_OPTION_LENGTH
            ),
            ".",
        )
        return (destination,)
    return None


def _git_clone_destination(args: tuple[str, ...]) -> tuple[str, ...]:
    """Return only an explicitly supplied clone destination."""
    subcommand_index = _git_subcommand_index(args)
    if subcommand_index is None:
        return ()
    positional = _positional_args(
        args[subcommand_index + 1 :],
        options_with_values={
            "-b",
            "--branch",
            "-c",
            "--config",
            "--depth",
            "--filter",
            "-j",
            "--jobs",
            "-o",
            "--origin",
            "--reference",
            "--reference-if-able",
            "--separate-git-dir",
            "--server-option",
            "-u",
            "--upload-pack",
        },
    )
    return positional[1:2]


def _cmd_mutation_targets(invocation: CommandInvocation) -> tuple[str, ...] | None:
    command = invocation.canonical_name
    args = invocation.args
    targets: tuple[str, ...] | None = None

    if command in {"del", "erase", "rd", "rmdir"}:
        targets = _cmd_positional_args(args)
    elif command in {"copy", "xcopy"}:
        positional = _cmd_positional_args(args)
        targets = positional[-1:]
    elif command == "robocopy":
        positional = _cmd_positional_args(args)
        targets = positional[1:2]
    elif command in {"md", "move", "rename"}:
        targets = _cmd_positional_args(args)
    return targets


def _powershell_mutation_targets(invocation: CommandInvocation) -> tuple[str, ...] | None:
    command = invocation.canonical_name
    args = invocation.args
    targets: tuple[str, ...] | None = None

    if command in {"remove-item", "ri"}:
        targets = _powershell_path_args(args)
    elif command in {"copy-item", "cpi"}:
        destination = _powershell_option_value(args, "-destination")
        positional = _powershell_path_args(args)
        targets = (destination,) if destination else positional[-1:]
    elif command in {
        "add-content",
        "clear-content",
        "export-clixml",
        "export-csv",
        "mi",
        "move-item",
        "new-item",
        "ni",
        "out-file",
        "rename-item",
        "rni",
          "set-acl",
          "set-content",
          "set-item",
          "si",
          "tee-object",
    }:
        targets = _powershell_path_args(args)
    elif command in {"export-certificate", "export-pfxcertificate"}:
        destination = _powershell_option_value(args, "-filepath")
        targets = (destination,) if destination else ()
    elif command in {"save-module", "save-script"}:
        destination = _powershell_option_value(args, "-path")
        targets = (destination,) if destination else ()
    elif command == "icacls":
        targets = _icacls_mutation_targets(args)
    elif command == "takeown":
        target = _cmd_option_value(args, "/f")
        targets = (target,) if target else ()
    return targets


def _powershell_file_api_targets(command: str) -> tuple[str, ...]:
    """Return literal mutation targets from supported System.IO API calls."""
    targets: list[str] = []
    for call in _POWERSHELL_FILE_API_CALL_RE.finditer(command):
        arguments = tuple(
            match.group("single") or match.group("double")
            for match in _POWERSHELL_LITERAL_ARGUMENT_RE.finditer(call.group("arguments"))
        )
        method = call.group("method").casefold()
        if method == "copy":
            selected = arguments[1:2]
        elif method in {"move", "replace"}:
            selected = arguments[:3]
        else:
            selected = arguments[:1]
        targets.extend(selected)
    return tuple(dict.fromkeys(target for target in targets if target))


def _icacls_mutation_targets(args: tuple[str, ...]) -> tuple[str, ...]:
    save_target = _cmd_option_value(args, "/save")
    if save_target:
        return (save_target,)
    mutation_switches = {
        arg.casefold().partition(":")[0]
        for arg in args
        if arg.startswith("/")
    }
    if mutation_switches.isdisjoint(_ICACLS_MUTATION_SWITCHES):
        return ()
    return _cmd_positional_args(args)[:1]


def _positional_args(args: tuple[str, ...], *, options_with_values: set[str] | None = None) -> tuple[str, ...]:
    value_options = options_with_values or set()
    positional: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        option = arg.casefold().partition("=")[0]
        if arg == "--":
            positional.extend(args[index + 1 :])
            break
        if arg.startswith("-"):
            if option in value_options and "=" not in arg:
                index += 1
            index += 1
            continue
        positional.append(arg)
        index += 1
    return tuple(positional)


def _option_value(args: tuple[str, ...], options: set[str]) -> str:
    for index, arg in enumerate(args):
        option, separator, inline = arg.casefold().partition("=")
        if option not in options:
            continue
        if separator:
            return arg.partition("=")[2]
        return args[index + 1] if index + 1 < len(args) else ""
    return ""


def _cmd_positional_args(args: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(arg for arg in args if not _is_cmd_switch(arg))


def _is_cmd_switch(arg: str) -> bool:
    option = arg.casefold()
    return option in _CMD_SWITCHES or option.startswith(_CMD_SWITCH_PREFIXES)


def _cmd_option_value(args: tuple[str, ...], expected: str) -> str:
    for index, arg in enumerate(args):
        option, separator, inline = arg.casefold().partition(":")
        if option != expected:
            continue
        if separator:
            return arg.partition(":")[2]
        return args[index + 1] if index + 1 < len(args) else ""
    return ""


def _powershell_path_args(args: tuple[str, ...]) -> tuple[str, ...]:
    paths: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        option, inline = _powershell_option(arg)
        if option in _POWERSHELL_PATH_OPTIONS:
            if inline:
                paths.append(inline)
            elif index + 1 < len(args):
                index += 1
                paths.append(args[index])
        elif option in _POWERSHELL_VALUE_OPTIONS and not inline:
            index += 1
        elif not arg.startswith("-"):
            paths.append(arg)
        index += 1
    return tuple(paths)


def _powershell_option_value(args: tuple[str, ...], expected: str) -> str:
    for index, arg in enumerate(args):
        option, inline = _powershell_option(arg)
        if option != expected:
            continue
        if inline:
            return inline
        return args[index + 1] if index + 1 < len(args) else ""
    return ""


def _powershell_option(arg: str) -> tuple[str, str]:
    for separator in (":", "="):
        if separator in arg:
            option, _, value = arg.partition(separator)
            return option.casefold(), value
    return arg.casefold(), ""


def _redirection_targets(args: tuple[str, ...]) -> tuple[str, ...]:
    targets: list[str] = []
    index = 0
    while index < len(args):
        match = _REDIRECT_RE.match(args[index])
        if match is None:
            index += 1
            continue
        target = match.group("target")
        if not target and index + 1 < len(args):
            index += 1
            target = args[index]
        if target and not target.startswith("&") and not _is_null_redirection_target(target):
            targets.append(target)
        index += 1
    return tuple(targets)


def _is_null_redirection_target(target: str) -> bool:
    """Return whether a redirect target is the platform's null device."""
    normalized = target.strip().strip("\"'`").rstrip(";,|&").replace("\\", "/").casefold()
    return normalized in {"/dev/null", "nul"}


def _find_mutates(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if "-delete" in lowered:
        return True
    return any(arg in {"rm", "shred"} for arg in lowered) and any(arg in {"-exec", "-execdir"} for arg in lowered)


def _find_roots(args: tuple[str, ...]) -> tuple[str, ...]:
    roots: list[str] = []
    for arg in args:
        if arg.startswith("-") or arg in {"!", "("}:
            break
        roots.append(arg)
    return tuple(roots) or (".",)


def _resolve_path(raw_path: str, current_dir: str | None) -> str:
    path = raw_path.strip().strip("\"'`").rstrip(";,|&")
    if not path or path == "-" or path.startswith("~") or _is_dynamic(path):
        return ""
    normalized = path.replace("\\", "/")
    if normalized.casefold().startswith("//?/unc/"):
        normalized = "//" + normalized[len("//?/unc/") :]
    elif re.match(r"^//\?/[A-Za-z]:/", normalized):
        normalized = normalized[4:]
    if not _is_absolute(normalized):
        if not current_dir:
            return ""
        normalized = f"{current_dir.rstrip('/')}/{normalized}"
    resolved = posixpath.normpath(normalized)
    return resolved.casefold() if _is_windows_path(resolved) else resolved


def _is_dynamic(path: str) -> bool:
    return "$(" in path or "`" in path or "$" in path or re.search(r"%[^%]+%", path) is not None


def _is_absolute(path: str) -> bool:
    return path.startswith(("/", "//")) or _WINDOWS_ABSOLUTE_RE.match(path) is not None


def _is_windows_path(path: str) -> bool:
    return _WINDOWS_ABSOLUTE_RE.match(path) is not None or path.startswith("//")


def _is_remote_shell_path(value: str) -> bool:
    if _WINDOWS_ABSOLUTE_RE.match(value):
        return False
    return re.fullmatch(r"(?:[^@\s:]+@)?[A-Za-z0-9_.-]+:.+", value) is not None


def _git_mutates_worktree(args: tuple[str, ...]) -> bool:
    return _git_subcommand(args) in {
        "add",
        "branch",
        "checkout",
        "cherry-pick",
        "clean",
        "commit",
        "merge",
        "rebase",
        "reset",
        "restore",
        "revert",
        "stash",
        "switch",
        "tag",
    }


def _git_subcommand(args: tuple[str, ...]) -> str:
    index = _git_subcommand_index(args)
    return args[index].casefold() if index is not None else ""


def _git_subcommand_index(args: tuple[str, ...]) -> int | None:
    index = 0
    while index < len(args):
        option = args[index].casefold().partition("=")[0]
        if option in {"-c", "-C", "--git-dir", "--work-tree"}:
            index += 1 if "=" in args[index] else 2
            continue
        if args[index].startswith("-"):
            index += 1
            continue
        return index
    return None


def _git_explicit_worktree_paths(args: tuple[str, ...]) -> tuple[str, ...]:
    paths: list[str] = []
    for option in ("-C", "--git-dir", "--work-tree"):
        value = _case_sensitive_option_value(args, option)
        if value:
            paths.append(value)
    return tuple(paths)


def _case_sensitive_option_value(args: tuple[str, ...], expected: str) -> str:
    for index, arg in enumerate(args):
        option, separator, value = arg.partition("=")
        if option != expected:
            continue
        if separator:
            return value
        return args[index + 1] if index + 1 < len(args) else ""
    return ""


def _workspace_scope(paths: tuple[str, ...], cwd: str | None) -> WorkspaceScope:
    if not paths or not cwd:
        return WorkspaceScope.UNKNOWN
    inside = tuple(_is_inside_workspace(path, cwd) for path in paths)
    if all(inside):
        return WorkspaceScope.INSIDE
    if any(inside):
        return WorkspaceScope.MIXED
    return WorkspaceScope.OUTSIDE


def _is_inside_workspace(path: str, cwd: str | None) -> bool:
    workspace = _resolve_path(cwd or "", None)
    if not workspace:
        return False
    prefix = workspace.rstrip("/") + "/"
    return path == workspace or path.startswith(prefix)
