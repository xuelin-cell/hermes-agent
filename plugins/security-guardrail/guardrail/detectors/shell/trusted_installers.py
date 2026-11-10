"""Strict catalog for official remote bootstrap installers."""

from __future__ import annotations

from ...runtime import execution_environment

import re
import shlex
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from ...action import RuntimeAction


class InstallerFlow(str, Enum):
    """Supported download-and-execute command shapes."""

    POSIX_SHELL = "posix_shell"
    POSIX_PYTHON = "posix_python"
    POWERSHELL_EXPRESSION = "powershell_expression"
    POWERSHELL_PYTHON = "powershell_python"


@dataclass(frozen=True)
class TrustedInstallerEndpoint:
    """One exact host/path/runner combination."""

    path_pattern: re.Pattern[str]
    flows: frozenset[InstallerFlow]


@dataclass(frozen=True)
class TrustedInstallerSpec:
    """Declarative policy for one official installer publisher."""

    installer_id: str
    hosts: frozenset[str]
    endpoints: tuple[TrustedInstallerEndpoint, ...]


@dataclass(frozen=True)
class TrustedInstallerMatch:
    """Canonical trusted-installer match returned to guardrail detectors."""

    installer_id: str
    url: str


@dataclass(frozen=True)
class _InstallerCandidate:
    url: str
    host: str
    path: str
    flow: InstallerFlow


_REMOTE_URL_RE = re.compile(r"https?://[^\s'\"`|;()<>]+", re.IGNORECASE)
_OUTPUT_SUFFIX_RE = re.compile(r"\s+2>&1(?:\s*\|\s*tail\s+(?:-\d+|-n\s+\d+))?\s*$", re.IGNORECASE)
_POWERSHELL_WRAPPER_RE = re.compile(
    r"^\s*(?:powershell|pwsh)(?:\.exe)?"
    r"(?:\s+-ExecutionPolicy\s+Bypass)?"
    r"\s+-(?:c|Command)\s+"
    r"(?P<quote>['\"])(?P<payload>.*)(?P=quote)\s*$",
    re.IGNORECASE,
)
_POWERSHELL_PYTHON_RE = re.compile(
    r"^\(\s*(?P<fetch>.+?)\s*\)\.Content\s*\|\s*(?:py|python|python3)\s+-$",
    re.IGNORECASE,
)
_POWERSHELL_TOOLS = frozenset({"powershell", "powershell.exe", "pwsh", "pwsh.exe"})
_POWERSHELL_FETCHERS = frozenset({"irm", "invoke-restmethod", "iwr", "invoke-webrequest"})
_POWERSHELL_FETCH_OPTIONS = frozenset({"-useb", "-usebasicparsing"})
_POWERSHELL_RUNNERS = frozenset({"iex", "invoke-expression"})
_CURL_LONG_FLAGS = frozenset({"--fail", "--location", "--show-error", "--silent", "--tlsv1.2"})
_WGET_FLAGS = frozenset({"-q", "-qO-", "-O-", "--quiet", "--output-document=-"})
_PIPE_PARTS = 2


def _endpoint(path_pattern: str, *flows: InstallerFlow) -> TrustedInstallerEndpoint:
    return TrustedInstallerEndpoint(re.compile(rf"^(?:{path_pattern})$"), frozenset(flows))


TRUSTED_INSTALLERS: tuple[TrustedInstallerSpec, ...] = (
    TrustedInstallerSpec(
        "uv",
        frozenset({"astral.sh"}),
        (
            _endpoint(r"/uv/(?:\d+\.\d+\.\d+/)?install\.sh", InstallerFlow.POSIX_SHELL),
            _endpoint(r"/uv/(?:\d+\.\d+\.\d+/)?install\.ps1", InstallerFlow.POWERSHELL_EXPRESSION),
        ),
    ),
    TrustedInstallerSpec(
        "deno",
        frozenset({"deno.land"}),
        (
            _endpoint(r"/install\.sh", InstallerFlow.POSIX_SHELL),
            _endpoint(r"/install\.ps1", InstallerFlow.POWERSHELL_EXPRESSION),
        ),
    ),
    TrustedInstallerSpec(
        "pnpm",
        frozenset({"get.pnpm.io"}),
        (
            _endpoint(r"/install\.sh", InstallerFlow.POSIX_SHELL),
            _endpoint(r"/install\.ps1", InstallerFlow.POWERSHELL_EXPRESSION),
        ),
    ),
    TrustedInstallerSpec(
        "bun",
        frozenset({"bun.com", "bun.sh"}),
        (
            _endpoint(r"/install", InstallerFlow.POSIX_SHELL),
            _endpoint(r"/install\.ps1", InstallerFlow.POWERSHELL_EXPRESSION),
        ),
    ),
    TrustedInstallerSpec(
        "pixi",
        frozenset({"pixi.sh"}),
        (
            _endpoint(r"/install\.sh", InstallerFlow.POSIX_SHELL),
            _endpoint(r"/install\.ps1", InstallerFlow.POWERSHELL_EXPRESSION),
        ),
    ),
    TrustedInstallerSpec(
        "dotnet",
        frozenset({"dot.net"}),
        (
            _endpoint(r"/v1/dotnet-install\.sh", InstallerFlow.POSIX_SHELL),
            _endpoint(r"/v1/dotnet-install\.ps1", InstallerFlow.POWERSHELL_EXPRESSION),
        ),
    ),
    TrustedInstallerSpec(
        "poetry",
        frozenset({"install.python-poetry.org"}),
        (_endpoint(r"/", InstallerFlow.POSIX_PYTHON, InstallerFlow.POWERSHELL_PYTHON),),
    ),
    TrustedInstallerSpec(
        "rustup",
        frozenset({"sh.rustup.rs"}),
        (_endpoint(r"/", InstallerFlow.POSIX_SHELL),),
    ),
    TrustedInstallerSpec(
        "mise",
        frozenset({"mise.run"}),
        (_endpoint(r"/", InstallerFlow.POSIX_SHELL),),
    ),
    TrustedInstallerSpec(
        "volta",
        frozenset({"get.volta.sh"}),
        (_endpoint(r"/", InstallerFlow.POSIX_SHELL),),
    ),
)


