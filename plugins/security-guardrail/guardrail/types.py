"""Permission system data types — pure data, zero behavior.

> "Regex 永远赶不上 shell 的语义灵活性，真攻击者绕得过，正常用户撞得着。"
>   — guominhui (security-policy-analysis 附录 C.5)

So this module's job is **minimum viable safety** for ToB compliance, NOT
adversarial defense.  Real protection comes from VM isolation (Pro) or
the user's own ACLs (Lite).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal


class PermissionMode(str, Enum):
    """Two-mode model — keep it simple.

    * ASK   = default. Hard-deny + approval blacklist + ask user.
    * AUTO  = "yolo". Hard-deny still active; everything else passes through.
              Users must be warned before switching INTO this mode.
    """

    ASK = "ask"
    AUTO = "auto"


class BuildProfile(str, Enum):
    """Compile-time variant. Decides which rule lists are active."""

    PRO = "pro"  # WSL/Lima sandbox bottoms out the blast radius
    LITE = "lite"  # User's host directly — needs more guardrails
    SERVER = "server"  # Headless cloud — allowlist-only mode


class OperatingSystem(str, Enum):
    """Supported operating systems for baseline-rule applicability."""

    WINDOWS = "windows"
    LINUX = "linux"
    MACOS = "macos"


ALL_OPERATING_SYSTEMS: frozenset[OperatingSystem] = frozenset(OperatingSystem)


def operating_system_from_platform(platform: str | None) -> OperatingSystem | None:
    """Normalize an environment platform string to a supported OS."""
    if not platform:
        return None
    return {
        "windows": OperatingSystem.WINDOWS,
        "win32": OperatingSystem.WINDOWS,
        "linux": OperatingSystem.LINUX,
        "darwin": OperatingSystem.MACOS,
        "macos": OperatingSystem.MACOS,
    }.get(platform.strip().casefold())


class RuleSource(str, Enum):
    """Where a rule came from. High-precedence sources win conflicts."""

    BUILTIN_HARD = "builtin_hard"  # Terminal baseline deny, user cannot remove.
    BUILTIN_APPROVAL = "builtin_approval"  # ~25 needs-approval, user can allow over
    POLICY = "policy"  # enterprise managed policy.json
    PROJECT = "project"  # workdir/.hexagent/settings.json
    USER = "user"  # ~/.hexagent/settings.json
    SESSION = "session"  # in-memory, dies with conversation


class RuleBehavior(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    # NOTE: no "ask" rule — ask is what built-in approval list does, users
    # can only ALLOW (override) or DENY.  A user-defined "ask" rule has
    # zero value.


class DecisionBehavior(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


@dataclass(frozen=True)
class RuleValue:
    """What the rule matches.

    For Bash: ``ruleContent`` is a wildcard pattern over the command,
    e.g. ``"rm -rf node_modules"`` (exact) or ``"rm -rf *"`` (wildcard).

    For FileWrite/FileEdit: a path glob like ``"C:\\Windows\\**"``.

    For other tools: tool-specific.  Empty string = match the tool itself.
    """

    tool_name: str
    rule_content: str = ""


@dataclass(frozen=True)
class PermissionRule:
    source: RuleSource
    behavior: RuleBehavior
    value: RuleValue
    # Free-form reason shown in approval dialogs.  Only set on builtin rules.
    reason: str = ""
    # Categorisation for telemetry & UI grouping.  See DangerCategory below.
    category: str = ""


class DangerCategory(str, Enum):
    """The four canonical buckets — borrowed from Claude Code's classifier.

    These are what we tell users / show in audit logs / put in compliance
    docs.  Every approval rule must belong to one of these.
    """

    CODE_FROM_EXTERNAL = "code_from_external"
    IRREVERSIBLE_DESTRUCTION = "irreversible_destruction"
    UNAUTHORIZED_PERSISTENCE = "unauthorized_persistence"
    SECURITY_WEAKEN = "security_weaken"


@dataclass
class DecisionReason:
    """Why we made the decision we did.  Surfaces in audit + UI.

    Carries enough info that a user reading the approval dialog can answer
    "why is this dialog showing?" without us writing custom prose for every
    rule — just show the rule's category + content.
    """

    kind: Literal["rule", "default", "privileged", "mode_auto"]
    rule: PermissionRule | None = None
    detail: str = ""


@dataclass
class PermissionDecision:
    behavior: DecisionBehavior
    reason: DecisionReason
    # Set when ASK is the verdict — UI shows these as "permanent allow"
    # checkbox text. Wildcard variants help users grant once for many.
    suggested_rules: list[RuleValue] = field(default_factory=list)
    source: Literal["terminal_baseline", "ask_baseline", "user_rule", "session_rule", "default"] | None = None
    rule_ids: tuple[str, ...] = ()
    category: str | None = None


@dataclass
class ToolCallOrigin:
    """Where this tool call came from.  Privileged channel uses this to
    bypass the entire permission engine.

    The middleware constructs this from the request context — see
    ``langchain/middleware.py``.
    """

    kind: Literal["agent", "builtin_skill", "trusted_mcp", "system"] = "agent"
    skill_id: str | None = None
    mcp_server_id: str | None = None


@dataclass
class UserApprovalResponse:
    """What the user clicked in the approval dialog.

    Backend constructs this from the REST POST and pumps it into the
    PermissionContext's pending request future.
    """

    behavior: DecisionBehavior  # ALLOW or DENY
    persist: Literal["once", "session", "permanent", None] = "once"
    # When persist != "once", which rule pattern to install.  Picked from
    # the ``suggested_rules`` we returned in the ask decision — usually the
    # exact match (index 0) or wildcard (index 1).
    chosen_rule: RuleValue | None = None
    # Optional free-text reason on DENY — gets fed back to the agent as a
    # system-reminder so the LLM can re-plan instead of retrying blind.
    reason: str = ""
