"""Optional async facade over the explicit plugin request contract."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Literal

class GuardrailMode(str, Enum):
    """How aggressively the guardrail gates tool calls.

    * ASK  — hard-deny + needs-approval list (the agent asks the user).
    * AUTO — default ("yolo"): hard-deny still fires; everything else passes.
    """

    ASK = "ask"
    AUTO = "auto"


class GuardrailDecision(str, Enum):
    """The verdict for a single tool call."""

    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


@dataclass(frozen=True)
class GuardrailOutput:
    """The guardrail's verdict for one tool call — the package's only exit type.

    Args:
        decision: ALLOW / DENY / ASK.
        reason: Optional human-readable explanation.  Surfaced to the agent
            on DENY (so it can re-plan) and to the user in the approval modal
            on ASK.  ``None`` for a plain ALLOW.
    """

    decision: GuardrailDecision
    reason: str | None = None
    source: Literal["terminal_baseline", "ask_baseline", "user_rule", "session_rule", "default"] | None = None
    rule_ids: tuple[str, ...] = ()
    category: str | None = None



async def check_tool_permission(tool_call, messages=None, model=None, cwd=None, mode=GuardrailMode.AUTO,
                                *, platform=None, origin=None, user_rules=(), session_rules=(),
                                profile=None, workspace_root=None, protected_roots=(), environment=None):
    from ..contracts import GuardrailRequest, evaluate_tool_call
    from .runtime import ExecutionEnvironment
    from .types import PermissionMode, ToolCallOrigin, operating_system_from_platform

    decision = evaluate_tool_call(GuardrailRequest(
        tool_name=str(tool_call.get("name", "")), args=tool_call.get("args") or {},
        profile=profile, operating_system=operating_system_from_platform(platform),
        cwd=cwd, workspace_root=workspace_root if workspace_root is not None else cwd,
        mode=PermissionMode(mode.value), origin=origin or ToolCallOrigin(kind="agent"),
        tool_call_id=str(tool_call.get("id", "")), protected_roots=tuple(protected_roots),
        user_rules=tuple(user_rules), session_rules=tuple(session_rules),
        environment=environment or ExecutionEnvironment(),
    ))
    return GuardrailOutput(GuardrailDecision(decision.behavior.value), decision.reason.detail or None,
                           decision.source, decision.rule_ids, decision.category)
