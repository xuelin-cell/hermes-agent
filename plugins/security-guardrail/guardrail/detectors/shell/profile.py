"""Shell command profiling for deterministic command policies."""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from ...shell_syntax import analyze_shell_text

Confidence = Literal["exact", "fallback"]


@dataclass(frozen=True)
class CommandInvocation:
    """One executable command, with raw args and a redirect-free argv view."""

    executable: str
    canonical_name: str
    args: tuple[str, ...]
    command_args: tuple[str, ...]
    raw_segment: str
    confidence: Confidence
    scope_path: tuple[int, ...] = ()
    redirection_args: tuple[str, ...] = ()


@dataclass(frozen=True)
class ShellCommandProfile:
    """Executable invocations found in a shell payload."""

    invocations: tuple[CommandInvocation, ...]


def is_help_or_version_only_invocation(invocation: CommandInvocation) -> bool:
    """Return whether an invocation only asks for non-executing help metadata."""
    if not invocation.args:
        return False
    safe_args = {"-?", "-h", "--help", "--version", "/?", "/h", "/help", "help", "version"}
    return all(arg.casefold() in safe_args for arg in invocation.args)


_ASSIGNMENT_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()]*\s+)*"
_COMMAND_START_RE = re.compile(
    r"(?:^|&&|\|\||[;&|\n()]|\$\()\s*"
    + _ASSIGNMENT_PREFIX
    + r"(?:sudo\s+(?:-[^\s]+\s+)*)?"
    + _ASSIGNMENT_PREFIX
    + r"(?:env\s+(?:-[^\s]+\s+)*(?:\w+=\S*\s+)*)?"
    + r"(?:(?:exec|nohup|setsid|time|command)\s+)*"
    + r"(?P<cmd>[A-Za-z0-9_./:\\+@-]+)(?=$|\s|&&|\|\||[;&|\n()])",
    re.IGNORECASE,
)
_QUOTED_CALL_OPERATOR_RE = re.compile(r"&\s*(?P<cmd>(?P<quote>['\"])[^'\"\r\n]+(?P=quote))")
_SEGMENT_END_RE = re.compile(r"&&|\|\||[;&|\n()]")
_REDIRECTION_RE = re.compile(r"(?:(?<!\S)\d+|&)?(?:>>?|(?<!<)<(?!<))(?:[&|])?")
_SHELL_WORD_RE = re.compile(r"""(?:[^\s;&|()<>'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*")+""")
_WINDOWS_EXECUTABLE_SUFFIX_RE = re.compile(r"\.(?:exe|com|bat|cmd|ps1)$", re.IGNORECASE)
_POWERSHELL_LAUNCHERS = frozenset({"powershell", "pwsh"})
_POWERSHELL_COMMAND_OPTIONS = frozenset({"-c", "-command", "-encodedcommand", "-enc"})
_POWERSHELL_FILE_OPTIONS = frozenset({"-f", "-file"})
_POWERSHELL_FLAGS = frozenset(
    {
        "-login",
        "-mta",
        "-nologo",
        "-noninteractive",
        "-noprofile",
        "-noexit",
        "-sta",
    },
)
_POWERSHELL_OPTIONS_WITH_VALUE = frozenset(
    {
        "-configurationname",
        "-custompipename",
        "-executionpolicy",
        "-inputformat",
        "-outputformat",
        "-version",
        "-windowstyle",
        "-workingdirectory",
    },
)
_SHELL_KEYWORDS = frozenset(
    {
        "case",
        "do",
        "done",
        "else",
        "elif",
        "esac",
        "fi",
        "for",
        "function",
        "if",
        "in",
        "then",
        "until",
        "while",
    }
)


@lru_cache(maxsize=512)
def profile_shell_command(
    command: str,
) -> ShellCommandProfile:
    """Build a syntax-backed profile for a shell command string."""
    return ShellCommandProfile(invocations=tuple(_iter_invocations(command)))


def normalize_executable_name(executable: str) -> str:
    """Normalize a raw executable token to a command-policy lookup key."""
    value = executable.strip().strip("\"'`")
    if not value:
        return ""
    value = value.replace("\\", "/").rstrip("/")
    if "/" in value:
        value = value.rsplit("/", 1)[-1]
    return _WINDOWS_EXECUTABLE_SUFFIX_RE.sub("", value).casefold()


def _iter_invocations(
    command: str,
) -> list[CommandInvocation]:
    invocations: list[CommandInvocation] = []
    seen: set[tuple[int, int, str]] = set()
    for region_index, (raw_region, executable_region) in enumerate(_executable_regions(command)):
        redirects = _redirection_spans(raw_region, executable_region)
        command_region = _mask_spans(raw_region, redirects)
        masked_region = _mask_spans(executable_region, redirects)
        # Escaped operators are word contents, not command boundaries.
        masked_region = re.sub(r"\\(.)", lambda match: "\\_" if match[1] in ";&|()<>" else match[0], masked_region)
        # PowerShell's & 'path with spaces' invokes a program, not a string literal.
        # Keep the token's offsets while making it visible to command-position matching.
        for quoted in _QUOTED_CALL_OPERATOR_RE.finditer(command_region):
            if masked_region[quoted.start()] == "&" and not any(marker in quoted.group("cmd") for marker in ("$", "`")):
                start, end = quoted.span("cmd")
                masked_region = masked_region[:start] + "_" * (end - start) + masked_region[end:]
        for match in _COMMAND_START_RE.finditer(masked_region):
            executable = raw_region[match.start("cmd") : match.end("cmd")]
            normalized = normalize_executable_name(executable)
            if not normalized or normalized in _SHELL_KEYWORDS or "=" in executable:
                continue

            key = (region_index, match.start("cmd"), normalized)
            if key in seen:
                continue
            seen.add(key)

            segment = _raw_segment(raw_region, masked_region, match.start("cmd"))
            args = _segment_args(segment)
            segment_end = match.start("cmd") + len(segment)
            scope = _scope_path(masked_region, match.start("cmd"))
            invocations.append(
                CommandInvocation(
                    executable=executable,
                    canonical_name=normalized,
                    args=args,
                    command_args=_segment_args(_raw_segment(command_region, masked_region, match.start("cmd"))),
                    raw_segment=segment,
                    confidence="exact",
                    scope_path=scope,
                    redirection_args=_redirection_args(
                        raw_region,
                        tuple(
                            (start, end)
                            for start, end in redirects
                            if match.start() <= start and end <= segment_end and _scope_path(masked_region, start) == scope
                        ),
                    ),
                ),
            )
    invocations.extend(_powershell_implicit_invocations(invocations))
    return invocations


