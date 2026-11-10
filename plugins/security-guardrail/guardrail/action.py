"""Runtime action model for guardrail checks.

``RuntimeAction`` is the normalized, tool-agnostic view of one tool call.
It carries derived safety hints, but it does not make a permission decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

    from .types import BuildProfile, OperatingSystem, PermissionMode, ToolCallOrigin


class ToolType(str, Enum):
    """Coarse tool family used by deterministic guardrail checks."""

    SHELL = "shell"
    FILESYSTEM = "filesystem"
    NETWORK = "network"
    DATA = "data"
    UNKNOWN = "unknown"


class RuntimeOperation(str, Enum):
    """Semantic operation requested by a tool call."""

    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    EXECUTE = "execute"
    SEND = "send"
    SEARCH = "search"
    UNKNOWN = "unknown"


class TargetKind(str, Enum):
    """Kind of object the action mainly targets."""

    PATH = "path"
    COMMAND = "command"
    URL = "url"
    PAYLOAD = "payload"
    API = "api"
    UNKNOWN = "unknown"


class WorkspaceScope(str, Enum):
    """Whether resolved path targets are inside the current workspace."""

    INSIDE = "inside"
    OUTSIDE = "outside"
    MIXED = "mixed"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class RuntimeAction:
    """Normalized safety input for one tool call.

    Args:
        tool_call_id: Tool call id from the model, if present.
        tool_name: Tool name as exposed to the model.
        canonical_tool_name: Normalized tool name used by baseline detectors.
        tool_input: Raw tool arguments.
        tool_type: Coarse tool family.
        operation: Semantic action, such as read/write/execute.
        target_kind: Primary target kind.
        target_value: Primary normalized target value.
        normalized_payload: String used by legacy rules and deterministic checks.
        cwd: Current workspace directory, if known.
        resolved_paths: Best-effort normalized paths derived from the call.
        workspace_scope: String-only classification of resolved paths relative
            to the current working directory; unknown when either side is unavailable.
        origin: Caller origin.
        profile: Active build profile.
        operating_system: Normalized tool execution OS, or unknown.
        mode: Current permission mode.
        sensitive_path_candidate: Whether the target looks like a sensitive path.
        network_egress_candidate: Whether the action may contact a network peer.
        privileged_origin_candidate: Reserved resolver hint. P0 keeps it false.
        safe_fast_path_candidate: Reserved resolver hint. P0 keeps it false.
        extracted_args: Small summary of important parsed arguments.
        app_dir: Validated product installation root, when protection is active.
        app_dir_exclusions: Strict subdirectories excluded from installation
            protection, such as a portable build's data directory.
    """

    tool_call_id: str
    tool_name: str
    canonical_tool_name: str
    tool_input: Mapping[str, Any]
    tool_type: ToolType
    operation: RuntimeOperation
    target_kind: TargetKind
    target_value: str
    normalized_payload: str
    cwd: str | None
    resolved_paths: tuple[str, ...]
    workspace_scope: WorkspaceScope
    origin: ToolCallOrigin
    profile: BuildProfile
    operating_system: OperatingSystem | None
    mode: PermissionMode
    sensitive_path_candidate: bool
    network_egress_candidate: bool
    privileged_origin_candidate: bool
    safe_fast_path_candidate: bool
    extracted_args: Mapping[str, str]
    app_dir: str | None = None
    app_dir_exclusions: tuple[str, ...] = ()
    workspace_root: str | None = None
