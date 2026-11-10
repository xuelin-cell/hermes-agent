"""Small shell text helpers shared by guardrail components."""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from functools import lru_cache

_MAX_NESTED_SHELL_DEPTH = 3
_NESTED_SHELL_RE = re.compile(
    r"(?:^|&&|\|\||[;&|\n(])\s*"
    r"(?:sudo\s+)?"
    r"(?:cmd(?:\.exe)?\s+/[ck]|(?:ba|z|k)?sh\s+-[a-z]*c[a-z]*|"
    r"(?:powershell|pwsh)(?:\.exe)?(?:\s+-[^\s]+)*\s+-(?:command|c))"
    r"\s*(?P<quote>['\"])(?P<payload>.*?)(?P=quote)",
    re.IGNORECASE | re.DOTALL,
)
_UNQUOTED_NESTED_SHELL_RE = re.compile(
    r"(?:^|&&|\|\||[;&|\n(])\s*"
    r"(?:sudo\s+)?"
    r"(?:cmd(?:\.exe)?\s+/[ck]|(?:powershell|pwsh)(?:\.exe)?(?:\s+-[^\s]+)*\s+-(?:command|c))"
    r"\s+(?!['\"])(?P<payload>[^;&|\n]+)",
    re.IGNORECASE,
)
_POWERSHELL_START_PROCESS_RE = re.compile(
    r"(?:^|[;&|\n(=])\s*(?:Start-Process|saps)\b(?P<args>[^;&|\n]*)",
    re.IGNORECASE,
)
_PYTHON_SQLMAP_RE = re.compile(
    r"(?:^|[;&|\n(])\s*(?:python(?:3)?|py)(?:\.exe)?\b(?P<args>[^;&|\n]*)",
    re.IGNORECASE,
)
_START_PROCESS_VALUE_OPTIONS = frozenset(
    {
        "-argumentlist",
        "-credential",
        "-filepath",
        "-redirectstandarderror",
        "-redirectstandardinput",
        "-redirectstandardoutput",
        "-verb",
        "-windowstyle",
        "-workingdirectory",
    }
)
_START_PROCESS_SWITCH_OPTIONS = frozenset({"-loaduserprofile", "-nonewwindow", "-passthru", "-usenewenvironment", "-wait"})
_PYTHON_OPTIONS_WITH_VALUE = frozenset({"-c", "-m"})


@dataclass(frozen=True)
class ShellTextAnalysis:
    """Executable and quoted-literal views of a shell payload."""

    executable_text: str
    top_level_executable_text: str
    nested_commands: tuple[str, ...]
    quoted_literals: tuple[str, ...]


@lru_cache(maxsize=512)
def analyze_shell_text(command: str) -> ShellTextAnalysis:
    """Mask ordinary quoted text while preserving executable substitutions."""
    return _analyze_shell_text(command, depth=0)


