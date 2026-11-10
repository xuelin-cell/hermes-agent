"""Host-independent request boundary; Hermes maps tools to this in task 4."""

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass, field, replace
from pathlib import PurePosixPath, PureWindowsPath
import posixpath
from typing import Any

from .guardrail.action import RuntimeOperation
from .guardrail.engine import check_permissions
from .guardrail.path_policy import normalize_protected_root
from .guardrail.runtime import ExecutionEnvironment, use_execution_environment
from .guardrail.types import (
    BuildProfile, DecisionBehavior, OperatingSystem, PermissionDecision,
    PermissionMode, PermissionRule, ToolCallOrigin,
)


@dataclass(frozen=True)
class GuardrailRequest:
    """Trusted context is supplied by the host, never taken from tool arguments.

    Tool names/arguments follow the engine's canonical schemas. BuildProfile
    None selects common rules; it does not infer a UniClaw product edition.
    cwd resolves relative paths; workspace_root describes the security boundary.
    """

    tool_name: str
    args: Mapping[str, Any]
    profile: BuildProfile | None
    operating_system: OperatingSystem | None
    cwd: str | None
    workspace_root: str | None
    mode: PermissionMode = PermissionMode.ASK
    origin: ToolCallOrigin = field(default_factory=lambda: ToolCallOrigin(kind="agent"))
    tool_call_id: str = ""
    protected_roots: tuple[str, ...] = ()
    user_rules: tuple[PermissionRule, ...] = ()
    session_rules: tuple[PermissionRule, ...] = ()
    operation: RuntimeOperation | None = None
    environment: ExecutionEnvironment = field(default_factory=ExecutionEnvironment)

    def __post_init__(self):
        if not isinstance(self.tool_name, str) or not self.tool_name.strip() or not isinstance(self.args, Mapping):
            raise ValueError("A tool name and argument mapping are required")
        if self.profile is not None and not isinstance(self.profile, BuildProfile):
            raise ValueError("profile must be a BuildProfile or unknown")
        if self.operating_system is not None and not isinstance(self.operating_system, OperatingSystem):
            raise ValueError("operating_system must be an OperatingSystem or unknown")
        if not isinstance(self.mode, PermissionMode) or not isinstance(self.origin, ToolCallOrigin):
            raise ValueError("Invalid mode or trusted origin")
        if self.operation is not None and not isinstance(self.operation, RuntimeOperation):
            raise ValueError("Invalid operation")
        if isinstance(self.protected_roots, (str, bytes)):
            raise ValueError("protected_roots must be a sequence of absolute directory strings")
        roots = []
        for root in self.protected_roots:
            if not isinstance(root, str) or not root.strip() or not (
                PurePosixPath(root).is_absolute() or PureWindowsPath(root).is_absolute()
            ):
                raise ValueError("Protection roots must be absolute directory strings")
            lexical = root.replace("\\", "/")
            if any(part in {".", ".."} for part in lexical.split("/")):
                raise ValueError("Protection roots must already resolve dot segments")
            lexical = posixpath.normpath(lexical)
            normalized = normalize_protected_root(lexical)
            if normalized is None or normalized != lexical.lower().rstrip("/"):
                raise ValueError("Protection root cannot be represented by the directory policy")
            roots.append(normalized)
        object.__setattr__(self, "args", deepcopy(dict(self.args)))
        object.__setattr__(self, "protected_roots", tuple(roots))
        object.__setattr__(self, "user_rules", tuple(self.user_rules))
        object.__setattr__(self, "session_rules", tuple(self.session_rules))


def evaluate_tool_call(request: GuardrailRequest) -> PermissionDecision:
    """Evaluate without Hermes imports, environment variables or ambient file I/O.

    Exceptions (including missing script inspection capabilities) are deliberately
    propagated for the host adapter to block; they are not converted to ALLOW.
    """
    environment = replace(request.environment, operating_system=request.operating_system)
    ask = None
    with use_execution_environment(environment):
        for root in request.protected_roots or (None,):
            decision = check_permissions(
                tool_name=request.tool_name, tool_input=deepcopy(dict(request.args)),
                origin=request.origin, profile=request.profile, mode=request.mode,
                user_rules=list(request.user_rules), session_rules=list(request.session_rules),
                cwd=request.cwd, workspace_root=request.workspace_root,
                tool_call_id=request.tool_call_id, operating_system=request.operating_system,
                app_dir=root, appdata_root=environment.appdata_root,
                operation=request.operation,
            )
            if decision.behavior == DecisionBehavior.DENY:
                return decision
            if decision.behavior == DecisionBehavior.ASK and ask is None:
                ask = decision
    return ask or decision
