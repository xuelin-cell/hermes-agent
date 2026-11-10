"""Normalize raw tool calls into :class:`RuntimeAction`.

The normalizer is intentionally deterministic and side-effect free: it does
not read files, resolve symlinks, call models, or decide allow/deny.
"""

from __future__ import annotations

import posixpath
import re
import shlex
from typing import TYPE_CHECKING, Any

from .action import RuntimeAction, RuntimeOperation, TargetKind, ToolType, WorkspaceScope
from .path_policy import is_sensitive_path_candidate
from .shell_syntax import analyze_shell_text
from .tool_schema import (
    CANONICAL_TOOL_CLASSIFICATION,
    TOOL_ACTION_OPERATION_OVERRIDES,
    TOOL_NAME_TO_CANONICAL,
    TOOL_TARGET_KEYS,
    URL_TARGET_KEYS,
    URL_TARGET_TOOL_NAME_TO_CANONICAL,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from .types import BuildProfile, OperatingSystem, PermissionMode, ToolCallOrigin

INHERIT_CWD = object()

_SHELL_TOOLS = frozenset({"Bash", "PowerShell"})
_WRITE_PATH_TOOLS = frozenset({"Write", "Edit", "NotebookEdit", "FileWrite", "FileEdit"})
_READ_PATH_TOOLS = frozenset({"Read", "PresentToUser", "PptxProgress"})
_NETWORK_TOOLS = frozenset({"WebBatchFetch", "WebCrawl", "WebFetch", "WebSearch"})
_WINDOWS_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:[\\/]")
_WINDOWS_DRIVE_ROOT_RE = re.compile(r"^[A-Za-z]:/$")
_WINDOWS_PATHLESS_SWITCHES = frozenset({"/a", "/b", "/c", "/i", "/k", "/l", "/n", "/q", "/r", "/s", "/v", "/x"})
_WINDOWS_COMMAND_SYNTAX_RE = re.compile(
    r"(?:^|&&|\|\||[;&|\n(])\s*"
    r"(?:(?:cmd(?:\.exe)?\s+/[ck]\s+)?(?:rd|rmdir|dir|del|erase|copy|xcopy|robocopy|format|reg|findstr))\b",
    re.IGNORECASE,
)
_LEADING_CD_RE = re.compile(
    r"^\s*(?:cd|chdir)\s+(?:/d\s+)?"
    r'(?:"(?P<double>[^"]+)"|\'(?P<single>[^\']+)\'|(?P<bare>[^\s;&|]+))'
    r"\s*(?:&&|&|;)",
    re.IGNORECASE,
)
_NETWORK_SHELL_RE = re.compile(
    r"https?://"
    r"|\b(curl|wget|scp|sftp|rsync|nc|ncat|socat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b"
    r"|(?:^|[;&|\n])\s*ssh\s+(?:-[^\s]+\s+)*(?:\S+@)?[A-Za-z0-9_.-]+"
    r"|(?:^|[;&|\n])\s*git\s+(?:clone|fetch|pull|push|remote\s+add)\b"
    r"|(?:^|[;&|\n])\s*(?:npm\s+(?:install|i|add|ci)|npx\b|pip\s+install\b|go\s+install\b|cargo\s+install\b|"
    r"brew\s+install\b|docker\s+(?:pull|run|push)\b|kubectl\b|terraform\s+(?:apply|destroy|plan)\b|"
    r"aws\b|gcloud\b|aliyun\b|tccli\b|nmap\b|masscan\b|hping3\b|aircrack-ng\b|ettercap\b|sqlmap\b|hydra\b|ab\s+)"
    r"|/dev/(?:tcp|udp)/",
    re.IGNORECASE,
)
_SCRIPT_NETWORK_SHELL_RE = re.compile(
    r"(?:^|[;&|\n])\s*(?:python3?|perl|php|ruby)\b[^\n;]*(?:socket|Socket|fsockopen)",
    re.IGNORECASE,
)
_SCRIPT_NETWORK_INTERPRETER_RE = re.compile(r"(?:^|[;&|\n])\s*(?:python3?|perl|php|ruby)\b", re.IGNORECASE)


def normalize_runtime_action(
    *,
    tool_call_id: str,
    tool_name: str,
    tool_input: Mapping[str, Any],
    cwd: str | None,
    origin: ToolCallOrigin,
    profile: BuildProfile,
    mode: PermissionMode,
    operating_system: OperatingSystem | None = None,
    app_dir: str | None = None,
    app_dir_exclusions: tuple[str, ...] = (),
    workspace_root: str | None | object = INHERIT_CWD,
    operation: RuntimeOperation | None = None,
) -> RuntimeAction:
    """Normalize one raw tool call into a ``RuntimeAction``."""
    canonical_tool_name = _canonical_tool_name(tool_name, tool_input)
    tool_type, inferred_operation, target_kind = _classify_tool(canonical_tool_name, tool_input)
    operation = operation if operation is not None else inferred_operation
    workspace_root = cwd if workspace_root is INHERIT_CWD else workspace_root
    target_value = _target_value(canonical_tool_name, tool_input)
    normalized_payload = target_value if target_value else _fallback_payload(tool_input)
    raw_paths = _dedupe(_extract_path_targets(canonical_tool_name, tool_input, normalized_payload))
    resolved_paths = _dedupe(path for path in (_normalize_path(path, cwd) for path in raw_paths) if path)
    glob_pattern = _string_arg(tool_input, "pattern") if canonical_tool_name == "Glob" else ""
    sensitive_path_candidate = any(is_sensitive_path_candidate(path) for path in (*raw_paths, *resolved_paths, target_value, glob_pattern))
    network_egress_candidate = _network_egress_candidate(canonical_tool_name, normalized_payload)
    workspace_scope = _workspace_scope(resolved_paths, workspace_root)
    # privileged origin 后续给 resolver/策略层使用
    privileged_origin_candidate = False
    # safe fast path 后续给性能优化或 allow 快速路径使用
    safe_fast_path_candidate = False
    extracted_args = _extract_args(canonical_tool_name, tool_input, raw_paths)

    return RuntimeAction(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        canonical_tool_name=canonical_tool_name,
        tool_input=tool_input,
        tool_type=tool_type,
        operation=operation,
        target_kind=target_kind,
        target_value=target_value,
        normalized_payload=normalized_payload,
        cwd=cwd,
        resolved_paths=resolved_paths,
        workspace_scope=workspace_scope,
        origin=origin,
        profile=profile,
        operating_system=operating_system,
        mode=mode,
        sensitive_path_candidate=sensitive_path_candidate,
        network_egress_candidate=network_egress_candidate,
        privileged_origin_candidate=privileged_origin_candidate,
        safe_fast_path_candidate=safe_fast_path_candidate,
        extracted_args=extracted_args,
        app_dir=app_dir,
        app_dir_exclusions=app_dir_exclusions,
        workspace_root=workspace_root,
    )


def _canonical_tool_name(tool_name: str, tool_input: Mapping[str, Any]) -> str:
    stripped = tool_name.strip()
    if stripped in CANONICAL_TOOL_CLASSIFICATION:
        return stripped

    key = stripped.casefold()
    contextual = URL_TARGET_TOOL_NAME_TO_CANONICAL.get(key)
    if contextual is not None:
        return contextual if _has_url_target(tool_input) else tool_name
    return TOOL_NAME_TO_CANONICAL.get(key, tool_name)


def _classify_tool(tool_name: str, tool_input: Mapping[str, Any]) -> tuple[ToolType, RuntimeOperation, TargetKind]:
    classification = CANONICAL_TOOL_CLASSIFICATION.get(tool_name, (ToolType.UNKNOWN, RuntimeOperation.UNKNOWN, TargetKind.UNKNOWN))
    tool_type, operation, target_kind = classification
    action = _string_arg(tool_input, "action").strip().lower()
    if action:
        operation = TOOL_ACTION_OPERATION_OVERRIDES.get(tool_name, {}).get(action, operation)
    return tool_type, operation, target_kind


def _target_value(tool_name: str, tool_input: Mapping[str, Any]) -> str:
    if tool_name == "TodoWrite":
        return "todos"
    if tool_name == "PresentToUser":
        return _first_string_list_arg(tool_input, TOOL_TARGET_KEYS[tool_name])
    if tool_name == "WebBatchFetch":
        return _first_string_list_arg(tool_input, TOOL_TARGET_KEYS[tool_name])
    for key in TOOL_TARGET_KEYS.get(tool_name, ()):
        value = _string_arg(tool_input, key)
        if value:
            return value
    if tool_name == "Grep":
        return "."
    return ""


def _extract_path_targets(
    tool_name: str,
    tool_input: Mapping[str, Any],
    normalized_payload: str,
) -> tuple[str, ...]:
    if tool_name == "PresentToUser":
        return _first_string_list_arg_values(tool_input, TOOL_TARGET_KEYS[tool_name])
    if tool_name in _WRITE_PATH_TOOLS or tool_name in _READ_PATH_TOOLS:
        path = _first_string_arg(tool_input, TOOL_TARGET_KEYS[tool_name])
        return (path,) if path else ()
    if tool_name in {"Glob", "Grep"}:
        path = _string_arg(tool_input, "path")
        if tool_name == "Glob" and not path:
            path = _glob_base_path(_string_arg(tool_input, "pattern"))
        if tool_name == "Grep" and not path:
            path = "."
        return (path,) if path else ()
    if tool_name in _SHELL_TOOLS:
        return tuple(_extract_shell_path_candidates(normalized_payload))
    return ()


def _extract_shell_path_candidates(command: str) -> list[str]:
    if not command:
        return []
    analysis = analyze_shell_text(command)
    command_sources = (analysis.top_level_executable_text, *analysis.nested_commands) if analysis.nested_commands else (command,)
    uses_windows_command_syntax = _WINDOWS_COMMAND_SYNTAX_RE.search(analysis.executable_text) is not None
    out: list[str] = []
    for source in command_sources:
        command_local_cwd = _leading_cd_directory(source)
        for word in _split_shell_words(source):
            token = _clean_path_token(word)
            if not token or "://" in token:
                continue
            token = _path_candidate_from_shell_token(token)
            token = token.removeprefix("@")
            token = _clean_path_token(token)
            if uses_windows_command_syntax and token.casefold() in _WINDOWS_PATHLESS_SWITCHES:
                continue
            if _looks_path_like(token) or is_sensitive_path_candidate(token):
                out.append(_resolve_command_local_path(token, command_local_cwd))
    return out


def _leading_cd_directory(command: str) -> str:
    """Return a deterministic cwd established at the start of a command chain."""
    match = _LEADING_CD_RE.match(command)
    if match is None:
        return ""
    return next((value for value in match.group("double", "single", "bare") if value), "")


def _resolve_command_local_path(path: str, command_local_cwd: str) -> str:
    """Resolve a relative path after a leading ``cd DIR &&`` command."""
    if not command_local_cwd or _is_absolute_path(path) or path.startswith("~"):
        return path
    base = command_local_cwd.replace("\\", "/").rstrip("/")
    return f"{base}/{path}"


def _path_candidate_from_shell_token(token: str) -> str:
    """Extract path values embedded in shell option assignments."""
    if "=" not in token:
        return token

    left, right = token.rsplit("=", 1)
    cleaned = _clean_path_token(right.removeprefix("@"))
    if left.startswith("-") or right.startswith("@") or _looks_path_like(cleaned) or is_sensitive_path_candidate(cleaned):
        return cleaned
    return token


def _split_shell_words(command: str) -> list[str]:
    try:
        return shlex.split(command, posix="\\" not in command)
    except ValueError:
        return command.split()


def _looks_path_like(value: str) -> bool:
    if not value:
        return False
    if value.startswith(("/", "~", "./", "../", ".\\")):
        return True
    if _WINDOWS_ABSOLUTE_RE.match(value):
        return True
    return "/" in value or "\\" in value


def _glob_base_path(pattern: str) -> str:
    if not pattern:
        return ""

    cleaned = _clean_path_token(pattern)
    if not cleaned:
        return ""

    normalized = cleaned.replace("\\", "/")
    parts = normalized.split("/")
    base_parts: list[str] = []
    for part in parts:
        if any(char in part for char in "*?["):
            break
        base_parts.append(part)

    if not base_parts:
        return "."

    base = "/".join(base_parts).rstrip("/")
    if not base:
        return "/" if normalized.startswith("/") else "."
    return base


def _normalize_path(path: str, cwd: str | None) -> str:
    cleaned = _clean_path_token(path)
    if not cleaned:
        return ""
    path_for_norm = cleaned.replace("\\", "/")
    if _WINDOWS_DRIVE_ROOT_RE.match(path_for_norm):
        return path_for_norm.casefold()
    if cwd and not _is_absolute_path(path_for_norm) and not path_for_norm.startswith("~"):
        cwd_norm = cwd.replace("\\", "/").rstrip("/")
        path_for_norm = f"{cwd_norm}/{path_for_norm}"
    normalized = posixpath.normpath(path_for_norm)
    if normalized == ".":
        return ""
    return _casefold_path(normalized)


def _workspace_scope(resolved_paths: tuple[str, ...], cwd: str | None) -> WorkspaceScope:
    if not cwd or not resolved_paths:
        return WorkspaceScope.UNKNOWN

    workspace = _normalize_path(cwd, None)
    if not workspace:
        return WorkspaceScope.UNKNOWN

    prefix = workspace.rstrip("/") + "/"
    inside = tuple(path == workspace or path.startswith(prefix) for path in resolved_paths)
    if all(inside):
        return WorkspaceScope.INSIDE
    if any(inside):
        return WorkspaceScope.MIXED
    return WorkspaceScope.OUTSIDE


def _dedupe(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value for value in values if value))


