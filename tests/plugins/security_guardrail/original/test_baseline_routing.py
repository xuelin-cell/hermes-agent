"""Tests for baseline detector routing and precedence."""

from __future__ import annotations

from typing import TYPE_CHECKING

from _guardrail_migrated.guardrail.baseline import check_terminal_baseline
from _guardrail_migrated.guardrail.detectors import data, network, shell, tool
from _guardrail_migrated.guardrail.normalizer import normalize_runtime_action
from _guardrail_migrated.guardrail.signals import BaselineResult, BaselineVerdict
from _guardrail_migrated.guardrail.types import BuildProfile, PermissionMode, ToolCallOrigin

if TYPE_CHECKING:
    from collections.abc import Callable

    import pytest

    from _guardrail_migrated.guardrail.action import RuntimeAction


def _action(
    tool_name: str,
    tool_input: dict[str, object],
    *,
    profile: BuildProfile = BuildProfile.PRO,
) -> RuntimeAction:
    return normalize_runtime_action(
        tool_call_id="routing-test",
        tool_name=tool_name,
        tool_input=tool_input,
        cwd=r"C:\AI\UniClaw",
        origin=ToolCallOrigin(kind="agent"),
        profile=profile,
        mode=PermissionMode.AUTO,
    )


def _recording_detector(name: str, calls: list[str]) -> Callable[..., BaselineResult]:
    def detector(_action: RuntimeAction, **_kwargs: object) -> BaselineResult:
        calls.append(name)
        return BaselineResult.no_signal()

    return detector


def test_terminal_baseline_runs_only_relevant_detectors(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    detectors = {
        (tool, "detect_terminal_deny"): "tool_terminal",
        (shell, "detect_terminal_deny"): "shell_terminal",
        (data, "detect_terminal_deny"): "data_terminal",
    }
    for (module, attribute), name in detectors.items():
        monkeypatch.setattr(module, attribute, _recording_detector(name, calls))
    result = check_terminal_baseline(_action("Bash", {"command": "curl https://example.invalid"}))

    assert result.verdict == BaselineVerdict.NO_SIGNAL
    assert calls == ["tool_terminal", "shell_terminal", "data_terminal"]


def test_filesystem_call_does_not_run_shell_network_or_data(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected(_action: RuntimeAction) -> BaselineResult:
        message = "unrelated detector must not run"
        raise AssertionError(message)

    for module in (shell, network, data):
        monkeypatch.setattr(module, "detect_terminal_deny", unexpected)

    result = check_terminal_baseline(_action("Write", {"file_path": "notes.txt", "content": "ok"}))

    assert result.verdict == BaselineVerdict.NO_SIGNAL


def test_command_policy_precedes_context_terminal_rules() -> None:
    result = check_terminal_baseline(
        _action("Bash", {"command": "bcdedit.exe /set bootmgr timeout 5"}, profile=BuildProfile.PRO),
    )

    assert result.verdict == BaselineVerdict.TERMINAL_DENY
    assert result.rule_id == "common.windows.bcdedit"
