"""Network attack and abuse shell detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from urllib.parse import unquote

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _CMDPOS
from .profile import profile_shell_command
from ...shell_syntax import analyze_shell_text
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction


_NETWORK_ATTACK_RE = re.compile(
    _CMDPOS
    + r"(?:aircrack-ng|crackmapexec|dirsearch|ettercap|feroxbuster|ffuf|gobuster|hping3|hydra|masscan|medusa|"
    r"msfconsole|naabu|netexec|nikto|nmap|nuclei|responder|rustscan|sqlmap|testssl|wpscan|zmap)"
    r"(?=$|[\s;|&\n])",
    re.IGNORECASE,
)


_NETWORK_ATTACK_TERMINAL_RE = re.compile(
    _CMDPOS + r"(?:masscan\b[^\n;|&]*(?:0\.0\.0\.0/0|--rate=\d{4,})|"
    r"sqlmap\b[^\n;|&]*\s--dump\b|"
    r"hydra\b[^\n;|&]*(?:ssh://|\b-P\b))",
    re.IGNORECASE,
)


_CURL_SQL_INJECTION_RE = re.compile(
    r"(?:\bunion\s+(?:all\s+)?select\b|"
    r"\border\s+by\s+\d+\s*(?:--|#)|"
    r"\b(?:or|and)\s+(?:\d+|'[^']*')\s*=\s*(?:\d+|'[^']*')(?:\s|--|#|$)|"
    r";\s*(?:select|insert|update|delete|drop|create|alter)\b)",
    re.IGNORECASE,
)
_CURL_COMMAND_RE = re.compile(
    _CMDPOS + r"curl(?:\.exe)?\b(?P<args>(?:\"[^\"]*\"|'[^']*'|[^;\n|&])*)",
    re.IGNORECASE,
)


_NETWORK_FLOOD_TOOL_RE = re.compile(_CMDPOS + r"hping3\b(?=[^\n;|&]*--flood\b)", re.IGNORECASE)


_NETWORK_LOOP_RE = re.compile(
    r"\bfor\s+\w+\s+in\s+\$\(seq\s+(?:\d+\s+)?(?P<count>\d+)\)\s*;?\s*do\s+(?P<body>.*?)\s*;\s*done",
    re.IGNORECASE | re.DOTALL,
)


_NETWORK_REQUEST_IN_LOOP_RE = re.compile(r"\b(?:curl|wget|ab|hping3|nc|ncat)\b|https?://", re.IGNORECASE)


_NETWORK_LOOP_FLOOD_MIN = 10_000


def detect_network_flood(action: RuntimeAction) -> BaselineResult:
    """Deny high-confidence network flood patterns."""
    command = action.normalized_payload
    if _NETWORK_FLOOD_TOOL_RE.search(command) or _has_large_network_loop(command):
        return result_for(terminal_rules.NETWORK_FLOOD, action, rule_content="network_flood")
    return BaselineResult.no_signal()


def detect_network_attack_terminal(action: RuntimeAction) -> BaselineResult:
    """Deny high-confidence unauthorized attack and broad scan commands."""
    executable_command = analyze_shell_text(action.normalized_payload).executable_text
    if _NETWORK_ATTACK_TERMINAL_RE.search(executable_command) or _is_curl_sql_injection(action):
        return result_for(terminal_rules.NETWORK_ATTACK_TERMINAL, action, rule_content="network_attack_terminal")
    return BaselineResult.no_signal()


def detect_network_attack_tool(action: RuntimeAction) -> BaselineResult:
    """Detect network scanning, flooding, cracking, and exploitation tools."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    attack_invocations = tuple(
        invocation
        for invocation in profile_shell_command(action.normalized_payload).invocations
        if invocation.canonical_name
        in {
            "aircrack-ng",
            "crackmapexec",
            "dirsearch",
            "ettercap",
            "feroxbuster",
            "ffuf",
            "gobuster",
            "hping3",
            "hydra",
            "masscan",
            "medusa",
            "msfconsole",
            "naabu",
            "netexec",
            "nikto",
            "nmap",
            "nuclei",
            "responder",
            "rustscan",
            "sqlmap",
            "testssl",
            "wpscan",
            "zmap",
        }
    )
    if attack_invocations:
        if all(
            _is_nmap_metadata_query(invocation.canonical_name, invocation.command_args)
            or _is_safe_loopback_nmap(invocation.canonical_name, invocation.command_args)
            for invocation in attack_invocations
        ):
            return BaselineResult.no_signal()
        return result_for(ask_rules.NETWORK_ATTACK_TOOL, action)
    if _NETWORK_ATTACK_RE.search(analyze_shell_text(action.normalized_payload).executable_text):
        return result_for(ask_rules.NETWORK_ATTACK_TOOL, action)
    return BaselineResult.no_signal()


def _is_nmap_metadata_query(command: str, args: tuple[str, ...]) -> bool:
    """Exempt only a standalone metadata flag, never target/scan combinations."""
    return command == "nmap" and args in {("--help",), ("--version",)}


def _is_safe_loopback_nmap(command: str, args: tuple[str, ...]) -> bool:
    if command != "nmap" or any(arg.casefold() in {"-a", "-o", "-sc", "--script", "-p-"} for arg in args):
        return False
    targets: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {"-oA", "-oG", "-oN", "-oS", "-oX"} or arg.casefold() in {
            "--data-length",
            "--dns-servers",
            "--exclude",
            "--excludefile",
            "--host-timeout",
            "--max-rate",
            "--max-retries",
            "--min-rate",
            "--scan-delay",
            "--script-args",
            "--source-port",
            "--stylesheet",
            "--top-ports",
            "-e",
            "-p",
        }:
            index += 2
            continue
        if not arg.startswith("-"):
            targets.append(arg.casefold())
        index += 1
    return bool(targets) and all(
        target in {"::1", "[::1]", "localhost", "localhost.localdomain"} or target.startswith("127.")
        for target in targets
    )


def _has_large_network_loop(command: str) -> bool:
    for match in _NETWORK_LOOP_RE.finditer(command):
        count = int(match.group("count"))
        if count >= _NETWORK_LOOP_FLOOD_MIN and _NETWORK_REQUEST_IN_LOOP_RE.search(match.group("body")):
            return True
    return False


def _is_curl_sql_injection(action: RuntimeAction) -> bool:
    for match in _CURL_COMMAND_RE.finditer(action.normalized_payload):
        decoded_arguments = unquote(match.group("args")).replace("+", " ")
        if _CURL_SQL_INJECTION_RE.search(decoded_arguments):
            return True
    return False