def _analyze_shell_text(command: str, *, depth: int) -> ShellTextAnalysis:
    output = list(command)
    quoted_literals: list[str] = []
    _mask_quoted_ranges(command, 0, len(command), output, quoted_literals)
    top_level_executable_text = "".join(output)
    executable_text = top_level_executable_text
    nested_commands: list[str] = []

    # A quoted argument is normally data, except when it is the payload of an
    # explicit shell launcher such as cmd /c, bash -c, or PowerShell -Command.
    # Append those payloads as executable regions so all baseline detectors see
    # them without treating echo/grep text as commands.
    if depth < _MAX_NESTED_SHELL_DEPTH:
        nested_regions: list[str] = []
        for match in _NESTED_SHELL_RE.finditer(command):
            launcher_start = match.start()
            launcher_end = match.start("payload")
            if not top_level_executable_text[launcher_start:launcher_end].strip():
                continue
            payload = match.group("payload")
            nested = _analyze_shell_text(payload, depth=depth + 1)
            nested_commands.append(payload)
            nested_commands.extend(nested.nested_commands)
            if nested.executable_text.strip():
                nested_regions.append(nested.executable_text)
            quoted_literals.extend(nested.quoted_literals)
        for match in _UNQUOTED_NESTED_SHELL_RE.finditer(command):
            launcher_start = match.start()
            launcher_end = match.start("payload")
            if not top_level_executable_text[launcher_start:launcher_end].strip():
                continue
            payload = match.group("payload").strip()
            nested = _analyze_shell_text(payload, depth=depth + 1)
            nested_commands.append(payload)
            nested_commands.extend(nested.nested_commands)
            if nested.executable_text.strip():
                nested_regions.append(nested.executable_text)
            quoted_literals.extend(nested.quoted_literals)
        for payload in _wrapper_payloads(command, top_level_executable_text):
            nested = _analyze_shell_text(payload, depth=depth + 1)
            nested_commands.append(payload)
            nested_commands.extend(nested.nested_commands)
            if nested.executable_text.strip():
                nested_regions.append(nested.executable_text)
            quoted_literals.extend(nested.quoted_literals)
        if nested_regions:
            executable_text = "\n".join((executable_text, *nested_regions))

    return ShellTextAnalysis(
        executable_text=executable_text,
        top_level_executable_text=top_level_executable_text,
        nested_commands=tuple(nested_commands),
        quoted_literals=tuple(literal for literal in quoted_literals if literal),
    )


def _wrapper_payloads(command: str, executable_text: str) -> tuple[str, ...]:
    """Return executable payloads hidden behind common process wrappers."""
    payloads: list[str] = []
    for match in _POWERSHELL_START_PROCESS_RE.finditer(command):
        if not executable_text[match.start() : match.start("args")].strip():
            continue
        payload = _start_process_payload(match.group("args"))
        if payload:
            payloads.append(payload)
    for match in _PYTHON_SQLMAP_RE.finditer(command):
        if not executable_text[match.start() : match.start("args")].strip():
            continue
        payload = _python_sqlmap_payload(match.group("args"))
        if payload:
            payloads.append(payload)
    return tuple(dict.fromkeys(payloads))


def _start_process_payload(raw_args: str) -> str:
    tokens = _split_wrapper_args(raw_args)
    if not tokens:
        return ""

    executable = ""
    argument_tokens: list[str] = []
    index = 0
    while index < len(tokens):
        token = _strip_wrapper_token(tokens[index])
        option = token.casefold().partition(":")[0].partition("=")[0]
        if option in _START_PROCESS_SWITCH_OPTIONS:
            index += 1
            continue
        if option in _START_PROCESS_VALUE_OPTIONS:
            inline = token.partition(":")[2] or token.partition("=")[2]
            value = inline
            if not value and index + 1 < len(tokens):
                index += 1
                value = _strip_wrapper_token(tokens[index])
            if option == "-filepath":
                executable = value
            elif option == "-argumentlist":
                argument_tokens.extend(_split_argument_list(value))
            index += 1
            continue
        if token.startswith("-"):
            index += 1
            continue
        if not executable:
            executable = token
        index += 1

    if not executable:
        return ""
    return " ".join((executable, *argument_tokens)).strip()


def _python_sqlmap_payload(raw_args: str) -> str:
    tokens = [_strip_wrapper_token(token) for token in _split_wrapper_args(raw_args)]
    index = 0
    while index < len(tokens):
        token = tokens[index]
        option = token.casefold()
        if option == "-m" and index + 1 < len(tokens):
            module = tokens[index + 1].casefold()
            if module == "sqlmap" or module.endswith(".sqlmap"):
                return " ".join(("sqlmap", *tokens[index + 2 :])).strip()
            return ""
        if option in _PYTHON_OPTIONS_WITH_VALUE:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        normalized = token.replace("\\", "/").casefold()
        if normalized.endswith("/sqlmap.py") or normalized == "sqlmap.py":
            return " ".join(("sqlmap", *tokens[index + 1 :])).strip()
        return ""
    return ""


def _split_wrapper_args(value: str) -> list[str]:
    try:
        return shlex.split(value, posix=False)
    except ValueError:
        return value.split()