def _redirection_spans(command: str, executable_text: str) -> tuple[tuple[int, int], ...]:
    """Locate static redirects without interpreting quoted/escaped operators.

    Dynamic operands and here-documents stay visible for conservative analysis;
    in particular, command substitutions must not disappear from the profile.
    """
    spans: list[tuple[int, int]] = []
    for match in _REDIRECTION_RE.finditer(executable_text):
        start = match.start()
        if spans and start < spans[-1][1]:
            continue
        preceding = command[:start]
        if (len(preceding) - len(preceding.rstrip("\\"))) % 2:
            continue
        operand_start = match.end()
        while operand_start < len(command) and command[operand_start] in " \t":
            operand_start += 1
        operand = _SHELL_WORD_RE.match(command, operand_start)
        if operand is None or any(marker in operand.group() for marker in ("$", "`")):
            continue
        spans.append((start, operand.end()))
    return tuple(spans)


def _mask_spans(text: str, spans: tuple[tuple[int, int], ...]) -> str:
    masked = list(text)
    for start, end in spans:
        masked[start:end] = " " * (end - start)
    return "".join(masked)


def _redirection_args(command: str, spans: tuple[tuple[int, int], ...]) -> tuple[str, ...]:
    """Keep write targets separate from argv, including leading/attached redirects."""
    args: list[str] = []
    for start, end in spans:
        operator = _REDIRECTION_RE.match(command, start)
        if operator is not None:
            args.extend((operator.group(), command[operator.end() : end].strip().strip("\"'")))
    return tuple(args)


def _executable_regions(command: str) -> tuple[tuple[str, str], ...]:
    analysis = analyze_shell_text(command)
    regions = [(command, analysis.top_level_executable_text)]
    for nested_command in analysis.nested_commands:
        nested = analyze_shell_text(nested_command)
        regions.append((nested_command, nested.top_level_executable_text))
    return tuple(regions)


def _raw_segment(command: str, executable_text: str, start: int) -> str:
    # A substitution's separators belong to the nested command, not its caller.
    # Keep the outer suffix (including redirects) while still profiling children.
    depth = 0
    end = len(command)
    for match in _SEGMENT_END_RE.finditer(executable_text, start):
        separator = match.group()
        if separator == "(":
            depth += 1
        elif separator == ")" and depth:
            depth -= 1
        elif not depth:
            end = match.start()
            break
    return command[start:end].strip()


def _segment_args(segment: str) -> tuple[str, ...]:
    try:
        parts = shlex.split(segment, posix="\\" not in segment)
    except ValueError:
        parts = segment.split()
    return tuple(parts[1:]) if len(parts) > 1 else ()


def _scope_path(command: str, end: int) -> tuple[int, ...]:
    """Return unmatched parenthesis offsets surrounding one invocation."""
    stack: list[int] = []
    for index, char in enumerate(command[:end]):
        if char == "(":
            stack.append(index)
        elif char == ")" and stack:
            stack.pop()
    return tuple(stack)


def _powershell_implicit_invocations(
    invocations: list[CommandInvocation],
) -> list[CommandInvocation]:
    """Expose cmdlets passed to PowerShell without an explicit ``-Command``."""
    nested: list[CommandInvocation] = []
    for invocation in invocations:
        if invocation.canonical_name not in _POWERSHELL_LAUNCHERS:
            continue
        implicit = _powershell_implicit_invocation(invocation)
        if implicit is not None:
            nested.append(implicit)
    return nested


def _powershell_implicit_invocation(
    parent: CommandInvocation,
) -> CommandInvocation | None:
    """Parse ``powershell Cmdlet ...`` while excluding file/encoded payloads."""
    args = parent.args
    index = 0
    while index < len(args):
        raw_option = args[index]
        option = raw_option.casefold().partition(":")[0].partition("=")[0]
        if option in _POWERSHELL_COMMAND_OPTIONS or option in _POWERSHELL_FILE_OPTIONS:
            return None
        if option in _POWERSHELL_FLAGS:
            index += 1
            continue
        if option in _POWERSHELL_OPTIONS_WITH_VALUE:
            index += 1 if ":" in raw_option or "=" in raw_option else 2
            continue
        if raw_option.startswith("-"):
            return None
        break

    if index >= len(args):
        return None

    executable = args[index]
    if executable.casefold().endswith(".ps1") or "/" in executable or "\\" in executable:
        return None
    canonical_name = normalize_executable_name(executable)
    if not canonical_name or canonical_name in _SHELL_KEYWORDS:
        return None

    return CommandInvocation(
        executable=executable,
        canonical_name=canonical_name,
        args=args[index + 1 :],
        command_args=parent.command_args[index + 1 :],
        raw_segment=" ".join(args[index:]),
        confidence="fallback",
        scope_path=parent.scope_path,
        redirection_args=parent.redirection_args,
    )
