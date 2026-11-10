"""Unit tests for ``_guardrail_migrated.guardrail``.

Pinned because:

* The hard-deny list is a product / compliance contract — the team has
  agreed these 10-13 patterns BLOCK regardless of mode / user override.
  Tests catch regressions where someone refactors the regex and a
  pattern silently stops matching (or starts over-matching).

* The privileged channel short-circuit is the single mechanism that
  stops our own built-in skills from being throttled by our own rules
  ("左右脑互搏"). If this breaks, the entire product breaks.

* The wildcard matcher is borrowed from Claude Code line-by-line; tests
  pin the same edge cases (escape sequences, prefix syntax, path globs).
"""

from __future__ import annotations

import pytest

from _guardrail_migrated.guardrail import (
    GuardrailDecision,
    GuardrailMode,
    GuardrailOutput,
    check_tool_permission,
)
from _guardrail_migrated.guardrail.context import PermissionContext
from _guardrail_migrated.guardrail.engine import check_permissions
from _guardrail_migrated.guardrail.matcher import matches_path, matches_pattern
from _guardrail_migrated.guardrail.types import (
    BuildProfile,
    DecisionBehavior,
    OperatingSystem,
    PermissionMode,
    PermissionRule,
    RuleBehavior,
    RuleSource,
    RuleValue,
    ToolCallOrigin,
)

# ── Wildcard matcher ──────────────────────────────────────────────────


class TestWildcardMatcher:
    def test_exact_match(self) -> None:
        assert matches_pattern("git status", "git status")
        assert not matches_pattern("git status", "git status --short")

    def test_legacy_prefix_syntax(self) -> None:
        # "npm:*" = exact "npm" OR "npm <anything>"
        assert matches_pattern("npm:*", "npm")
        assert matches_pattern("npm:*", "npm install")
        assert matches_pattern("npm:*", "npm install foo bar")
        assert not matches_pattern("npm:*", "npmjs")  # no spurious prefix

    def test_wildcard(self) -> None:
        assert matches_pattern("git *", "git status")
        assert matches_pattern("git *", "git push --force")
        assert matches_pattern("rm -rf *", "rm -rf node_modules")

    def test_escaped_star(self) -> None:
        # \* matches literal asterisk only
        assert matches_pattern(r"echo \*", "echo *")
        assert not matches_pattern(r"echo \*", "echo hello")

    def test_case_insensitive(self) -> None:
        assert matches_pattern("Get-Content*", "Get-Content foo.txt", case_insensitive=True)
        assert matches_pattern("Get-Content*", "get-content foo.txt", case_insensitive=True)

    def test_path_glob_recursive(self) -> None:
        assert matches_path("C:/Windows/**", "C:/Windows/System32/evil.dll")
        assert matches_path("**/.git/hooks/**", "src/foo/.git/hooks/post-commit")
        assert not matches_path("C:/Windows/**", "D:/project/file.py")

    def test_path_glob_separator_normalisation(self) -> None:
        # Backslashes get normalized to forward slashes for comparison.
        assert matches_path(r"C:\Windows\**", r"C:\Windows\System32\file.dll")


# ── Hard-deny — these MUST NOT be bypassable ──────────────────────────


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf /",
        "rm -rf /*",
        "rm -rf /etc",
        "rm -rf /home",
        "rm -rf /usr",
        "rm -rf ~",
        "rm -rf $HOME",
        "mkfs.ext4 /dev/sda1",
        "wipefs /dev/sda",
        "dd if=/dev/zero of=/dev/sda bs=1M",
        "cat secret > /dev/nvme0n1",
        ":(){ :|:& };:",
        "sudo shutdown -h now",
        "shutdown",
        "reboot",
        "systemctl poweroff",
        "init 0",
        "init 6",
        "telinit 0",
    ],
)
def test_hard_deny_universal_pro(command: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": command},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.DENY, f"expected DENY for {command!r}"
    assert decision.reason.kind == "rule"
    assert decision.reason.rule is not None


@pytest.mark.parametrize(
    "command",
    ["format C:", "bcdedit /set bootmgr displayorder {default}", "diskpart /s script.txt"],
)
def test_hard_deny_lite_extras(command: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": command},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.LITE,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.DENY, f"Lite hard-deny missed {command!r}"


def test_hard_deny_survives_auto_mode() -> None:
    """AUTO mode bypasses approval but MUST keep hard-deny active."""
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "rm -rf /"},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.AUTO,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.DENY


def test_hard_deny_survives_user_allow_rule() -> None:
    """A user 'allow rm -rf *' rule must NOT bypass hard-deny."""
    user_allow = PermissionRule(
        source=RuleSource.USER,
        behavior=RuleBehavior.ALLOW,
        value=RuleValue(tool_name="Bash", rule_content="rm *"),
    )
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "rm -rf /"},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[user_allow],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.DENY


# ── Privileged channel ────────────────────────────────────────────────


@pytest.mark.parametrize("origin_kind", ["builtin_skill", "trusted_mcp", "system"])
def test_privileged_origin_cannot_bypass_terminal_deny(origin_kind: str) -> None:
    """Privileged origins reduce noise but cannot override TerminalDeny."""
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "rm -rf /"},
        origin=ToolCallOrigin(kind=origin_kind),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.DENY
    assert decision.reason.kind == "rule"


@pytest.mark.parametrize("origin_kind", ["builtin_skill", "trusted_mcp", "system"])
def test_privileged_origin_still_bypasses_approval_noise(origin_kind: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "git reset --hard"},
        origin=ToolCallOrigin(kind=origin_kind),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.ALLOW
    assert decision.reason.kind == "privileged"


# ── Approval list (ASK behavior) ──────────────────────────────────────