def match_trusted_installer(action: RuntimeAction) -> TrustedInstallerMatch | None:
    """Return an exact official-installer match without bypassing other rules."""
    if not execution_environment().product_exemptions:
        return None
    if "https://" not in action.normalized_payload.casefold():
        return None
    candidate = _parse_candidate(action)
    if candidate is None:
        return None
    for spec in TRUSTED_INSTALLERS:
        if candidate.host not in spec.hosts:
            continue
        if any(endpoint.path_pattern.fullmatch(candidate.path) and candidate.flow in endpoint.flows for endpoint in spec.endpoints):
            return TrustedInstallerMatch(spec.installer_id, candidate.url)
    return None


def _parse_candidate(action: RuntimeAction) -> _InstallerCandidate | None:
    command = _strip_output_suffix(action.normalized_payload)
    urls = _REMOTE_URL_RE.findall(command)
    if len(urls) != 1:
        return None
    canonical = _canonical_installer_url(urls[0])
    if canonical is None:
        return None
    host, path = canonical

    wrapper = _POWERSHELL_WRAPPER_RE.fullmatch(command)
    payload = wrapper.group("payload") if wrapper is not None else command
    flow = _parse_powershell_flow(payload, urls[0]) if wrapper is not None or action.tool_name.casefold() in _POWERSHELL_TOOLS else None
    if flow is None and wrapper is None:
        flow = _parse_posix_flow(command, urls[0])
    if flow is None:
        return None
    return _InstallerCandidate(urls[0], host, path, flow)


def _strip_output_suffix(command: str) -> str:
    suffix = _OUTPUT_SUFFIX_RE.search(command)
    return command[: suffix.start()].strip() if suffix is not None else command.strip()


def _canonical_installer_url(url: str) -> tuple[str, str] | None:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    path = parsed.path or "/"
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or parsed.query
        or parsed.fragment
        or "%" in path
        or "\\" in path
        or "//" in path
        or any(segment == ".." for segment in path.split("/"))
    ):
        return None
    return parsed.hostname.casefold(), path


def _parse_posix_flow(command: str, url: str) -> InstallerFlow | None:
    parts = command.split("|")
    if len(parts) != _PIPE_PARTS or not _valid_posix_fetch(parts[0], url):
        return None
    try:
        runner = tuple(token.casefold() for token in shlex.split(parts[1]))
    except ValueError:
        return None
    if runner in {("sh",), ("bash",), ("sh", "-"), ("bash", "-")}:
        return InstallerFlow.POSIX_SHELL
    if runner in {("py", "-"), ("python", "-"), ("python3", "-")}:
        return InstallerFlow.POSIX_PYTHON
    return None


def _valid_posix_fetch(fetch: str, url: str) -> bool:
    try:
        tokens = shlex.split(fetch)
    except ValueError:
        return False
    if tokens.count(url) != 1:
        return False
    if tokens[0].casefold() == "curl":
        return _valid_curl_tokens(tokens, url)
    if tokens[0].casefold() == "wget":
        return _valid_wget_tokens(tokens, url)
    return False


def _valid_curl_tokens(tokens: list[str], url: str) -> bool:
    index = 1
    while index < len(tokens):
        argument = tokens[index]
        if argument == url:
            index += 1
            continue
        if argument.startswith("-") and not argument.startswith("--") and argument != "-":
            if not set(argument[1:]) <= set("fsSL"):
                return False
            index += 1
            continue
        lowered = argument.casefold()
        if lowered in _CURL_LONG_FLAGS:
            index += 1
            continue
        if lowered == "--proto" and index + 1 < len(tokens) and tokens[index + 1].casefold() == "=https":
            index += 2
            continue
        if lowered == "--proto=https":
            index += 1
            continue
        return False
    return True


def _valid_wget_tokens(tokens: list[str], url: str) -> bool:
    options = [token for token in tokens[1:] if token != url]
    writes_to_stdout = any(option in {"-qO-", "-O-", "--output-document=-"} for option in options)
    return writes_to_stdout and all(option in _WGET_FLAGS for option in options)


def _parse_powershell_flow(payload: str, url: str) -> InstallerFlow | None:
    python_match = _POWERSHELL_PYTHON_RE.fullmatch(payload.strip())
    if python_match is not None and _valid_powershell_fetch(python_match.group("fetch"), url):
        return InstallerFlow.POWERSHELL_PYTHON

    parts = payload.split("|")
    if len(parts) != _PIPE_PARTS or parts[1].strip().casefold() not in _POWERSHELL_RUNNERS:
        return None
    if _valid_powershell_fetch(parts[0], url):
        return InstallerFlow.POWERSHELL_EXPRESSION
    return None


def _valid_powershell_fetch(fetch: str, url: str) -> bool:
    tokens = [argument.strip("'\"") for argument in fetch.split()]
    if not tokens or tokens[0].casefold() not in _POWERSHELL_FETCHERS or tokens.count(url) != 1:
        return False
    index = 1
    while index < len(tokens):
        argument = tokens[index]
        if argument == url or argument.casefold() in _POWERSHELL_FETCH_OPTIONS:
            index += 1
            continue
        if argument.casefold() == "-uri" and index + 1 < len(tokens) and tokens[index + 1] == url:
            index += 2
            continue
        return False
    return True
