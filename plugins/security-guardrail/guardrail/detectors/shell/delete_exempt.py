"""Narrow ASK exemptions for Lite Windows session-data deletion."""

from __future__ import annotations

from ...runtime import execution_environment

import re
from typing import TYPE_CHECKING

from ...action import ToolType
from .profile import profile_shell_command
from .workspace import mutation_paths, mutation_target_values
from ...normalizer import normalize_runtime_action
from ...path_policy import (
    WINDOWS_PRODUCT_DATA_DIR_PATTERN,
    WINDOWS_PRODUCT_DATA_DIRS,
    paths_are_at_or_below_windows_user_sessions,
)
from ...shell_syntax import analyze_shell_text
from ...types import BuildProfile, OperatingSystem

if TYPE_CHECKING:
    from ...action import RuntimeAction
    from .profile import CommandInvocation

_DELETE_COMMANDS = frozenset({"del", "erase", "rd", "remove-item", "ri", "rm", "rmdir", "shred", "unlink"})
_DIRECTORY_COMMANDS = frozenset({"cd", "chdir", "popd", "pop-location", "pushd", "push-location", "set-location", "sl"})
_SIMPLE_COMMAND_RE = re.compile(
    r"^\s*(?:" + "|".join(sorted(_DELETE_COMMANDS | _DIRECTORY_COMMANDS | {"echo"})) + r")(?:\.exe)?(?=\s|$)",
    re.IGNORECASE,
)
_QUOTED_WORD_RE = re.compile(r"""'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]+""")
_APPDATA_SESSION_WORD_RE = re.compile(
    rf'"\$(?:APPDATA|\{{APPDATA\}})'
    rf'(?P<suffix>/{WINDOWS_PRODUCT_DATA_DIR_PATTERN}/sessions(?:/[^"\\$`%\r\n]*)?)"'
)


def resolve_lite_windows_sessions_delete(action: RuntimeAction, *, appdata_root: str | None) -> RuntimeAction:
    """Build a check-only action for narrowly supported Bash APPDATA deletes.

    The caller supplies the execution environment snapshot. Original tool input
    is never mutated, and an unsupported command retains its original action.
    """
    if not execution_environment().product_exemptions:
        return action
    if (
        action.canonical_tool_name != "Bash"
        or action.profile != BuildProfile.LITE
        or action.operating_system != OperatingSystem.WINDOWS
        or "$" not in action.normalized_payload
    ):
        return action
    root = (appdata_root or "").replace("\\", "/").rstrip("/")
    if any(char in root for char in "\"'$`%\r\n"):
        return action
    candidate_session_roots = tuple(f"{root}/{product}/sessions" for product in WINDOWS_PRODUCT_DATA_DIRS)
    if not paths_are_at_or_below_windows_user_sessions(candidate_session_roots):
        return action

    command = action.normalized_payload
    # Do not resolve variables in status output, directory changes or wrappers.
    if any(invocation.executable != "rm" and "$" in invocation.raw_segment for invocation in profile_shell_command(command).invocations):
        return action

    def expand_word(match: re.Match[str]) -> str:
        word = match.group()
        target = _APPDATA_SESSION_WORD_RE.fullmatch(word)
        if (
            target is None
            or (match.start() > 0 and not command[match.start() - 1].isspace())
            or (match.end() < len(command) and not command[match.end()].isspace())
        ):
            return word
        return f'"{root}{target.group("suffix")}"'

    expanded = _QUOTED_WORD_RE.sub(expand_word, command)
    if expanded == command:
        return action
    inspection_action = normalize_runtime_action(
        tool_call_id=action.tool_call_id,
        tool_name=action.tool_name,
        tool_input={**action.tool_input, "command": expanded},
        cwd=action.cwd,
        origin=action.origin,
        profile=action.profile,
        mode=action.mode,
        operating_system=action.operating_system,
        app_dir=action.app_dir,
        app_dir_exclusions=action.app_dir_exclusions,
        workspace_root=action.workspace_root,
    )
    return inspection_action if is_lite_windows_sessions_delete_exempt(inspection_action) else action


def is_lite_windows_sessions_delete_exempt(action: RuntimeAction) -> bool:
    """Return whether a shell call only deletes Lite-managed session data."""
    if not execution_environment().product_exemptions:
        return False
    if (
        action.tool_type != ToolType.SHELL
        or action.profile != BuildProfile.LITE
        or action.operating_system != OperatingSystem.WINDOWS
    ):
        return False

    command = action.normalized_payload
    analysis = analyze_shell_text(command)
    # Profiles are best-effort: a standalone redirect or a wrapper can disappear
    # from argv. Only grant exemptions to simple, literal command sequences.
    if analysis.nested_commands or any(marker in command for marker in ("$", "%", "`")):
        return False
    text = analysis.top_level_executable_text
    if re.search(r"[<>()[\]{}#]|(?<!&)&(?!&)|(?<!\|)\|(?!\|)", text):
        return False
    if any(
        not _SIMPLE_COMMAND_RE.match(segment)
        for segment in re.split(r"&&|\|\||[;\n]", text)
        if segment.strip()
    ):
        return False

    invocations = profile_shell_command(command).invocations
    operations = tuple(
        invocation for invocation in invocations if invocation.canonical_name not in _DIRECTORY_COMMANDS and not _is_literal_echo(invocation)
    )
    if (
        not operations
        or any(invocation.canonical_name not in _DELETE_COMMANDS for invocation in operations)
        or any(invocation.redirection_args for invocation in invocations)
    ):
        return False

    paths = mutation_paths(action)
    raw_targets = mutation_target_values(action)
    # Wildcards are expanded before '..'; lexical normalization alone cannot
    # establish containment for that combination.
    return (
        bool(raw_targets)
        and len(paths) == len(raw_targets)
        and not any(
            ".." in target.replace("\\", "/").split("/") and any(char in target for char in "*?[")
            for target in raw_targets
        )
        and paths_are_at_or_below_windows_user_sessions(paths)
    )


def _is_literal_echo(invocation: CommandInvocation) -> bool:
    return (
        invocation.executable == "echo"
        and not invocation.redirection_args
        and not any(marker in invocation.raw_segment for marker in ("$", "%", "`"))
    )
