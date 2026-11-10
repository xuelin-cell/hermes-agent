"""Final, read-only authorization over the execution a tool has prepared."""

from collections.abc import Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from dataclasses import asdict
import hashlib
import json
from types import MappingProxyType
from typing import Any, Callable


def freeze(value):
    if isinstance(value, Mapping):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(freeze(item) for item in value)
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError("Execution parameters must contain JSON-compatible values")


def thaw(value):
    if isinstance(value, Mapping):
        return {key: thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [thaw(item) for item in value]
    return value


@dataclass(frozen=True)
class FileExecutionTarget:
    operation: str
    path: str
    original_path: str = ""
    role: str = "content"
    content: str = ""


@dataclass(frozen=True)
class ExecutionCapabilities:
    read_script: Callable[[str, int], bytes | None] | None = None
    exists: Callable[[str], bool | None] | None = None
    is_directory: Callable[[str], bool | None] | None = None
    resolve_path: Callable[[str, str | None], str] | None = None


@dataclass(frozen=True)
class PreparedToolExecution:
    tool_name: str
    arguments: Mapping[str, Any]
    targets: tuple[FileExecutionTarget, ...] = ()
    backend: str = "unknown"
    operating_system: str | None = None
    shell: str | None = None
    cwd: str | None = None
    workspace_root: str | None = None
    task_id: str = ""
    session_id: str = ""
    tool_call_id: str = ""
    turn_id: str = ""
    profile_scope: str = ""
    environment: Mapping[str, str] = field(default_factory=dict)
    capabilities: ExecutionCapabilities = field(default_factory=ExecutionCapabilities)

    def __post_init__(self):
        object.__setattr__(self, "arguments", freeze(self.arguments))
        object.__setattr__(self, "targets", tuple(self.targets))
        object.__setattr__(self, "environment", freeze(self.environment))


_CALL = ContextVar("prepared_tool_call", default=None)


@contextmanager
def tool_execution_scope(tool_name, arguments, **ids):
    token = _CALL.set((tool_name, freeze(arguments), dict(ids)))
    try:
        yield
    finally:
        _CALL.reset(token)


def current_call(tool_name):
    value = _CALL.get()
    return value if value is not None and value[0] == tool_name else None


def execution_policy_available():
    from hermes_cli.plugins import get_plugin_manager
    manager = get_plugin_manager()
    manager.discover_and_load()
    return manager.has_hook("pre_tool_execute")


def enforce_tool_execution(execution: PreparedToolExecution) -> str | None:
    """A veto wins over approval; no rewriting is legal at this boundary."""
    from hermes_cli.plugins import invoke_hook
    try:
        if not execution_policy_available():
            return None
        results = invoke_hook(
            "pre_tool_execute", execution=execution, task_id=execution.task_id,
            session_id=execution.session_id, tool_call_id=execution.tool_call_id,
            turn_id=execution.turn_id,
        )
    except Exception:
        return "BLOCKED: final execution policy dispatch failed"
    approvals = []
    for result in results:
        if not isinstance(result, Mapping) or result.get("action") not in {"block", "approve"}:
            return "BLOCKED: invalid final execution policy result"
        if result["action"] == "block":
            return str(result.get("message") or "BLOCKED: final execution policy denied this operation")
        approvals.append(result)
    for directive in approvals:
        try:
            from tools.approval import request_tool_approval
            from tools.approval_context import reset_current_observability_context, set_current_observability_context
            tokens = set_current_observability_context(
                turn_id=execution.turn_id, tool_call_id=execution.tool_call_id, session_id=execution.session_id)
            try:
                binding = {key: thaw(getattr(execution, key)) for key in (
                    "tool_name", "arguments", "backend", "operating_system", "shell", "cwd",
                    "workspace_root", "task_id", "session_id", "profile_scope", "environment")}
                binding["targets"] = [asdict(target) for target in execution.targets]
                binding["policy_key"] = directive.get("rule_key", "")
                rule_key = hashlib.sha256(json.dumps(binding, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                result = request_tool_approval(execution.tool_name, str(directive.get("message") or ""),
                                               rule_key="prepared:" + rule_key)
            finally:
                reset_current_observability_context(tokens)
            if not result.get("approved"):
                return str(result.get("message") or "BLOCKED: final execution approval denied")
        except Exception:
            return "BLOCKED: final execution approval failed"
    return None