def test_destructive_git_operation_asks() -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "git reset --hard"},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.ASK
    assert decision.reason.detail


def test_approval_skipped_in_auto_mode() -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "git reset --hard"},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.AUTO,
        user_rules=[],
        session_rules=[],
    )
    assert decision.behavior == DecisionBehavior.ALLOW
    assert decision.reason.kind == "mode_auto"


def test_session_allow_short_circuits_approval() -> None:
    session_rule = PermissionRule(
        source=RuleSource.SESSION,
        behavior=RuleBehavior.ALLOW,
        value=RuleValue(tool_name="Bash", rule_content="git reset --hard"),
    )
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": "git reset --hard"},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[session_rule],
    )
    assert decision.behavior == DecisionBehavior.ALLOW


# ── Default-allow path (the 99% case) ─────────────────────────────────


@pytest.mark.parametrize(
    "command",
    [
        "ls -la",
        "cat README.md",
        "git status",
        "git diff",
        "git push",
        "git push --force-with-lease",
        "npm install",
        "pip install requests",
        "pytest tests/",
        "rm file.txt",
        "rm -rf node_modules",
    ],
)
def test_default_allow_for_normal_dev_ops(command: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": command},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
    )
    if command in {"git push", "git push --force-with-lease", "rm file.txt", "rm -rf node_modules"}:
        assert decision.behavior == DecisionBehavior.ASK
    else:
        assert decision.behavior == DecisionBehavior.ALLOW, f"{command!r} should pass freely"


# ── Always-allow tools ────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("tool", "tool_input"),
    [
        ("Read", {"file_path": "/workspace/README.md"}),
        ("Glob", {"pattern": "**/*.py", "path": "/workspace"}),
        ("Grep", {"pattern": "TODO", "path": "/workspace"}),
        ("WebFetch", {"url": "https://example.invalid"}),
        ("WebSearch", {"query": "guardrail documentation"}),
        ("TodoWrite", {"todos": []}),
    ],
)
def test_always_allow_tools_skip_approval_checks_after_terminal_baseline(
    tool: str,
    tool_input: dict[str, object],
) -> None:
    decision = check_permissions(
        tool_name=tool,
        tool_input=tool_input,
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.LITE,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
        operating_system=OperatingSystem.LINUX,
    )
    assert decision.behavior == DecisionBehavior.ALLOW


@pytest.mark.parametrize(
    ("tool", "tool_input"),
    [
        ("Read", {"file_path": "/etc/shadow"}),
        ("Glob", {"pattern": "/etc/shadow"}),
        ("Grep", {"pattern": "root", "path": "/etc/shadow"}),
    ],
)
def test_always_allow_filesystem_tools_cannot_bypass_linux_sensitive_path_deny(
    tool: str,
    tool_input: dict[str, object],
) -> None:
    decision = check_permissions(
        tool_name=tool,
        tool_input=tool_input,
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.LITE,
        mode=PermissionMode.ASK,
        user_rules=[],
        session_rules=[],
        operating_system=OperatingSystem.LINUX,
    )

    assert decision.behavior == DecisionBehavior.DENY
    assert decision.reason.rule is not None
    assert decision.reason.rule.value.rule_content == "linux_sensitive_path_read"


# ── PermissionContext (non-blocking, single-source ASK) ───────────────


def test_context_is_pure_data_holder_no_blocking_api() -> None:
    """Design 1: ASK is non-blocking and single-source.

    ``PermissionContext`` no longer carries the mid-turn blocking machinery
    (the ``ask_user`` callback, in-flight ``pending`` futures, and the
    ``request_user_approval`` / ``resolve`` round-trip).  The gate ends an
    ASK turn via ``Command(goto=END)`` and the pending question is re-derived
    from the transcript instead.  Guard the invariant so the blocking flow
    can't silently creep back in.
    """
    ctx = PermissionContext(profile=BuildProfile.PRO)
    for removed in ("ask_user", "pending", "request_user_approval", "resolve"):
        assert not hasattr(ctx, removed), f"{removed!r} must not exist on PermissionContext (non-blocking ASK)"
    # The pure-data surface the backend mutates / reads is still present.
    assert ctx.mode == PermissionMode.ASK  # dataclass default; backend overrides to AUTO
    assert ctx.session_rules == []
    assert ctx.user_rules == []
    assert ctx.recent_denials == {}


def test_session_rule_persistence_constrains_source() -> None:
    """add_session_rule must force source=SESSION.

    Caller-provided source should not accidentally promote a session rule to user level.
    """
    ctx = PermissionContext(profile=BuildProfile.PRO)
    ctx.add_session_rule(
        PermissionRule(
            source=RuleSource.USER,  # caller mistake
            behavior=RuleBehavior.ALLOW,
            value=RuleValue(tool_name="Bash", rule_content="git push"),
        )
    )
    assert len(ctx.session_rules) == 1
    assert ctx.session_rules[0].source == RuleSource.SESSION


def test_remove_session_rule_by_value() -> None:
    ctx = PermissionContext(profile=BuildProfile.PRO)
    rule = PermissionRule(
        source=RuleSource.SESSION,
        behavior=RuleBehavior.ALLOW,
        value=RuleValue(tool_name="Bash", rule_content="git push"),
    )
    ctx.add_session_rule(rule)
    assert ctx.remove_session_rule(rule.value)
    assert ctx.visible_session_rules() == []
    assert not ctx.remove_session_rule(rule.value)  # idempotent


# ── Public entry: check_tool_permission (the guardrail contract) ───────────
# Pins the entry/exit handed to the security team: the async
# check_tool_permission(tool_call, messages, model, cwd, mode, *, platform) -> GuardrailOutput.
# (async tests run under pytest-asyncio asyncio_mode=auto — no decorator needed.)










