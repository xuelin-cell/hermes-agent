"""Plugin settings and trusted, process-local session allowances (no UI store)."""

from dataclasses import asdict
from threading import RLock

from ..guardrail.types import PermissionRule, RuleBehavior, RuleSource, RuleValue

_lock = RLock()
_sessions = {}


def parse_user_rules(values):
    if not isinstance(values, list):
        raise ValueError("user_rules must be a list")
    rules = []
    for value in values:
        if not isinstance(value, dict) or set(value) - {"tool", "pattern", "behavior"}:
            raise ValueError("invalid user rule")
        tool, pattern = value.get("tool"), value.get("pattern", "")
        if not isinstance(tool, str) or not tool or not isinstance(pattern, str):
            raise ValueError("invalid user rule target")
        rules.append(PermissionRule(RuleSource.USER, RuleBehavior(value["behavior"]), RuleValue(tool, pattern)))
    return tuple(rules)


def allow_session(profile_scope, session_id, tool_name, pattern=""):
    """Trusted host API only; no model tool or permanent policy is registered."""
    if not all(isinstance(value, str) and value for value in (profile_scope, session_id, tool_name)) or not isinstance(pattern, str):
        raise ValueError("session allowance needs explicit profile, session and tool")
    rule = PermissionRule(RuleSource.SESSION, RuleBehavior.ALLOW, RuleValue(tool_name, pattern))
    with _lock:
        rules = _sessions.setdefault((profile_scope, session_id), [])
        if rule not in rules:
            rules.append(rule)


def session_rules(profile_scope, session_id):
    with _lock:
        return tuple(_sessions.get((profile_scope, session_id), ()))


def clear_session(profile_scope, session_id):
    with _lock:
        _sessions.pop((profile_scope, session_id), None)


def clear_all():
    with _lock:
        _sessions.clear()


def policy_key(rules):
    return [asdict(rule) for rule in rules]
