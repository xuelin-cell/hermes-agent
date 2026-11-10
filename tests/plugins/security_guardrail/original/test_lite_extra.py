"""Tests for Windows command syntax baseline rules."""
from __future__ import annotations

import pytest

from _guardrail_migrated.guardrail.engine import check_permissions
from _guardrail_migrated.guardrail.types import BuildProfile, DecisionBehavior, PermissionMode, ToolCallOrigin


@pytest.mark.parametrize(
    "command",
    [
        r"format C:",
        r"bcdedit /set bootmgr displayorder {default}",
        r"diskpart /s script.txt",
        r"cipher /w:C:\Users\alice",
        "Clear-Disk -Number 1 -RemoveData",
        "Format-Volume -DriveLetter D",
        "Stop-Computer -Force",
        "Restart-Computer -Force",
    ],
)
def test_lite_extra_terminal_denies_windows_host_destruction(command: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": command},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.LITE,
        mode=PermissionMode.AUTO,
        user_rules=[],
        session_rules=[],
    )

    assert decision.behavior == DecisionBehavior.DENY


@pytest.mark.parametrize(
    "command",
    [
        r"cipher /w:C:\Users\alice",
        "Clear-Disk -Number 1 -RemoveData",
        "Format-Volume -DriveLetter D",
        "Stop-Computer -Force",
    ],
)
def test_windows_terminal_rules_also_apply_to_pro(command: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": command},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.PRO,
        mode=PermissionMode.AUTO,
        user_rules=[],
        session_rules=[],
    )

    assert decision.behavior == DecisionBehavior.DENY


@pytest.mark.parametrize(
    "command",
    [
        "echo 'format C:'",
        "Write-Output 'Stop-Computer -Force'",
        "grep bcdedit install.log",
    ],
)
def test_lite_extra_terminal_denies_do_not_match_plain_text(command: str) -> None:
    decision = check_permissions(
        tool_name="Bash",
        tool_input={"command": command},
        origin=ToolCallOrigin(kind="agent"),
        profile=BuildProfile.LITE,
        mode=PermissionMode.AUTO,
        user_rules=[],
        session_rules=[],
    )

    assert decision.behavior == DecisionBehavior.ALLOW