def _network_egress_candidate(tool_name: str, payload: str) -> bool:
    if tool_name in _NETWORK_TOOLS:
        return True
    if tool_name in _SHELL_TOOLS:
        executable_payload = analyze_shell_text(payload).executable_text
        return _NETWORK_SHELL_RE.search(executable_payload) is not None or (
            _SCRIPT_NETWORK_INTERPRETER_RE.search(executable_payload) is not None and _SCRIPT_NETWORK_SHELL_RE.search(payload) is not None
        )
    return False


def _extract_args(tool_name: str, tool_input: Mapping[str, Any], raw_paths: tuple[str, ...]) -> dict[str, str]:
    out: dict[str, str] = {}
    if raw_paths:
        out["paths"] = ";".join(raw_paths[:5])
    if tool_name in _SHELL_TOOLS:
        out["command"] = _first_string_arg(tool_input, TOOL_TARGET_KEYS[tool_name])
    elif tool_name == "Glob":
        out["pattern"] = _string_arg(tool_input, "pattern")
    elif tool_name in {"WebCrawl", "WebFetch"}:
        out["url"] = _first_string_arg(tool_input, TOOL_TARGET_KEYS[tool_name])
    elif tool_name == "WebBatchFetch":
        out["urls"] = ";".join(_first_string_list_arg_values(tool_input, TOOL_TARGET_KEYS[tool_name])[:5])
    elif tool_name == "WebSearch":
        out["query"] = _first_string_arg(tool_input, TOOL_TARGET_KEYS[tool_name])
    return out


