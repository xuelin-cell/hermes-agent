"""Permission state without UniClaw security-center auditing or UI policy."""
from __future__ import annotations
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from .types import BuildProfile, PermissionMode, PermissionRule, RuleSource, RuleValue
logger = logging.getLogger(__name__)
PersistRuleCallback = Callable[[PermissionRule], Awaitable[None]]

@dataclass
class PermissionContext:
    """Per-conversation permission state."""

    profile: BuildProfile
    mode: PermissionMode = PermissionMode.ASK
    # Runtime environment used by both the live gate and ASK re-derivation.
    # Populated from EnvironmentContext when the agent is built.
    cwd: str | None = None
    platform: str | None = None
    # Session-scoped rules (cleared on conversation end).
    session_rules: list[PermissionRule] = field(default_factory=list)
    # User-level rules (loaded once at startup from settings.json).
    # Owned by the backend; we get a reference but don't mutate directly.
    user_rules: list[PermissionRule] = field(default_factory=list)
    # Caller-injected callback (set by backend at construction time) used by
    # ``add_user_rule`` to persist a permanent rule to disk.
    persist_rule: PersistRuleCallback | None = None
    # tool_call_id → human-readable deny message recorded by middleware when
    # the engine short-circuits with DENY (hard-deny OR user-defined deny).
    # The chat route reads this in its synthetic-tool_result flush so the
    # UI gets a real "Permission denied: …" card instead of a generic
    # "[not_executed]" placeholder.  Pruned after read.
    recent_denials: dict[str, str] = field(default_factory=dict)
    # tool_call_id → (content, is_error) for successful backend middleware
    # short-circuits that do not invoke LangChain's underlying tool handler.
    # The recorder consumes these at turn close so the transcript contains the
    # real result instead of ``[not_executed]``.  Kept separate from denials to
    # preserve their error semantics and existing permission flow.
    recent_short_circuit_results: dict[str, tuple[str, bool]] = field(default_factory=dict)

    def add_session_rule(self, rule: PermissionRule) -> None:
        """Append a rule that lives only for this conversation."""
        # Force the source so callers can't accidentally write Level 4 here.
        self.session_rules.append(
            PermissionRule(
                source=RuleSource.SESSION,
                behavior=rule.behavior,
                value=rule.value,
                reason=rule.reason,
                category=rule.category,
            )
        )

    async def add_user_rule(self, rule: PermissionRule) -> None:
        """Persist a rule to user-level settings (Level 4)."""
        promoted = PermissionRule(
            source=RuleSource.USER,
            behavior=rule.behavior,
            value=rule.value,
            reason=rule.reason,
            category=rule.category,
        )
        self.user_rules.append(promoted)
        if self.persist_rule:
            try:
                await self.persist_rule(promoted)
            except Exception:
                logger.exception("Failed to persist user permission rule; in-memory only")

    def remove_session_rule(self, value: RuleValue) -> bool:
        """Remove a session rule by value (used by UI 三个点 menu)."""
        before = len(self.session_rules)
        self.session_rules = [r for r in self.session_rules if r.value != value]
        return len(self.session_rules) < before

    def visible_session_rules(self) -> list[PermissionRule]:
        """Snapshot for the UI 三个点 menu (current session view)."""
        return list(self.session_rules)

    def visible_user_rules(self) -> list[PermissionRule]:
        """Snapshot for the global Settings panel."""
        return list(self.user_rules)
