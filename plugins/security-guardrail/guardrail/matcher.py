"""Wildcard / prefix / exact matching for shell-tool rules.

Ported from Claude Code's ``shellRuleMatching.ts``.  Three rule shapes:

* **exact**:    ``"git add file.txt"``        → command must equal this string
* **prefix**:   ``"npm:*"``                   → legacy syntax, command starts with ``"npm "`` (or equals ``"npm"``)
* **wildcard**: ``"git *"`` or ``"python*.py"`` → glob-style, ``*`` matches any chars

Escapes: ``\\*`` matches a literal asterisk; ``\\\\`` matches a literal backslash.

Performance: pre-compile patterns to regex once at rule registration; runtime
match is a single ``re.fullmatch`` per rule.  ~1µs per rule on commodity hardware.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


# Sentinel placeholders for escape handling — same trick as the TS code.
_ESC_STAR = "\x00ESC_STAR\x00"
_ESC_BSLASH = "\x00ESC_BSLASH\x00"


@dataclass(frozen=True)
class _CompiledRule:
    pattern: str
    regex: re.Pattern[str]
    case_insensitive: bool


def _compile_wildcard(pattern: str, *, case_insensitive: bool = False) -> re.Pattern[str]:
    """Convert a wildcard pattern to a fullmatch regex."""
    p = pattern.strip()

    # 1. Replace escape sequences with sentinels so they survive the
    #    wildcard expansion below.
    out: list[str] = []
    i = 0
    while i < len(p):
        c = p[i]
        if c == "\\" and i + 1 < len(p):
            nxt = p[i + 1]
            if nxt == "*":
                out.append(_ESC_STAR)
                i += 2
                continue
            if nxt == "\\":
                out.append(_ESC_BSLASH)
                i += 2
                continue
        out.append(c)
        i += 1
    processed = "".join(out)

    # 2. Escape regex metachars EXCEPT '*'.
    escaped_parts: list[str] = []
    for ch in processed:
        if ch == "*":
            escaped_parts.append(".*")
        else:
            escaped_parts.append(re.escape(ch))
    body = "".join(escaped_parts)

    # 3. Restore escape sentinels as literal regex.
    body = body.replace(re.escape(_ESC_STAR), r"\*")
    body = body.replace(re.escape(_ESC_BSLASH), r"\\")

    flags = re.IGNORECASE | re.DOTALL if case_insensitive else re.DOTALL
    return re.compile(f"^{body}$", flags)


def compile_rule(pattern: str, *, case_insensitive: bool = False) -> _CompiledRule:
    """Compile a rule pattern.  Auto-detects exact / prefix / wildcard shape."""
    p = pattern.strip()

    # Legacy ``foo:*`` prefix syntax → wildcard equivalent ``foo *|foo``.
    # We compile to a single regex that matches both (with optional space).
    if p.endswith(":*") and len(p) > 2:
        prefix = p[:-2]
        # Prefix matches either exact (``npm``) or prefix-with-space (``npm install``).
        flags = re.IGNORECASE | re.DOTALL if case_insensitive else re.DOTALL
        regex = re.compile(rf"^{re.escape(prefix)}(\s.*)?$", flags)
        return _CompiledRule(pattern=p, regex=regex, case_insensitive=case_insensitive)

    return _CompiledRule(
        pattern=p,
        regex=_compile_wildcard(p, case_insensitive=case_insensitive),
        case_insensitive=case_insensitive,
    )


def match(compiled: _CompiledRule, command: str) -> bool:
    """Test a command against a compiled rule."""
    return compiled.regex.fullmatch(command.strip()) is not None


def matches_pattern(pattern: str, command: str, *, case_insensitive: bool = False) -> bool:
    """One-shot helper for tests / one-off callers.  Don't use on hot paths
    (compile every call).  Use ``compile_rule`` + ``match`` instead."""
    return match(compile_rule(pattern, case_insensitive=case_insensitive), command)


# ── Path-glob (FileWrite/FileEdit rule_content) ──────────────────────────
# Slightly different from shell wildcard: ``**`` recursively matches dirs,
# ``*`` matches single segment.  Mirrors ignore() / fnmatch semantics.

def compile_path_glob(pattern: str) -> re.Pattern[str]:
    """Compile a path glob (``foo/**/*.txt``) for matching file paths.

    Path comparison is case-insensitive on Windows, sensitive on Unix —
    but we always lowercase here for safety (mounting same path twice
    via different casing should still match).
    """
    p = pattern.strip().replace("\\", "/")
    # Order matters: handle `**` before `*` so we don't double-substitute.
    body = []
    i = 0
    while i < len(p):
        if p[i : i + 3] == "**/":
            body.append("(.*/)?")
            i += 3
        elif p[i : i + 2] == "**":
            body.append(".*")
            i += 2
        elif p[i] == "*":
            body.append("[^/]*")
            i += 1
        elif p[i] == "?":
            body.append("[^/]")
            i += 1
        else:
            body.append(re.escape(p[i]))
            i += 1
    return re.compile(f"^{''.join(body)}$", re.IGNORECASE | re.DOTALL)


def matches_path(pattern: str, path: str) -> bool:
    """Test a file path against a glob pattern (case-insensitive, /-normalized)."""
    return compile_path_glob(pattern).fullmatch(path.replace("\\", "/").strip()) is not None