def _first_string_arg(tool_input: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = _string_arg(tool_input, key)
        if value:
            return value
    return ""


def _first_string_list_arg(tool_input: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    values = _first_string_list_arg_values(tool_input, keys)
    return values[0] if values else ""


def _first_string_list_arg_values(tool_input: Mapping[str, Any], keys: tuple[str, ...]) -> tuple[str, ...]:
    for key in keys:
        values = _string_list_arg(tool_input, key)
        if values:
            return values
    return ()


def _has_url_target(tool_input: Mapping[str, Any]) -> bool:
    for key in URL_TARGET_KEYS:
        value = _string_arg(tool_input, key)
        if value.startswith(("http://", "https://")):
            return True
    return False


def _string_arg(tool_input: Mapping[str, Any], key: str) -> str:
    value = tool_input.get(key)
    return value if isinstance(value, str) else ""


def _string_list_arg(tool_input: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = tool_input.get(key)
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item)


def _fallback_payload(tool_input: Mapping[str, Any]) -> str:
    return str(dict(tool_input))


def _clean_path_token(value: str) -> str:
    return value.strip().strip("\"'`").strip(";,|&()[]{}").lstrip("<>").strip()


def _is_absolute_path(value: str) -> bool:
    return value.startswith("/") or _WINDOWS_ABSOLUTE_RE.match(value) is not None


def _casefold_path(value: str) -> str:
    return value.casefold() if _WINDOWS_ABSOLUTE_RE.match(value) else value