def _split_argument_list(value: str) -> list[str]:
    cleaned = _strip_wrapper_token(value)
    if not cleaned:
        return []
    try:
        return [_strip_wrapper_token(token) for token in shlex.split(cleaned, posix=False)]
    except ValueError:
        return cleaned.split()


def _strip_wrapper_token(value: str) -> str:
    return value.strip().strip("\"'`").strip().rstrip(",")


def _mask_quoted_ranges(
    text: str,
    start: int,
    end: int,
    output: list[str],
    quoted_literals: list[str],
) -> None:
    index = start
    while index < end:
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'":
            index = _mask_single_quote(text, index, end, output, quoted_literals)
            continue
        if char == '"':
            index = _mask_double_quote(text, index, end, output, quoted_literals)
            continue
        if char == "$" and index + 1 < end and text[index + 1] == "(":
            close = _find_command_substitution_end(text, index + 1, end)
            if close is None:
                index += 2
                continue
            _mask_quoted_ranges(text, index + 2, close, output, quoted_literals)
            index = close + 1
            continue
        if char == "`":
            close = _find_unescaped_backtick(text, index + 1, end)
            if close is None:
                index += 1
                continue
            _mask_quoted_ranges(text, index + 1, close, output, quoted_literals)
            index = close + 1
            continue
        index += 1


def _mask_single_quote(
    text: str,
    start: int,
    end: int,
    output: list[str],
    quoted_literals: list[str],
) -> int:
    close = text.find("'", start + 1, end)
    stop = close + 1 if close != -1 else end
    quoted_literals.append(text[start + 1 : close if close != -1 else end])
    for index in range(start, stop):
        output[index] = " "
    return stop


def _mask_double_quote(
    text: str,
    start: int,
    end: int,
    output: list[str],
    quoted_literals: list[str],
) -> int:
    output[start] = " "
    literal_chars: list[str] = []
    index = start + 1
    while index < end:
        char = text[index]
        if char == "\\":
            output[index] = " "
            if index + 1 < end:
                literal_chars.append(text[index + 1])
                output[index + 1] = " "
            index += 2
            continue
        if char == '"':
            output[index] = " "
            _flush_literal(literal_chars, quoted_literals)
            return index + 1
        if char == "$" and index + 1 < end and text[index + 1] == "(":
            _flush_literal(literal_chars, quoted_literals)
            close = _find_command_substitution_end(text, index + 1, end)
            if close is None:
                output[index] = " "
                index += 1
                continue
            _mask_quoted_ranges(text, index + 2, close, output, quoted_literals)
            index = close + 1
            continue
        if char == "`":
            _flush_literal(literal_chars, quoted_literals)
            close = _find_unescaped_backtick(text, index + 1, end)
            if close is None:
                output[index] = " "
                index += 1
                continue
            _mask_quoted_ranges(text, index + 1, close, output, quoted_literals)
            index = close + 1
            continue
        literal_chars.append(char)
        output[index] = " "
        index += 1
    _flush_literal(literal_chars, quoted_literals)
    return end


def _flush_literal(literal_chars: list[str], quoted_literals: list[str]) -> None:
    if literal_chars:
        quoted_literals.append("".join(literal_chars))
        literal_chars.clear()


def _find_command_substitution_end(text: str, open_paren: int, end: int) -> int | None:
    depth = 1
    quote = ""
    index = open_paren + 1
    while index < end:
        char = text[index]
        if quote:
            if char == "\\" and quote != "'":
                index += 2
                continue
            if char == quote:
                quote = ""
            index += 1
            continue
        if char == "\\":
            index += 2
            continue
        if char in {"'", '"', "`"}:
            quote = char
            index += 1
            continue
        if char == "$" and index + 1 < end and text[index + 1] == "(":
            depth += 1
            index += 2
            continue
        if char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _find_unescaped_backtick(text: str, start: int, end: int) -> int | None:
    escaped = False
    for index in range(start, end):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "`":
            return index
    return None
