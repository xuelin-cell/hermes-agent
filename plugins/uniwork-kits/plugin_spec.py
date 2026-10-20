# Vendored verbatim from UniClaw libs/hexagent_demo/backend/hexagent_api/plugin_spec.py
# (feat/plugin @ 14314c7f). Pure stdlib + PyYAML; keep in sync by re-copying,
# not by editing here. Hermes-side changes to carry over when re-copying:
# - import yaml reads yaml_compat so the module also runs where Hermes ships
#   ruamel instead;
# - _split_command_frontmatter keeps the whole body. Upstream kept only the
#   text after a second ``---`` line, so a command whose body has a Markdown
#   rule lost everything before it (ppt-writer's create-ppt lost its steps).
"""Plugin manifest (``plugin.json``) parsing and validation.

A plugin is a zip package that aggregates existing primitives — skills
today (P0), agents/MCP servers later (P1) — under one installable unit
with a namespace.  The manifest declares the plugin's identity; the
components themselves are discovered by directory convention
(``skills/<skill>/SKILL.md``), mirroring Claude Code's plugin layout so
that manifests never enumerate components (one less drift source).

Lenient validation philosophy (same as :mod:`hexagent.harness.skill_spec`):

- **Must have**: ``name``, ``version``, ``description`` (non-empty after
  ``str()``).
- **Best-effort**: everything else is accepted and coerced where possible.
- ``hooks`` / ``commands`` are reserved fields: their presence produces an
  install-time *warning* (returned to the caller for the UI), never a
  rejection — packages authored for a future version still install.

Naming: the plugin ``name`` becomes the namespace prefix for every
component (``<plugin>:<skill>`` in the skill registry, ``<plugin>--<skill>``
as the on-disk directory — ``:`` is illegal in Windows file names, so the
colon lives only in frontmatter/registry names, never in paths).

This module lives in the demo layer on purpose: the core library stays
plugin-unaware (plugins decompose into core primitives at install time).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from . import yaml_compat as yaml  # Hermes-side swap: hermes_yaml (ruamel) or PyYAML

logger = logging.getLogger(__name__)


class PluginSpecError(Exception):
    """Raised when plugin.json is missing required fields or unparsable."""


def read_pkg_text(path: Path) -> str:
    """Read a third-party package text file, tolerating a UTF-8 BOM.

    The single boundary for reading *any* file that came from a plugin/skill
    package (manifest, ``SKILL.md``, ``agents/*.md``, ``mcp.json``, …).  Windows
    editors (Notepad and friends) routinely save UTF-8 **with** a BOM; reading
    such a file as plain ``utf-8`` leaves a leading ``﻿`` that breaks
    ``json.loads`` and frontmatter delimiter matching, so a package authored on
    Windows would fail to install for a reason that has nothing to do with its
    content.  ``utf-8-sig`` strips a leading BOM if present and is identical to
    ``utf-8`` when it is absent.  Use this everywhere package bytes are decoded
    to text so the tolerance is a property of the *boundary*, not of each caller
    remembering to opt in.
    """
    return path.read_text(encoding="utf-8-sig")


# Separator between plugin namespace and component name in registry names.
# Matches Claude Code's ``plugin:command`` convention.  hexagent's
# ``validate_skill_name`` (skill_spec.py) accepts any charset, so the colon
# is legal in frontmatter names.
NAMESPACE_SEP = ":"

# Separator used for on-disk (host + guest) directory names, where ``:``
# would break Windows hosts.  ``<plugin>--<skill>`` keeps the flattened
# layout at two levels so the core resolver's ``find -maxdepth 2`` and the
# demo bootstrap's one-level ``iterdir()`` both see plugin skills without
# any core changes.
DIR_SEP = "--"

# Separator inside an MCP server's registry key.  A plugin server registers
# as ``plugin_<plugin>_<server>`` so the core tool-name synthesis
# (``mcp__{server_key}__{tool}`` in hexagent/mcp/_client.py) yields
# ``mcp__plugin_<plugin>_<server>__<tool>`` — byte-identical to Claude Code's
# plugin MCP tool names — with zero core changes.  Underscore (not ``:``/``--``)
# because MCP tool names are ``[a-z0-9_]`` by convention and the ``__`` field
# delimiter must stay unambiguous.
MCP_KEY_SEP = "_"

# Candidate filenames for a plugin's MCP manifest, in priority order.
# ``.mcp.json`` matches Claude Code's on-disk name; ``mcp.json`` is the
# convention documented for UniClaw packages.  Either is accepted so a
# Claude-Code-authored package installs unchanged.
MCP_MANIFEST_NAMES = ("mcp.json", ".mcp.json")

# Anthropic tool-name charset.  A plugin MCP server's name — and the plugin
# name that prefixes it — become segments of ``mcp__plugin_<plugin>_<server>__<tool>``,
# so both must stay within ``[A-Za-z0-9_-]`` (unlike skill names, which are
# invoked by an arbitrary-charset string and may be e.g. Chinese).
TOOLNAME_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Recognized credential-resolution strategies for a plugin MCP server.
# P1 ships ``none``/``static`` only; ``oauth`` is reserved so adding the
# OAuth flow in P2 is a new enum value + a new branch at the single
# credential-resolution point (agent_manager), never a schema change here.
MCP_AUTH_MODES = ("none", "static", "oauth")
_DEFAULT_MCP_AUTH = "static"

# Keep in sync with ``_NAME_MAX_LEN`` in hexagent/harness/skill_spec.py:
# the *prefixed* skill name (``<plugin>:<skill>``) must still pass
# ``validate_skill_name`` when it is registered.
PREFIXED_NAME_MAX_LEN = 64

# Windows-illegal filename characters (plus path separators).  The plugin
# name doubles as a directory-name component on the host, so it must be
# filesystem-safe on every platform we ship to.
_ILLEGAL_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_PLUGIN_NAME_MAX_LEN = 48  # leaves ≥15 chars of budget for skill names


def _empty_requires() -> dict[str, list[str]]:
    return {"commands": [], "env_keys": []}


# Template used in an MCP server's env/headers to reference a user-filled
# config value: ``${user_config.<KEY>}``.  Expanded at connect time from the
# OS credential vault (see AgentManager._resolve_plugin_mcp_credentials),
# mirroring Claude Desktop DXT's ``${user_config.*}`` substitution.
_USER_CONFIG_REF_RE = re.compile(r"\$\{user_config\.([A-Za-z0-9_]+)\}")

# A user_config key must be a plain identifier — it becomes an env var name
# and a credential-vault target segment.
_USER_CONFIG_KEY_RE = re.compile(r"^[A-Za-z0-9_]+$")

# MCPB user_config field types (Claude Desktop MANIFEST.md). Anything else is
# coerced to "string" (the frontend renders string/number/boolean/dir/file).
_USER_CONFIG_TYPES = ("string", "number", "boolean", "directory", "file")

# Market-facing persona fields carried verbatim off an expert's ``plugin.json``
# (CodeBuddy / WorkBuddy).  These drive the expert card / foreground view; they
# live in the MANIFEST, never in ``agents/*.md`` (verified against real packages).
_MANIFEST_PERSONA_KEYS = (
    "displayName",
    "profession",
    "displayDescription",
    "avatar",
    "categoryId",
    "defaultInitPrompt",
    "quickPrompts",
    "tags",
)


@dataclass(frozen=True)
class PluginManifest:
    """Validated ``plugin.json`` fields.

    Attributes:
        name: Plugin identifier; namespace prefix for every component.
        version: Display/upgrade-comparison string (not enforced semver).
        description: What the plugin provides.
        author: Optional author display string.
        requires: Declared environment dependencies, normalized to
            ``{"commands": [...], "env_keys": [...]}``.  Purely advisory:
            missing dependencies are *reported* (card/detail/toast), never
            block install or enable — the agent can usually self-install at
            runtime, and plugins that declare nothing skip checking entirely.
        warnings: Non-fatal validation notes (reserved fields present,
            coerced values, …) surfaced to the UI at install time.
    """

    name: str
    version: str
    description: str
    author: str = ""
    requires: dict[str, list[str]] = field(default_factory=_empty_requires)
    # Declared per-user config fields (DXT ``user_config`` shape): each is
    # ``{key, title, description, sensitive, required}``.  Values are NOT
    # stored here — the user fills them in the UI and they go to the OS
    # credential vault (see :mod:`hexagent_api.secret_store`).
    user_config: list[dict] = field(default_factory=list)
    # Expert identity (Tencent CodeBuddy / WorkBuddy).  These live in the
    # MANIFEST, never in ``agents/*.md`` — verified against real packages
    # (game-designer etc.).  ``expert_type`` is ``"agent"`` or ``"team"``;
    # ``agent_name`` names which entry in ``agents/`` is the foreground lead;
    # ``persona`` carries the market-facing display fields (see
    # ``_MANIFEST_PERSONA_KEYS``).  ``None``/empty for ordinary plugins (Claude
    # Code, Codex, and most CodeBuddy teams/official packages).
    expert_type: str | None = None
    agent_name: str | None = None
    persona: dict = field(default_factory=dict)
    # MCP servers declared INLINE in plugin.json (``mcpServers``), already
    # normalized by :func:`normalize_mcp_servers`.  Claude Code treats this as
    # equivalent to a sibling ``.mcp.json``; the installer merges both sources.
    mcp_servers: list[dict] = field(default_factory=list)
    # ``mcpServers`` given as a path (string) or a list of paths -- external
    # manifests relative to the package root.  Resolved by the installer (this
    # parser only sees text, not the package).  Empty when absent or inline.
    mcp_manifest_paths: list[str] = field(default_factory=list)
    # Servers this runtime cannot run, each ``{"name", "reason"}``. Recorded as
    # data, not only as a warning: a warning is a toast read once at install,
    # while "why is this connector missing?" is asked later, on the detail page.
    mcp_skipped: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def validate_plugin_name(name: str) -> None:
    """Validate a plugin name for use as namespace prefix + directory stem.

    Rules (each guards a concrete failure mode):

    1. Non-empty — an empty prefix would produce ``:skill`` names.
    2. ≤ 48 chars — leaves room inside the 64-char skill-name budget for
       ``:<skill>`` after prefixing.
    3. No filesystem-illegal characters — the name becomes part of the
       host directory ``<plugin>--<skill>`` (Windows rejects ``: < > …``).
    4. Must not contain the namespace separator ``:`` or directory
       separator ``--`` — either would make ``<plugin>:<skill>`` /
       ``<plugin>--<skill>`` ambiguous to split back apart.
    5. No leading dot — dot-dirs are skipped by the skill listers.

    Raises:
        PluginSpecError: If any rule is violated.
    """
    if not name or not name.strip():
        msg = "插件名不能为空"
        raise PluginSpecError(msg)
    if len(name) > _PLUGIN_NAME_MAX_LEN:
        msg = f"Plugin name must be at most {_PLUGIN_NAME_MAX_LEN} characters, got {len(name)}"
        raise PluginSpecError(msg)
    if _ILLEGAL_NAME_CHARS.search(name):
        msg = f"插件名含有不能作为文件夹名的字符:{name!r}"
        raise PluginSpecError(msg)
    if NAMESPACE_SEP in name or DIR_SEP in name:
        msg = f"Plugin name must not contain {NAMESPACE_SEP!r} or {DIR_SEP!r}: {name!r}"
        raise PluginSpecError(msg)
    if name.startswith(".") or name in (".", ".."):
        msg = f"插件名不能以点开头:{name!r}"
        raise PluginSpecError(msg)


def prefixed_skill_name(plugin_name: str, skill_name: str) -> str:
    """Registry name for a plugin-owned skill: ``<plugin>:<skill>``.

    Raises:
        PluginSpecError: If the combined name exceeds the 64-char budget
            enforced by ``validate_skill_name`` at registration.
    """
    combined = f"{plugin_name}{NAMESPACE_SEP}{skill_name}"
    if len(combined) > PREFIXED_NAME_MAX_LEN:
        msg = (
            f"Prefixed skill name exceeds {PREFIXED_NAME_MAX_LEN} chars: {combined!r} "
            f"(shorten the plugin or skill name)"
        )
        raise PluginSpecError(msg)
    return combined


def _drop_redundant_vendor_prefix(plugin_name: str, skill_name: str) -> str:
    """Strip a leading ``<vendor>-`` from *skill_name* that *plugin_name* repeats.

    CodeBuddy "expert" packages self-namespace their skills with the same vendor
    token the plugin name already starts with (plugin
    ``flova-anime-short-drama-director`` + skill
    ``flova-ancient-sweet-romance-drama``).  Once the plugin name is prefixed in
    front, that token is said twice — dropping it is lossless, and it is the
    cheapest way to get back under budget.

    Returns:
        The shortened skill name, or ``""`` when there is no shared prefix to
        drop (so callers can tell "nothing to do" from "dropped to empty").
    """
    head, sep, rest = skill_name.partition("-")
    if not sep or not rest:
        return ""
    if plugin_name == head or plugin_name.startswith(f"{head}-"):
        return rest
    return ""


def fit_prefixed_skill_name(
    plugin_name: str,
    skill_name: str,
    *,
    taken: set[str] | None = None,
    warnings: list[str] | None = None,
) -> str:
    """Registry name for a plugin-owned skill, shortened to fit rather than rejected.

    :func:`prefixed_skill_name` *raises* past the budget, and at the install
    site that 400s the entire package over one long name.  A real CodeBuddy
    expert package sits right on that edge: ``flova-anime-short-drama-director``
    is 32 chars and its seven skills self-namespace with ``flova-``, so one of
    them lands on 66 and the other six are lost with it.  Refusing a whole
    package over a name length is never the right trade — this shortens instead.

    Never raises on length.  Tries, in order, and returns the first that fits:

    1. the plain ``<plugin>:<skill>`` name (the overwhelmingly common case —
       no warning, no rename);
    2. :func:`_drop_redundant_vendor_prefix` — lossless, keeps the name readable;
    3. truncation with a ``-<hash>`` suffix derived from the *original* skill
       name, so the result is stable across reinstalls and two different long
       names cannot collapse onto each other.

    Steps 2 and 3 consult *taken* so a shortened name cannot land on one already
    assigned in this package.  Step 1 deliberately does not: an exact duplicate
    is a genuine authoring error the caller reports explicitly, and silently
    renaming it would hide that.

    Idempotent with :func:`strip_own_namespace`: a package re-zipped from an
    installed copy carries the already-fitted name, which step 1 returns
    unchanged.

    Args:
        plugin_name: The owning plugin's name (already validated, ≤48 chars, so
            the skill budget is always ≥15).
        skill_name: The bare skill name from ``SKILL.md`` frontmatter.
        taken: Prefixed names already assigned in this package, to avoid
            collisions introduced by shortening.
        warnings: Optional sink; a note is appended whenever a name is changed,
            naming both the original and the result.

    Returns:
        A ``<plugin>:<skill>`` name of at most
        :data:`PREFIXED_NAME_MAX_LEN` characters.
    """
    combined = f"{plugin_name}{NAMESPACE_SEP}{skill_name}"
    if len(combined) <= PREFIXED_NAME_MAX_LEN:
        return combined

    claimed = taken if taken is not None else set()
    budget = PREFIXED_NAME_MAX_LEN - len(plugin_name) - len(NAMESPACE_SEP)

    def _note(result: str) -> str:
        if warnings is not None:
            # Show only the half that changed. The full prefixed name is what
            # the registry stores, but reading it back at the user is a mouthful
            # of their own plugin name — and the plugin name is not what moved.
            shown = result.split(NAMESPACE_SEP, 1)[-1]
            warnings.append(
                f"技能「{skill_name}」的名称过长,已自动简化为「{shown}」,"
                f"功能和调用方式都不受影响。"
            )
        return result

    # 2 — the vendor prefix the plugin name already carries.
    trimmed = _drop_redundant_vendor_prefix(plugin_name, skill_name)
    if trimmed and len(trimmed) <= budget:
        candidate = f"{plugin_name}{NAMESPACE_SEP}{trimmed}"
        if candidate not in claimed:
            return _note(candidate)

    # 3 — truncate, keeping a deterministic tail so distinct names stay distinct.
    stem = trimmed or skill_name
    digest = hashlib.sha1(skill_name.encode("utf-8")).hexdigest()
    for tail in range(4, len(digest) + 1):
        suffix = f"-{digest[:tail]}"
        keep = budget - len(suffix)
        if keep < 1:
            break
        candidate = f"{plugin_name}{NAMESPACE_SEP}{stem[:keep]}{suffix}"
        if candidate not in claimed:
            return _note(candidate)

    # Unreachable in practice (budget ≥ 15 and sha1 is 40 chars), but a name is
    # still owed to the caller rather than an exception from the fallback path.
    return _note(combined[:PREFIXED_NAME_MAX_LEN])


def strip_own_namespace(plugin_name: str, skill_name: str) -> str:
    """Undo :func:`prefixed_skill_name` when a package arrives already namespaced.

    The retained package under ``PLUGINS_DIR`` is written *after* the installer's
    namespace rewrite, so its ``SKILL.md`` files carry ``<plugin>:<skill>`` rather
    than the bare name the author wrote.  Zipping that directory back up — the
    obvious way to hand an installed plugin to a colleague, and how the local test
    packages were built — produces an archive that the installer would otherwise
    reject: the ``:`` trips the path-segment guard, and the error names it an
    "illegal path character" even though it is our own separator.

    Only this plugin's *own* prefix is stripped, and only as an exact leading
    match. A colon anywhere else still fails the guard, so a genuinely unsafe
    name (``../evil``, ``a:b/c``) is unaffected.

    Args:
        plugin_name: Manifest name — the only prefix that may be stripped.
        skill_name: Frontmatter ``name`` as read from the package.

    Returns:
        The bare skill name, unchanged when it was not prefixed.
    """
    prefix = f"{plugin_name}{NAMESPACE_SEP}"
    remainder = skill_name[len(prefix) :]
    # A bare remainder is required: ``github:`` alone leaves nothing to name the
    # skill, and ``a:b:c`` would still be ambiguous after one strip.
    if skill_name.startswith(prefix) and remainder and NAMESPACE_SEP not in remainder:
        return remainder
    return skill_name


def skill_rel_path(plugin_name: str, skill_name: str) -> str:
    """Where a plugin skill lives under the plugins root: ``<plugin>/skills/<skill>``.

    The package's own shape, kept rather than flattened, because a skill's text
    is written against it: ``../../CONNECTORS.md`` for the plugin's own
    documentation, ``../<sibling>/references/…`` for another skill's reference
    material. Flattening to ``<plugin>--<skill>`` put every skill of every plugin
    in one directory and broke 33 of 129 such links — the model was being told
    to read files that were not there.

    Returned with forward slashes; ``Path / "a/b/c"`` joins them correctly on
    every platform.
    """
    return f"{plugin_name}/skills/{skill_name}"


# ── Slash commands → workflow skills ────────────────────────────────────────
# A Claude Code plugin puts its *orchestration recipe* in ``commands/*.md``:
# which subagents to launch, in what order, how to aggregate their reports.
# The subagents themselves (``agents/*.md``) are already activated, but without
# the recipe the parent agent has no idea how to drive them — it improvises a
# task, which is how a "review my changes" request turns into a review of a
# file the agent invented.
#
# This version has no slash-command surface (no ``/`` entry point, no argument
# parsing).  Building one is a large piece of work whose only *additional*
# payoff over what follows is the literal ``/name`` keystroke.  So instead of a
# second pipeline, each command is rewritten as a synthetic skill and dropped
# into the package's own ``skills/`` tree **before** the installer scans it.
# Everything downstream — namespacing, the 409 conflict gate, flattening into
# PLUGINS_FLAT_DIR, SkillTable registration, enable/disable, upgrade replace,
# uninstall cleanup — then applies unchanged, because as far as the rest of the
# system is concerned it *is* a skill.
#
# What the user loses versus a real command: typing ``/review-pr`` (natural
# language triggers it instead) and ``$ARGUMENTS`` (their actual request plays
# that role).  What they gain is the recipe, which is the part that was missing.

# Characters that cannot appear in a Windows path segment. A ``.md`` stem can
# never contain a separator, but it can still carry one of these.
_UNSAFE_COMMAND_CHARS = frozenset('<>:"/\\|?*') | {chr(c) for c in range(0x20)}

# A derived description is a summary line, not a document; the skill catalogue
# shows every entry's description at once, so an unbounded paragraph from one
# command would crowd out the rest. Well under skill_spec's own 1500 limit.
_COMMAND_DESC_MAX_LEN = 300

# ``1.`` / ``1)`` — an ordered-list item, not prose.
_ORDERED_ITEM_RE = re.compile(r"^\d+[.)]\s")

_COMMAND_BODY_PREAMBLE = (
    "> **来源**:本工作流由插件 `{plugin}` 的斜杠命令 `{command}` 转换而来。\n"
    "> 当前版本没有斜杠命令入口,请直接按下面的步骤执行。正文中出现的 `/{command}`\n"
    "> 等写法是原文保留,**不是可以输入的命令**;需要参数时以用户本轮的实际要求为准。\n"
)


def _split_command_frontmatter(raw: str) -> tuple[dict, str]:
    """Split a ``commands/*.md`` into (frontmatter mapping, body).

    Deliberately narrower than :func:`hexagent.harness.skill_spec.parse_skill_md`:
    a command file we cannot read cleanly is *skipped* by the caller, never
    repaired.  Guessing at a malformed recipe would put invented orchestration
    in front of the model, which is the exact failure this feature exists to
    remove.

    Returns ``({}, raw)`` when there is no usable frontmatter — the caller
    treats a missing ``description`` as "skip", so that path needs no special
    case here.

    Args:
        raw: Full text of the command file.

    Returns:
        The frontmatter mapping (empty when absent/unparsable) and the body.
    """
    if not raw.startswith("---"):
        return {}, raw
    # ``---\n<yaml>\n---\n<body>``: the head ends at the first ``\n---``; an
    # unterminated block yields 1 part. A later ``---`` line belongs to the body.
    parts = raw.split("\n---", 1)
    if len(parts) < 2:
        return {}, raw
    head = parts[0][3:]
    body = parts[1].lstrip("\n")
    try:
        loaded = yaml.safe_load(head)
    except yaml.YAMLError:
        return {}, body
    return (loaded if isinstance(loaded, dict) else {}), body


def _first_paragraph(body: str) -> str:
    """First prose paragraph of a Markdown body, for use as a description.

    Mirrors upstream's documented fallback ("If omitted, uses the first
    paragraph of markdown content") for a command file that ships no
    frontmatter — the common case for Figma's commands, which open with an
    ``# /command-name`` heading followed by a one-line summary.

    Headings, block quotes, list bullets and fenced code are skipped: none of
    them read as a summary, and a fence would drag syntax into the catalogue.
    Returns ``""`` when the body has no prose, which the caller treats as
    "cannot describe this, skip it".
    """
    lines: list[str] = []
    in_fence = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if not stripped:
            if lines:  # blank line ends the first paragraph we started
                break
            continue
        if stripped.startswith(("#", ">", "-", "*", "+", "|")) or _ORDERED_ITEM_RE.match(stripped):
            if lines:
                break
            continue  # still looking for prose
        lines.append(stripped)
    # One line is the usual shape; join a wrapped paragraph back together.
    text = " ".join(lines).strip()
    return text[:_COMMAND_DESC_MAX_LEN].rstrip()


# Markdown link targets only — ``](../…``. Rewriting every ``../`` in the text
# would also hit shell inside code fences: a command's own documentation says
# things like ``cd ../..``, and deepening that silently breaks an instruction
# the reader is meant to run. A bare path in prose is left alone too; missing
# one leaves it exactly as broken as it is today, which is the safe direction.
#
# The whole run of ``../`` is captured, not each segment, so the rewrite adds
# one level rather than doubling however many are already there.
_PARENT_LINK_RE = re.compile(r"(?<=\]\()((?:\.\./)+)")


def _reroot_parent_links(body: str) -> str:
    """Add one level to ``../`` paths, for text moving one directory deeper.

    A command lives at ``commands/<name>.md`` — one level under the package —
    so ``../CONNECTORS.md`` in its text means the package root. As a skill it
    lives at ``skills/<name>/SKILL.md``, one level deeper, where the same text
    would mean ``skills/CONNECTORS.md``. pdf-viewer's four commands all point
    that way and all pointed at nothing after conversion.

    Only ``../`` segments are touched, and only their depth: a link to a file
    beside the original command (``ref.md``) is not rewritten, because that file
    is not carried along and no rewrite would make it exist.
    """
    return _PARENT_LINK_RE.sub(r"../\1", body)


def materialize_command_skills(source: Path, plugin_name: str) -> tuple[list[str], list[str]]:
    """Rewrite ``<source>/commands/*.md`` as skills under ``<source>/skills/``.

    Mutates the *extracted* package copy only — never the user's upload, never
    anything already installed.  Must run before the installer discovers skills
    so the synthetic dirs flow through the normal path.

    Skipping always beats failing: a plugin whose command file is unreadable,
    undescribed, over-long or name-clashing still installs with its skills,
    agents and MCP servers intact.  A command that cannot become a good skill
    is worth less than the rest of the package.

    Args:
        source: Extracted package root (a writable temp copy).
        plugin_name: Manifest name — used for the ``<plugin>:<command>`` length
            budget and quoted in the preamble.

    Returns:
        ``(converted, warnings)``: bare command names that became skills, and
        human-readable notes for the install response.
    """
    cmd_dir = source / "commands"
    if not cmd_dir.is_dir():
        return [], []

    converted: list[str] = []
    warnings: list[str] = []
    skills_root = source / "skills"

    # Non-recursive, matching the ``deferred["commands"]`` scan in routes.
    # Claude Code also allows ``commands/<group>/<name>.md``; those stay
    # recorded-but-inactive rather than being flattened into a name the author
    # never wrote.
    for cmd_file in sorted(cmd_dir.glob("*.md")):
        bare = cmd_file.stem.strip()

        if not bare or bare in (".", "..") or any(ch in _UNSAFE_COMMAND_CHARS for ch in bare):
            warnings.append(f"commands/{cmd_file.name}:文件名不能作为技能名,已跳过。")
            continue

        # ``prefixed_skill_name`` raises past the budget, and that exception
        # would 400 the whole install; check here so one long name costs only
        # the one command.
        if len(f"{plugin_name}{NAMESPACE_SEP}{bare}") > PREFIXED_NAME_MAX_LEN:
            warnings.append(
                f"commands/{cmd_file.name}:名称超过 {PREFIXED_NAME_MAX_LEN} 字符预算,已跳过。"
            )
            continue

        # An authored skill of the same name wins. Overwriting would silently
        # replace the author's content with a converted command; renaming would
        # invent a name they never chose.
        dest_dir = skills_root / bare
        if dest_dir.exists():
            warnings.append(
                f"commands/{cmd_file.name}:插件里已有同名技能 {bare!r},命令未转换。"
            )
            continue

        try:
            raw = read_pkg_text(cmd_file)
        except (OSError, UnicodeDecodeError):
            warnings.append(f"commands/{cmd_file.name}:读取失败,已跳过。")
            continue

        front, body = _split_command_frontmatter(raw)
        description = str(front.get("description") or "").strip()
        if not description:
            # Upstream's own fallback for a skill/command with no ``description``:
            # "If omitted, uses the first paragraph of markdown content."
            # Frontmatter is optional for a command file — Figma's four ship with
            # none at all — so without this they would all be dropped.
            description = _first_paragraph(body)
        if not description:
            # The description is the *only* thing that makes the model reach for
            # a skill. With neither frontmatter nor prose there is nothing to
            # match on, so the entry could never fire — an empty catalogue slot
            # and a confusing UI row.
            warnings.append(
                f"commands/{cmd_file.name}:既无 description 也无正文说明,模型无从判断何时使用,已跳过。"
            )
            continue
        if not body.strip():
            warnings.append(f"commands/{cmd_file.name}:正文为空,没有可执行的流程,已跳过。")
            continue

        preamble = _COMMAND_BODY_PREAMBLE.format(plugin=plugin_name, command=bare)
        body = _reroot_parent_links(body)
        # ``$ARGUMENTS`` is the command system's parameter slot. With no slash
        # entry point there is nothing to substitute, so name what fills it.
        filled = body.replace("$ARGUMENTS", "（用户本轮提出的具体要求）")
        # ``json.dumps`` quotes/escapes the description so a colon, ``#`` or a
        # stray quote in the author's text cannot break the YAML block. The
        # ``[工作流]`` tag marks it in the catalogue: a command description is
        # written to be picked off a menu, a skill description to tell the model
        # when to reach for it, and the tag is the cheapest bridge between them.
        # The frontmatter name stays bare — the installer's namespace rewrite
        # turns it into ``<plugin>:<command>`` exactly as it does for a skill.
        skill_md = (
            f"---\nname: {bare}\n"
            f"description: {json.dumps(f'[工作流] {description}', ensure_ascii=False)}\n"
            f"---\n\n{preamble}\n{filled}"
        )

        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            (dest_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
        except OSError:
            logger.warning("Failed to materialize command %s as a skill", cmd_file, exc_info=True)
            warnings.append(f"commands/{cmd_file.name}:写入失败,已跳过。")
            continue

        converted.append(bare)

    return converted, warnings


def prefixed_agent_name(plugin_name: str, agent_name: str) -> str:
    """Registry name for a plugin-owned subagent: ``<plugin>:<agent>``.

    Mirrors :func:`prefixed_skill_name` so a plugin's subagent is namespaced
    the same way its skills are, but does **not** enforce the skill-name length
    budget: a subagent *type* is a delegation-registry key and a description
    shown to the parent agent, never a ``validate_skill_name`` target.
    """
    return f"{plugin_name}{NAMESPACE_SEP}{agent_name}"


def tool_name_segment(server_name: str) -> str:
    """*server_name* reduced to the Anthropic tool-name charset, or ``""``.

    A tool name must match ``[A-Za-z0-9_-]``, and the server name becomes part
    of one.  A name that already conforms is returned **unchanged**, so every
    conforming server keeps the exact key Claude Code would produce.

    Only a non-conforming name is rewritten, and rewriting beats rejecting:
    Anthropic's own knowledge-work plugins declare ``"google calendar"``, and a
    single space is a formatting difference, not a reason to drop a server the
    user asked for.  Returns ``""`` when nothing usable survives (a name of
    punctuation alone), which the caller treats as unusable.
    """
    return re.sub(r"[^A-Za-z0-9_-]+", "_", server_name).strip("_")


def server_wants_oauth(server: dict) -> bool:
    """Whether *server* should be given an OAuth provider.

    One definition for two callers that must agree: ``_resolve_plugin_mcp_
    credentials`` decides whether to attach a provider, and
    ``oauth_servers_status`` decides whether the server appears in the sign-in
    list. When they disagreed, eight ``engineering`` servers got a provider but
    no row in the UI to sign in with.

    A remote server qualifies unless it opts out with ``auth: "none"``. Keying
    this off a declared ``oauth`` block was the original bug: of that plugin's
    eight remote servers only Slack carries one, because the author expects the
    host to discover the rest through the MCP spec's 401-then-discover flow.
    Attaching a provider where none is needed is free — it engages only on a
    401 — whereas omitting one turns a signable-in server into a silent drop.

    stdio is excluded: it talks to a local process over pipes, so there is no
    HTTP challenge to answer, unless the author explicitly asked for OAuth.
    """
    if (
        server.get("auth") == "oauth"
        or bool(server.get("oauth"))
        or bool(server.get("oauth_resource"))
    ):
        return True
    return server.get("type") in MCP_REMOTE_TYPES and server.get("auth") != "none"


def mcp_server_key(plugin_name: str, server_name: str) -> str:
    """Registry key for a plugin-owned MCP server: ``plugin_<plugin>_<server>``.

    This becomes the server segment of the synthesized tool name
    ``mcp__plugin_<plugin>_<server>__<tool>``.  Verified against Claude
    Code's real output (``mcp__plugin_everything-mcp_everything__echo``):
    the plugin and server names are used **verbatim, hyphens preserved** —
    only ``__`` (the field delimiter) and the ``plugin_`` prefix are added.

    The plugin name is constrained by :func:`validate_plugin_name`; the server
    name is passed through :func:`tool_name_segment`, a no-op for every name
    that already fits the charset, so keys stay byte-identical to Claude Code's
    wherever Claude Code would form one at all.
    """
    return f"plugin{MCP_KEY_SEP}{plugin_name}{MCP_KEY_SEP}{tool_name_segment(server_name)}"


# Transport spellings we accept, mapped to the type the core client dispatches
# on (``hexagent/mcp/_client.py``).  ``sse`` is a FIRST-CLASS type here, not an
# alias for ``http``: the core has a dedicated ``sse_client`` branch, and an
# SSE-only server cannot be reached over streamable-http.  Only Claude Code's
# streamable-http spellings collapse into ``http``.
_MCP_TYPE_ALIASES = {
    "stdio": "stdio",
    "sse": "sse",
    "ws": "ws",
    "websocket": "ws",
    "http": "http",
    "streamable-http": "http",
    "streamablehttp": "http",
    "streamable_http": "http",
}

# Remote transports: configured by ``url`` + ``headers`` (+ OAuth), as opposed
# to stdio's ``command`` + ``args`` + ``env``.  Anything reading a server dict
# must branch on membership here, never on ``== "http"`` -- that test silently
# routes an SSE or WebSocket server down the stdio path.
MCP_REMOTE_TYPES = ("http", "sse", "ws")


def _mcp_manifest_items(data: object) -> list[dict]:
    """Flatten any accepted MCP manifest shape into a list of server objects.

    Accepts four shapes so any Claude Code ``.mcp.json`` installs verbatim:

    1. UniClaw:       ``[{"name": ..., ...}, ...]``            (array, name is a field)
    2. CC wrapped:    ``{"mcpServers": {"<name>": {...}}}``    (name is the key)
    3. CC bare map:   ``{"<name>": {...}, "<name2>": {...}}``  (official example-plugin
       uses this -- a direct name->config map, no wrapper)
    4. single object: ``{"name": ..., ...}``

    Shapes 2/3/4 normalize to shape 1's item list.  This lives only in the
    plugin package parser -- the internal MCP model is untouched.

    Args:
        data: Already-decoded JSON from ``.mcp.json`` or a ``plugin.json``
            ``mcpServers`` value.

    Returns:
        The server objects, in declaration order.

    Raises:
        PluginSpecError: When *data* is neither an object nor an array.
    """
    if isinstance(data, dict) and isinstance(data.get("mcpServers"), dict):
        return [
            {"name": n, **(cfg if isinstance(cfg, dict) else {})}
            for n, cfg in data["mcpServers"].items()
        ]
    if isinstance(data, dict) and data and all(isinstance(v, dict) for v in data.values()):
        # Every value is a config object -> treat as a bare name->config map.
        # (A single-server object like {"name": "x", "type": "http", ...} has
        # string values, so it won't match here and falls through to shape 4.)
        return [{"name": n, **v} for n, v in data.items()]
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return list(data)
    msg = "内容应该是一个 JSON 对象或数组"
    raise PluginSpecError(msg)


def normalize_mcp_servers(
    data: object,
    *,
    warnings: list[str] | None = None,
    skipped: list[dict] | None = None,
) -> list[dict]:
    """Normalize decoded MCP declarations into internal server dicts.

    Shared by both declaration sites -- a standalone ``.mcp.json`` / ``mcp.json``
    file (:func:`parse_plugin_mcp`) and an inline ``mcpServers`` block in
    ``plugin.json`` (:func:`parse_plugin_manifest`) -- so the two can never drift.

    Lenient where safe, strict where a bad value would only fail later at
    connect time:

    - ``name`` required (namespace segment; must be charset-safe enough to form
      a tool-name segment) -- a bad name is fatal, it would poison the tool name.
    - ``type`` accepts every Claude Code spelling; an **unrecognized** transport
      (e.g. ``ws``) skips *that server* with a warning instead of failing the
      package.  A plugin's skills, subagents and other MCP servers must not be
      lost because one server speaks a transport we don't implement.
    - remote (``http``/``sse``) requires ``url``; ``stdio`` requires ``command``.
    - unknown keys are dropped; ``env``/``headers`` accepted as dict or JSON
      string; ``args`` accepted as list or string.

    Args:
        data: Decoded JSON in any shape :func:`_mcp_manifest_items` accepts.
        warnings: Optional sink for non-fatal notes (skipped servers,
            unsupported fields).  Surfaced to the user at install time.

    Returns:
        A list of normalized server dicts.  Empty when nothing usable was
        declared.

    Raises:
        PluginSpecError: On a shape or a per-server field that cannot be
            repaired (bad/duplicate name, missing url/command).
    """
    notes = warnings if warnings is not None else []
    dropped = skipped if skipped is not None else []
    items = _mcp_manifest_items(data)

    servers: list[dict] = []
    seen: set[str] = set()
    seen_segments: set[str] = set()
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            msg = f"第 {i + 1} 个 MCP 服务的写法不对,应该是一个 JSON 对象"
            raise PluginSpecError(msg)

        name = str(item.get("name") or "").strip()
        if not name:
            msg = f"第 {i + 1} 个 MCP 服务没有名字(缺少 name 字段)"
            raise PluginSpecError(msg)
        if not tool_name_segment(name):
            # Nothing survives the charset reduction — punctuation only. There
            # is no key to give this server, so it cannot be registered.
            #
            # A name that merely *contains* something outside the charset is a
            # different matter and is NOT rejected: ``tool_name_segment`` folds
            # ``"google calendar"`` to ``google_calendar`` for the key while the
            # declared name is kept for display. Refusing over a single space
            # would drop a server the user asked for on a formatting detail —
            # and would report the space as the reason even when the entry is
            # unusable for a substantive one, which is what happened here: every
            # space-named server in Anthropic's plugins also has an empty url.
            #
            # Recorded, not warned: the installer emits one combined line for
            # every skip, and the detail page keeps the per-server reason. One
            # toast per skipped server buried the successes — small-business
            # runs eight of its eleven servers and still stacked three.
            dropped.append({"name": name, "reason": "illegal_name"})
            continue
        if name in seen:
            msg = f"有两个 MCP 服务重名了:{name!r}"
            raise PluginSpecError(msg)
        # Distinct names can fold to one key (``a b`` and ``a.b`` both give
        # ``a_b``), which would make two servers share a tool-name prefix and
        # silently shadow each other. Keep the first, record the second.
        segment = tool_name_segment(name)
        if segment in seen_segments:
            notes.append(
                f"MCP 服务器 {name!r} 规范化后与另一个服务器同名({segment!r}),"
                f"已跳过后者。"
            )
            dropped.append({"name": name, "reason": "name_collision"})
            continue
        seen_segments.add(segment)
        seen.add(name)

        # Type: explicit wins; else infer from fields (Claude Code often omits
        # it -- a ``command`` means stdio, a ``url`` means remote).
        raw_type = str(item.get("type") or "").strip().lower()
        if not raw_type:
            # Claude Code reads a type-less entry as stdio, so a ``url`` entry
            # that omits ``type`` is a configuration error there -- CC skips the
            # server and names the fix. Match that instead of guessing "http":
            # a wrong guess connects an sse/ws endpoint over streamable-http and
            # fails later with an error that points nowhere near the cause.
            if not item.get("command") and item.get("url"):
                notes.append(
                    f"MCP 服务器 “{name}” 有 url 但没有 type,已跳过该服务器;"
                    f"请在该条目上补 \"type\": \"http\"(或 \"sse\" / \"ws\")。"
                )
                continue
            stype = "stdio"
        elif raw_type in _MCP_TYPE_ALIASES:
            stype = _MCP_TYPE_ALIASES[raw_type]
        else:
            # SKIP, don't raise. A transport we don't implement (``ws``, ...) is
            # one dark server; raising here would reject the entire package,
            # taking its skills and subagents down with it.
            notes.append(
                f"MCP 服务器 “{name}” 使用不支持的传输类型 “{raw_type}”,"
                f"已跳过该服务器;插件的其余部分正常安装。"
            )
            continue

        auth = str(item.get("auth") or _DEFAULT_MCP_AUTH).strip().lower()
        if auth not in MCP_AUTH_MODES:
            msg = f"MCP server {name!r} has unsupported auth {auth!r}"
            raise PluginSpecError(msg)

        # ``oauth: true`` is Claude Code's shorthand for "this server needs the
        # OAuth flow, discover everything".  It carries no config object, so it
        # must be lifted into ``auth`` -- otherwise the credential seam sees no
        # marker at all and the server fails to connect with no hint why.
        if item.get("oauth") is True:
            auth = "oauth"

        server: dict = {"name": name, "type": stype, "auth": auth}

        # ``alwaysLoad`` (CC, all server types): exempt this server from
        # deferred tool loading — its tools stay in the model's context from the
        # first turn instead of waiting to be searched for. Declared by the
        # plugin author, not the host: only they know which of their tools the
        # model needs on every turn. Stored only when true so existing registry
        # entries keep their shape.
        if item.get("alwaysLoad") is True:
            server["always_load"] = True

        if stype in MCP_REMOTE_TYPES:
            url = str(item.get("url") or "").strip()
            if not url:
                # Same reasoning as the illegal-name skip above: unusable here,
                # but not grounds to reject the package. An empty ``url`` is how
                # Anthropic's own plugins reference a Cowork built-in connector
                # (``gmail``, ``google calendar``) — the host resolves it, so the
                # manifest carries no endpoint. We have no such connector, and a
                # server with nowhere to connect can only fail at runtime.
                dropped.append({"name": name, "reason": "host_connector"})
                continue
            server["url"] = url
            # OAuth markers carried through to the credential seam (see
            # AgentManager._resolve_plugin_mcp_credentials). Supports CC's
            # ``oauth`` object {clientId, callbackPort, authServerMetadataUrl,
            # scopes}, CC's ``oauth: true`` shorthand (lifted into ``auth``
            # above), and Codex's ``oauth_resource`` hint. Any of them -- or an
            # explicit ``auth: "oauth"`` -- attaches the SDK OAuthClientProvider.
            oauth_obj = item.get("oauth")
            if isinstance(oauth_obj, dict):
                server["oauth"] = {str(k): v for k, v in oauth_obj.items()}
            oauth_resource = item.get("oauth_resource")
            if isinstance(oauth_resource, str) and oauth_resource.strip():
                server["oauth_resource"] = oauth_resource.strip()
            if stype == "ws" and item.get("headers"):
                # Schema-legal (CC's ws example shows headers) but the MCP SDK's
                # ``websocket_client`` takes a URL only, so a bearer token here
                # would vanish and the connection fail with a bare 401.
                notes.append(
                    f"MCP 服务器 “{name}” 是 ws 传输且声明了 headers,"
                    f"当前 WebSocket 传输无法转发请求头,这些头会被忽略。"
                )
            # ``headersHelper`` (CC): a command run before EACH connection
            # whose stdout supplies short-lived auth headers. It executes
            # third-party code, so it rides the same install-time confirmation
            # as stdio commands (the gate in routes/plugins.py) and runs under
            # the guardrails in mcp_headers_helper (timeout, scrubbed env,
            # pinned cwd, strict output validation).
            helper = item.get("headersHelper")
            if isinstance(helper, str) and helper.strip():
                if stype == "ws":
                    # The SDK's websocket_client takes a URL only, so headers
                    # produced here would be dropped exactly like static ones.
                    notes.append(
                        f"MCP 服务器 “{name}” 是 ws 传输且声明了 headersHelper,"
                        f"当前 WebSocket 传输无法转发请求头,该 helper 不会被执行。"
                    )
                else:
                    server["headers_helper"] = helper.strip()
        else:  # stdio
            command = str(item.get("command") or "").strip()
            if not command:
                msg = f"MCP 服务 {name!r} 没有写要运行的命令(缺少 command 字段)"
                raise PluginSpecError(msg)
            server["command"] = command
            args = item.get("args")
            if isinstance(args, (list, tuple)):
                server["args"] = [str(a) for a in args]
            elif isinstance(args, str) and args.strip():
                server["args"] = [args.strip()]

        env = item.get("env")
        if isinstance(env, dict):
            server["env"] = {str(k): str(v) for k, v in env.items()}
        elif isinstance(env, str) and env.strip():
            server["env"] = env.strip()  # JSON string, resolved at build time

        headers = item.get("headers")
        if isinstance(headers, dict):
            server["headers"] = {str(k): str(v) for k, v in headers.items()}
        elif isinstance(headers, str) and headers.strip():
            server["headers"] = headers.strip()

        servers.append(server)

    return servers


def parse_plugin_mcp(
    raw: str,
    *,
    warnings: list[str] | None = None,
    skipped: list[dict] | None = None,
) -> list[dict]:
    """Parse and validate a plugin's MCP manifest file content.

    Thin wrapper over :func:`normalize_mcp_servers` that owns the JSON decode;
    see that function for the accepted shapes and the leniency rules.

    Args:
        raw: File content of ``.mcp.json`` / ``mcp.json``.
        warnings: Optional sink for non-fatal notes (skipped servers,
            unsupported fields).

    Returns:
        A list of normalized server dicts.  Empty list when the manifest is
        an empty array.

    Raises:
        PluginSpecError: On invalid JSON or a server that fails validation.
    """
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        msg = f"文件格式不是合法的 JSON({exc})"
        raise PluginSpecError(msg) from exc

    return normalize_mcp_servers(data, warnings=warnings, skipped=skipped)


def parse_plugin_manifest(raw: str) -> PluginManifest:
    """Parse and validate raw ``plugin.json`` content.

    Args:
        raw: File content of plugin.json.

    Returns:
        A validated :class:`PluginManifest`; coercion notes and reserved
        field usage are collected into ``manifest.warnings``.

    Raises:
        PluginSpecError: On unparsable JSON or missing required fields.
    """
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        msg = f"文件格式不是合法的 JSON({exc})"
        raise PluginSpecError(msg) from exc

    if not isinstance(data, dict):
        msg = "内容应该是一个 JSON 对象(以 { 开头)"
        raise PluginSpecError(msg)

    warnings: list[str] = []

    def _required(key: str) -> str:
        value = data.get(key)
        text = str(value).strip() if value is not None else ""
        if not text or text in ("None",):
            msg = f"缺少必填字段 {key!r}(插件必须有 name、version、description)"
            raise PluginSpecError(msg)
        return text

    name = _required("name")
    validate_plugin_name(name)
    # ``version`` is OPTIONAL in Claude Code plugin.json (the official
    # example-plugin omits it), so default it rather than reject.  It only
    # feeds display + upgrade comparison; ``0.0.0`` sorts below any real semver.
    version_raw = data.get("version")
    version = str(version_raw).strip() if version_raw is not None else ""
    if not version or version == "None":
        version = "0.0.0"
    # ``description`` also optional in Claude Code (only ``name`` is required).
    desc_raw = data.get("description")
    description = str(desc_raw).strip() if desc_raw is not None else ""

    # ``author`` may be a plain string (UniClaw) or an object with a ``name``
    # field (Claude Code: ``{"name": ..., "email": ..., "url": ...}``).
    author_raw = data.get("author")
    if isinstance(author_raw, dict):
        author = str(author_raw.get("name") or "").strip()
    elif author_raw is not None:
        author = str(author_raw).strip()
    else:
        author = ""

    # Optional dependency declaration — lenient: wrong shapes degrade to a
    # warning + empty list rather than rejecting the package.
    requires = _empty_requires()
    raw_requires = data.get("requires")
    if raw_requires is not None:
        if not isinstance(raw_requires, dict):
            warnings.append("plugin.json 'requires' must be an object; ignored.")
        else:
            for key in ("commands", "env_keys"):
                vals = raw_requires.get(key)
                if vals is None:
                    continue
                if isinstance(vals, (list, tuple)):
                    requires[key] = [str(v).strip() for v in vals if str(v).strip()]
                else:
                    warnings.append(f"plugin.json 'requires.{key}' must be a list; ignored.")
            unknown_keys = sorted(set(raw_requires) - {"commands", "env_keys"})
            if unknown_keys:
                warnings.append(
                    f"plugin.json 'requires' has unsupported keys (ignored): {unknown_keys}"
                )

    # Per-user config declarations. Accept BOTH field names — ``userConfig``
    # (Claude Code) and ``user_config`` (Claude Desktop MCPB / DXT) — and BOTH
    # shapes: an object map ``{KEY: {spec}}`` (CC + MCPB) or a list
    # ``[{key, ...}]`` (UniClaw's own earlier convention). Everything normalizes
    # to the internal list of ``{key, title, description, sensitive, required}``
    # so the frontend and secret store are unchanged. Lenient: a malformed entry
    # is dropped with a warning rather than failing the whole install.
    user_config: list[dict] = []
    seen_keys: set[str] = set()

    def _add_user_config(raw_key: object, spec: dict, where: str) -> None:
        key = str(raw_key or "").strip()
        if not key or not _USER_CONFIG_KEY_RE.match(key):
            warnings.append(f"user_config {where} has an invalid key (need [A-Za-z0-9_]); ignored.")
            return
        if key in seen_keys:
            warnings.append(f"user_config has duplicate key {key!r}; later ignored.")
            return
        seen_keys.add(key)
        # Field type (MCPB): string/number/boolean/directory/file. Unknown →
        # string with a warning, so a typo degrades to a text box, never breaks.
        utype = str(spec.get("type") or "string").strip().lower()
        if utype not in _USER_CONFIG_TYPES:
            warnings.append(
                f"user_config {where} has unknown type {utype!r}; treated as 'string'."
            )
            utype = "string"
        field_spec: dict = {
            "key": key,
            "title": str(spec.get("title") or key),
            "description": str(spec.get("description") or ""),
            "type": utype,
            # MCPB: ``sensitive`` defaults to FALSE (only meaningful for strings —
            # mask + store securely). Aligns with Claude Desktop's MANIFEST.md.
            "sensitive": bool(spec.get("sensitive", False)),
            "required": bool(spec.get("required", False)),
        }
        # ``default`` (pre-filled initial value) — kept as a string; the vault /
        # env injection is string-based. Only stored when present.
        default_val = spec.get("default")
        if default_val is not None:
            field_spec["default"] = str(default_val)
        # ``multiple`` (directory/file: allow several) and ``min``/``max``
        # (number validation) — carried through for the frontend to honor.
        if bool(spec.get("multiple", False)):
            field_spec["multiple"] = True
        for bound in ("min", "max"):
            bval = spec.get(bound)
            if isinstance(bval, (int, float)) and not isinstance(bval, bool):
                field_spec[bound] = bval
        user_config.append(field_spec)

    raw_uc = data.get("userConfig")
    if raw_uc is None:
        raw_uc = data.get("user_config")
    if isinstance(raw_uc, dict):
        # Object map {KEY: {spec}} — the map key IS the field key (CC / MCPB).
        for k, spec in raw_uc.items():
            if isinstance(spec, dict):
                _add_user_config(k, spec, f"[{k!r}]")
            else:
                warnings.append(f"user_config[{k!r}] must be an object; ignored.")
    elif isinstance(raw_uc, list):
        # List [{key, ...}] — UniClaw's earlier convention.
        for i, item in enumerate(raw_uc):
            if isinstance(item, dict):
                _add_user_config(item.get("key", ""), item, f"[{i}]")
            else:
                warnings.append(f"user_config[{i}] must be an object; ignored.")
    elif raw_uc is not None:
        warnings.append("plugin.json 'user_config' must be an object or list; ignored.")

    # Reserved fields: accepted for forward-compat, ignored with a warning
    # so plugin authors learn immediately that these components won't run.
    #
    # ``commands`` is deliberately NOT warned about any more. That field is only
    # a path list pointing at the ``commands/`` directory the installer already
    # scans by convention and converts into workflow skills — of the ten shipped
    # CodeBuddy packages that declare it, five also carry that directory, so
    # "not supported, ignored" printed directly above the installer's own
    # "已转换为工作流技能" line and contradicted it. The route reports what was
    # actually converted; that is the truthful message.
    if data.get("hooks"):
        warnings.append(
            "插件声明了 hooks(自动触发的钩子),当前版本还不支持,已忽略;"
            "技能、子智能体和 MCP 不受影响。"
        )

    # Expert identity (CodeBuddy / WorkBuddy).  Lenient: read what's there, coerce
    # ``expert_type``, keep the rest of the persona verbatim for the UI.  Absent
    # for ordinary plugins.
    expert_type = None
    et_raw = data.get("expertType")
    if et_raw is not None:
        et = str(et_raw).strip().lower()
        expert_type = et if et in ("agent", "team") else None
        if expert_type is None:
            warnings.append(f"plugin.json 'expertType' {et_raw!r} is not 'agent'/'team'; ignored.")
    agent_name = str(data["agentName"]).strip() if data.get("agentName") else None
    persona = {k: data[k] for k in _MANIFEST_PERSONA_KEYS if k in data}

    # Inline MCP declarations. Claude Code accepts ``mcpServers`` *inside*
    # plugin.json as an alternative to a sibling ``.mcp.json``; reading only the
    # file would silently drop the servers of any plugin using this form -- the
    # skills would install and the MCP half would just never appear. Parsed with
    # the same normalizer as the file so the two forms cannot diverge, and
    # non-fatally: a broken inline block degrades to a warning rather than
    # rejecting a package whose skills and subagents are fine.
    # Claude Code accepts THREE shapes here (plugins-reference): an inline
    # object, a path string to an external manifest, and an ARRAY of paths.
    # A list of dicts is not a path list -- that is our own inline array shape,
    # so disambiguate on the element type rather than on ``isinstance(list)``.
    mcp_servers: list[dict] = []
    mcp_manifest_paths: list[str] = []
    skipped: list[dict] = []
    raw_mcp = data.get("mcpServers")
    if isinstance(raw_mcp, str):
        mcp_manifest_paths = [raw_mcp.strip()] if raw_mcp.strip() else []
    elif isinstance(raw_mcp, (list, tuple)) and raw_mcp and all(
        isinstance(x, str) for x in raw_mcp
    ):
        mcp_manifest_paths = [x.strip() for x in raw_mcp if x.strip()]
    elif raw_mcp is not None:
        try:
            mcp_servers = normalize_mcp_servers(raw_mcp, warnings=warnings, skipped=skipped)
        except PluginSpecError as exc:
            warnings.append(f"plugin.json 内联 mcpServers 解析失败,已忽略:{exc}")

    return PluginManifest(
        name=name,
        version=version,
        description=description,
        author=author,
        requires=requires,
        user_config=user_config,
        expert_type=expert_type,
        agent_name=agent_name,
        persona=persona,
        mcp_servers=mcp_servers,
        mcp_manifest_paths=mcp_manifest_paths,
        mcp_skipped=skipped,
        warnings=warnings,
    )


# Server name for the single stdio server a Claude Desktop MCPB bundles. The
# tool name becomes ``mcp__plugin_<plugin>_server__<tool>``; "server" is a safe
# [A-Za-z0-9_-] segment.
_MCPB_SERVER_NAME = "server"


def parse_mcpb_manifest(raw: str) -> tuple["PluginManifest", list[dict]]:
    """Parse a Claude Desktop MCPB / DXT ``manifest.json`` (.mcpb bundle).

    An MCPB is a local **stdio** MCP server plus a manifest — no skills. Its
    server lives in ``server.mcp_config`` (``command`` / ``args`` / ``env``),
    and its config schema is the same ``user_config`` object map we already
    normalize.  We map it onto our internal shape:

    - manifest metadata (name/version/description/author/user_config) via
      :func:`parse_plugin_manifest` (it ignores the extra MCPB-only fields);
    - one stdio MCP server derived from ``server.mcp_config``, with the MCPB
      ``${__dirname}`` path variable rewritten to ``${CLAUDE_PLUGIN_ROOT}`` so
      our existing expansion resolves it. ``${user_config.KEY}`` and
      ``${ENV_VAR}`` are already handled downstream.

    Returns ``(manifest, mcp_servers)``.  Raises :class:`PluginSpecError` on
    unparseable JSON or a missing server command.
    """
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        msg = f"manifest.json is not valid JSON: {exc}"
        raise PluginSpecError(msg) from exc
    if not isinstance(data, dict):
        msg = "manifest.json must be a JSON object"
        raise PluginSpecError(msg)

    manifest = parse_plugin_manifest(raw)  # reuses name/version/author/user_config

    servers: list[dict] = []
    server = data.get("server")
    if isinstance(server, dict):
        mcp_config = server.get("mcp_config") or {}
        # Platform overrides (MCPB): mcp_config.platform_overrides.{win32|darwin|
        # linux} replace the base command/args/env on the matching OS. sys.platform
        # already yields win32/darwin/linux, so it keys directly.
        overrides = mcp_config.get("platform_overrides")
        if isinstance(overrides, dict):
            ov = overrides.get(sys.platform)
            if isinstance(ov, dict):
                mcp_config = {
                    **mcp_config,
                    **{k: ov[k] for k in ("command", "args", "env") if k in ov},
                }
        command = str(mcp_config.get("command") or "").strip()
        if not command:
            msg = "MCPB manifest.json 'server.mcp_config.command' is required"
            raise PluginSpecError(msg)

        def _sub(v: str) -> str:
            return v.replace("${__dirname}", "${CLAUDE_PLUGIN_ROOT}")

        raw_args = mcp_config.get("args")
        args = [_sub(str(a)) for a in raw_args] if isinstance(raw_args, (list, tuple)) else []
        raw_env = mcp_config.get("env")
        env = (
            {str(k): _sub(str(v)) for k, v in raw_env.items()}
            if isinstance(raw_env, dict) else {}
        )
        server_entry: dict = {
            "name": _MCPB_SERVER_NAME,
            "type": "stdio",
            "auth": "static",
            "command": _sub(command),
        }
        if args:
            server_entry["args"] = args
        if env:
            server_entry["env"] = env
        servers.append(server_entry)

    return manifest, servers


def rewrite_frontmatter_name(skill_md_text: str, new_name: str) -> str:
    """Return SKILL.md content with its frontmatter ``name`` set to *new_name*.

    This is the namespace step: at install time the plugin's skills get
    their frontmatter ``name`` rewritten to ``<plugin>:<skill>`` **in the
    installed copy** (the uploaded archive itself is never modified), so
    every existing consumer — bootstrap registration, ``discover()``,
    ``load_content`` — sees the namespaced name without code changes.
    Frontmatter is the authoritative identity in hexagent (skills.py), so
    rewriting the file keeps that invariant instead of adding a parallel
    mapping layer.

    Only the first ``name:`` line inside the frontmatter block is touched;
    the body (which may legitimately contain ``name:`` lines in examples)
    is left alone.  If the frontmatter has no ``name:`` line (parse-lenient
    fallback cases), one is inserted right after the opening delimiter.
    """
    lines = skill_md_text.splitlines(keepends=True)
    delim = re.compile(r"^(-{3,}|\*{3,}|#{3,})\s*$")  # same set as skill_spec

    # Locate frontmatter block: first delimiter line, then the next one.
    open_idx: int | None = None
    close_idx: int | None = None
    for i, line in enumerate(lines):
        if delim.match(line.strip()):
            if open_idx is None:
                open_idx = i
            else:
                close_idx = i
                break
    if open_idx is None or close_idx is None:
        msg = "SKILL.md has no frontmatter block to rewrite"
        raise PluginSpecError(msg)

    name_re = re.compile(r"^(\s*name\s*:\s*).*$")
    for i in range(open_idx + 1, close_idx):
        m = name_re.match(lines[i].rstrip("\n"))
        if m:
            newline = "\n" if lines[i].endswith("\n") else ""
            lines[i] = f"{m.group(1)}{new_name}{newline}"
            return "".join(lines)

    # No name line found — insert one directly after the opener.
    lines.insert(open_idx + 1, f"name: {new_name}\n")
    return "".join(lines)


# ---------------------------------------------------------------------------
# Plugin agents (subagents)
# ---------------------------------------------------------------------------
#
# A plugin's ``agents/*.md`` are Claude-Code / CodeBuddy subagent definitions:
# YAML frontmatter (name/description/tools/model + the CodeBuddy ``maxTurns`` and
# ``color``) followed by a Markdown body that becomes the subagent's system
# prompt.  Expert identity (expertType/agentName/persona) is NOT here — it lives
# in the MANIFEST (see :class:`PluginManifest`).  Unlike skills, plugin agents
# are NOT copied to disk — they are parsed from the retained package at
# agent-build time and merged into ``AgentDefinition``s by the demo's
# AgentResolver.  Parsing is lenient (mirrors :mod:`hexagent.harness.skill_spec`):
# a malformed file is skipped with a warning, never raised.

_AGENT_FM_DELIM = re.compile(r"^(-{3,}|\*{3,}|#{3,})\s*$")  # same set as skill_spec


@dataclass(frozen=True)
class PluginAgentSpec:
    """A parsed ``agents/*.md`` subagent definition — the agent's *behaviour*.

    Expert identity (expertType / agentName / market persona) belongs to the
    package and is read from the manifest, not here (see :class:`PluginManifest`).

    Attributes:
        name: Bare frontmatter ``name`` (falls back to the file stem). The
            ``<plugin>:<agent>`` namespacing is applied later, by the resolver
            that knows the owning plugin.
        description: Frontmatter ``description`` — what the parent reads to
            decide delegation. May be empty (then flagged in ``warnings``).
        system_prompt: The Markdown body after the frontmatter block.
        tools: Effective allowed tool names (``tools``/``allowed-tools`` minus
            ``disallowedTools``); empty tuple means "inherit the full tool set".
        model: Optional model override string (routed to a tier by the resolver).
        max_turns: Positive ``maxTurns`` cap, else ``None``.
        color: Optional display color (Claude Code palette), for the UI.
        source_file: ``agents/<file>.md`` (or ``.toml``) for diagnostics.
        warnings: Per-agent non-fatal notes.
    """

    name: str
    description: str
    system_prompt: str
    tools: tuple[str, ...] = ()
    model: str | None = None
    max_turns: int | None = None
    color: str | None = None
    source_file: str = ""
    warnings: list[str] = field(default_factory=list)


def _lenient_frontmatter(block: str) -> dict[str, str]:
    """Best-effort flat ``key: value`` parse for frontmatter that isn't strict YAML.

    Agent descriptions routinely contain a bare ``": "`` (e.g. ``"Use when: X"``),
    which is a YAML syntax error (a plain scalar may not contain ``": "``). Strict
    ``yaml.safe_load`` would raise and the whole agent would be dropped. The fields
    we consume (name/description/tools/model/color/maxTurns) are all simple
    top-level scalars, so recover them line-by-line instead of losing the agent —
    matching how Claude Code / CodeBuddy treat these flat frontmatters. Only used
    as a fallback; well-formed YAML (incl. real list/nested values) parses above
    and never reaches here.
    """
    out: dict[str, str] = {}
    for line in block.splitlines():
        if line[:1] in (" ", "\t"):
            continue  # nested/continuation line — not flatly interpretable, skip
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = stripped.partition(":")  # first colon only — keep inner ": "
        key = key.strip()
        if not sep or not key:
            continue
        out[key] = value.strip().strip('"').strip("'")
    return out


def _split_agent_frontmatter(text: str) -> tuple[dict | None, str]:
    """Split an agent ``.md`` into ``(frontmatter_mapping, body)``.

    Returns ``(None, body)`` when there is no delimited frontmatter block, or when
    the block yields no usable fields even after a lenient fallback — the caller
    treats that as skip-with-warn.
    """
    # A leading UTF-8 BOM (common from Windows editors) would otherwise make the
    # first line "﻿---" fail the delimiter match and drop the agent.
    text = text.lstrip("﻿")  # strip a leading UTF-8 BOM if present
    lines = text.splitlines(keepends=True)
    open_idx: int | None = None
    close_idx: int | None = None
    for i, line in enumerate(lines):
        if _AGENT_FM_DELIM.match(line.strip()):
            if open_idx is None:
                open_idx = i
            else:
                close_idx = i
                break
    if open_idx is None or close_idx is None:
        return None, text.strip()
    block = "".join(lines[open_idx + 1 : close_idx])
    body = "".join(lines[close_idx + 1 :]).strip()
    try:
        data = yaml.safe_load(block)
    except yaml.YAMLError:
        data = None
    if isinstance(data, dict):
        return data, body
    # Strict YAML failed (or wasn't a mapping) — recover the flat scalar fields
    # rather than silently dropping the agent (tolerant-boundary principle).
    lenient = _lenient_frontmatter(block)
    return (lenient or None), body


def _parse_agent_tools(raw: object) -> tuple[str, ...]:
    """Normalize a frontmatter ``tools`` value (CSV string or list) to a tuple."""
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
    elif isinstance(raw, (list, tuple)):
        parts = [str(p).strip() for p in raw]
    else:
        return ()
    return tuple(p for p in parts if p)


def _coerce_positive_int(raw: object) -> int | None:
    """Return *raw* as a positive int, else ``None`` (0/negative/non-numeric)."""
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


# Codex expresses a subagent's write permission as ``sandbox_mode`` rather than
# a tool allowlist.  Upstream: "Codex agents in read-only mode can inspect code
# and run exploration queries without modifying files or executing unsafe
# commands."  (learn.chatgpt.com/codex/agent-configuration/subagents)
_CODEX_READONLY_MODES = frozenset({"read-only", "read_only", "readonly"})

# What "read-only" becomes here.  Codex enforces it as an OS sandbox: the shell
# still runs, the filesystem is simply mounted read-only.  Our granularity is the
# tool, and ``Bash`` both reads and writes, so the mapping cannot be exact.
#
# We drop the direct write tools and keep the shell — the same line Claude Code
# draws for its own read-only agent, whose published tool set is "All tools
# except Agent, Artifact, ExitPlanMode, Edit, Write, NotebookEdit".  Dropping
# Bash as well would deliver a stricter guarantee, but it would also take away
# ``find`` / ``git log`` / ``rg``, i.e. most of what "run exploration queries"
# means in the upstream description — a read-only explorer that cannot explore.
# The residual ``echo > file`` hole is one upstream accepts too; closing it for
# real belongs at the Computer layer (a read-only mount), not here.  The
# deviation is stated in an install warning rather than left to be discovered.
#
# Names absent from this runtime are dropped later by ``_sanitize_agent_tools``,
# so naming a superset is safe.
_CODEX_READONLY_TOOLS = (
    "Bash", "Glob", "Grep", "Read", "WebSearch", "WebFetch", "TodoWrite", "Skill",
)


def _parse_codex_toml_agent(path: Path, rel: str) -> tuple[PluginAgentSpec | None, str | None]:
    """Parse one OpenAI Codex subagent (``.toml``) into a :class:`PluginAgentSpec`.

    Codex subagents are TOML (``name``/``description``/``developer_instructions``
    + ``model``/``sandbox_mode``/…), a different shape from the Claude Code /
    CodeBuddy ``agents/*.md`` + YAML frontmatter.  Mapped here so all three
    ecosystems land on the same runtime primitive.  Returns ``(spec, None)`` on
    success or ``(None, package_warning)`` when the file is skipped.
    """
    try:
        data = tomllib.loads(read_pkg_text(path))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        return None, f"{rel}: unreadable/invalid TOML ({exc}); skipped"
    if not isinstance(data, dict):
        return None, f"{rel}: not a TOML table; skipped"

    name = str(data.get("name") or path.stem).strip()
    if not name:
        return None, f"{rel}: empty name; skipped"

    agent_warnings: list[str] = []
    description = str(data.get("description") or "").strip()
    if not description:
        agent_warnings.append("missing description — the parent agent cannot route tasks to it")
    # ``developer_instructions`` is Codex's system prompt (the md body's analogue).
    system_prompt = str(data.get("developer_instructions") or "").strip()
    if not system_prompt:
        agent_warnings.append("missing developer_instructions (system prompt)")

    # Codex TOML has no md-style tool allowlist; ``sandbox_mode`` is where its
    # authors state write permission, so it is the allowlist. Ignoring it handed
    # an agent explicitly marked read-only the full set including Bash/Write/Edit
    # — observed in the wild with ``codex-pr-explorer``, which then wrote scratch
    # files while "exploring".
    sandbox = str(data.get("sandbox_mode") or "").strip().lower()
    if sandbox in _CODEX_READONLY_MODES:
        tools: tuple[str, ...] = _CODEX_READONLY_TOOLS
        agent_warnings.append(
            "sandbox_mode=read-only:已移除 Write/Edit 等写工具(与 Claude Code 自带只读智能体一致)。"
            "注意 Codex 用操作系统沙箱实现只读,本版本按工具粒度实现,保留了 Bash——"
            "shell 重定向理论上仍可写入。"
        )
    else:
        # ``workspace-write`` and anything unrecognised keep the full set — the
        # prior behaviour, and the right default for a mode that grants writes.
        tools = ()
        if sandbox and sandbox != "workspace-write":
            agent_warnings.append(
                f"sandbox_mode={sandbox!r} 无法识别,按可写处理(完整工具集)。"
            )

    spec = PluginAgentSpec(
        name=name,
        description=description,
        system_prompt=system_prompt,
        tools=tools,
        model=(str(data["model"]).strip() or None) if data.get("model") else None,
        max_turns=None,
        source_file=rel,
        warnings=agent_warnings,
    )
    return spec, None


def parse_plugin_agents(plugin_root: Path) -> tuple[list[PluginAgentSpec], list[str]]:
    """Parse a plugin's subagents across all supported ecosystems.

    Scans three locations, so a package authored for any of them installs
    unchanged:

    * ``agents/*.md`` — Claude Code / CodeBuddy (YAML frontmatter + Markdown body)
    * ``agents/*.toml`` and ``.codex/agents/*.toml`` — OpenAI Codex (TOML)

    Args:
        plugin_root: The plugin package root.

    Returns:
        ``(specs, warnings)``.  ``specs`` is one :class:`PluginAgentSpec` per
        well-formed agent file; ``warnings`` collects package-level notes
        (skipped/unreadable files).  Never raises — a malformed agent is
        skipped, not fatal.
    """
    agents_dir = plugin_root / "agents"
    specs: list[PluginAgentSpec] = []
    warnings: list[str] = []

    # 1) Codex TOML subagents (agents/*.toml + .codex/agents/*.toml).
    toml_paths: list[Path] = []
    if agents_dir.is_dir():
        toml_paths += sorted(agents_dir.glob("*.toml"))
    codex_dir = plugin_root / ".codex" / "agents"
    if codex_dir.is_dir():
        toml_paths += sorted(codex_dir.glob("*.toml"))
    for tf in toml_paths:
        rel = tf.relative_to(plugin_root).as_posix()
        spec, warn = _parse_codex_toml_agent(tf, rel)
        if warn is not None:
            warnings.append(warn)
        if spec is not None:
            specs.append(spec)

    # 2) Claude Code / CodeBuddy markdown subagents (agents/*.md).
    if not agents_dir.is_dir():
        return specs, warnings

    for md in sorted(agents_dir.glob("*.md")):
        try:
            text = read_pkg_text(md)
        except (OSError, UnicodeDecodeError) as exc:
            warnings.append(f"agents/{md.name}: unreadable ({exc}); skipped")
            continue
        frontmatter, body = _split_agent_frontmatter(text)
        if frontmatter is None:
            warnings.append(f"agents/{md.name}: no parseable YAML frontmatter; skipped")
            continue

        name = str(frontmatter.get("name") or md.stem).strip()
        if not name:
            warnings.append(f"agents/{md.name}: empty name; skipped")
            continue

        agent_warnings: list[str] = []
        description = str(frontmatter.get("description") or "").strip()
        if not description:
            agent_warnings.append("missing description — the parent agent cannot route tasks to it")

        raw_max_turns = frontmatter.get("maxTurns")
        max_turns = _coerce_positive_int(raw_max_turns)
        if raw_max_turns is not None and max_turns is None:
            agent_warnings.append("maxTurns ignored (not a positive integer)")

        # Effective tools = allowed (``tools``/``allowed-tools``) minus
        # ``disallowedTools`` (Claude Code deny-list).
        tools_raw = frontmatter.get("tools")
        if tools_raw is None:
            tools_raw = frontmatter.get("allowed-tools")
        allowed = _parse_agent_tools(tools_raw)
        denied = frozenset(_parse_agent_tools(frontmatter.get("disallowedTools")))
        tools = tuple(t for t in allowed if t not in denied)

        color = str(frontmatter["color"]).strip() if frontmatter.get("color") else None

        specs.append(
            PluginAgentSpec(
                name=name,
                description=description,
                system_prompt=body,
                tools=tools,
                model=(str(frontmatter["model"]).strip() or None) if frontmatter.get("model") else None,
                max_turns=max_turns,
                color=color,
                source_file=f"agents/{md.name}",
                warnings=agent_warnings,
            )
        )
    return specs, warnings


def referenced_user_config_keys(server: dict) -> set[str]:
    """All ``user_config`` keys referenced by an MCP server's env/headers/args.

    Used to know which secrets a server needs so the UI can flag missing ones
    and the resolver knows what to look up.
    """
    keys: set[str] = set()

    def _scan(value: object) -> None:
        if isinstance(value, str):
            keys.update(_USER_CONFIG_REF_RE.findall(value))
        elif isinstance(value, dict):
            for v in value.values():
                _scan(v)
        elif isinstance(value, (list, tuple)):
            for v in value:
                _scan(v)

    for fld in ("env", "headers", "args", "url"):
        if fld in server:
            _scan(server[fld])
    return keys


def expand_user_config_refs(value: object, resolve) -> object:
    """Recursively replace ``${user_config.KEY}`` with ``resolve(KEY)``.

    ``resolve(key) -> str | None`` fetches the user-filled value (from the OS
    credential vault).  A reference whose value is unset resolves to an empty
    string — the MCP server then fails/authless as it would with a blank key,
    which the UI has already surfaced as a "not filled yet" state.

    Strings, and the string values inside dicts/lists, are expanded; other
    types pass through untouched.
    """
    if isinstance(value, str):
        return _USER_CONFIG_REF_RE.sub(lambda m: resolve(m.group(1)) or "", value)
    if isinstance(value, dict):
        return {k: expand_user_config_refs(v, resolve) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_user_config_refs(v, resolve) for v in value]
    return value


# Any ``${...}`` reference; the inner group allows dotted names (user_config.KEY).
_PLUGIN_VAR_RE = re.compile(r"\$\{([A-Za-z0-9_.]+)\}")


def _mcpb_user_dir(name: str) -> str | None:
    """MCPB special-directory variables (Claude Desktop MANIFEST.md).

    ``${HOME}`` / ``${DESKTOP}`` / ``${DOCUMENTS}`` / ``${DOWNLOADS}`` resolve to
    the user's directories cross-platform (``Path.home()`` handles Windows'
    ``USERPROFILE`` vs POSIX ``$HOME``). Returns ``None`` for any other name.
    """
    home = Path.home()
    mapping = {
        "HOME": home,
        "DESKTOP": home / "Desktop",
        "DOCUMENTS": home / "Documents",
        "DOWNLOADS": home / "Downloads",
    }
    p = mapping.get(name)
    return str(p) if p is not None else None


def expand_plugin_vars(value: object, ctx: dict) -> object:
    """Recursively expand every Claude-Code / MCPB plugin variable inside *value*.

    Implements the substitution set documented in Claude Code's plugins
    reference AND Claude Desktop's MCPB MANIFEST.md (the ``.mcp.json`` /
    ``mcp_config`` command/args/env/url fields), so a CC plugin or an MCPB
    extension's config runs verbatim:

    - ``${CLAUDE_PLUGIN_ROOT}``  → this plugin's active-version install dir
    - ``${CLAUDE_PLUGIN_DATA}``  → its persistent data dir (survives upgrades)
    - ``${CLAUDE_PROJECT_DIR}``  → the project root
    - ``${user_config.KEY}``     → the user-filled secret for KEY
    - ``${HOME}`` / ``${DESKTOP}`` / ``${DOCUMENTS}`` / ``${DOWNLOADS}`` → user dirs
    - ``${pathSeparator}`` / ``${/}`` → the platform path separator (``os.sep``)
    - ``${ANY_ENV_VAR}``         → the process environment value

    Unknown ``${X}`` (not a system var, not user_config, not in the env) is left
    **untouched** rather than blanked — safer and easier to diagnose than
    silently substituting an empty string.

    Args:
        value: str / list / dict (recursed) — anything else passes through.
        ctx: keys ``plugin_root``, ``plugin_data``, ``project_dir`` (str),
            ``user_config`` (callable ``key -> str | None``), ``env`` (mapping).
    """
    if isinstance(value, str):
        # ``${/}`` is a valid MCPB alias for the separator but its slash is not
        # matched by _PLUGIN_VAR_RE — replace it literally before the regex pass.
        value = value.replace("${/}", os.sep)

        def _sub(m: "re.Match[str]") -> str:
            name = m.group(1)
            # Plugin root/data/project vars. Claude Code and Tencent CodeBuddy
            # (a Claude-Code-alike whose ``.codebuddy-plugin/`` format UniClaw
            # also accepts) use the same three variables under different vendor
            # prefixes — map both to the same dirs so a CodeBuddy plugin's MCP
            # config and scripts resolve exactly like a Claude Code plugin's.
            # Only these explicit vendor prefixes are recognized; any other
            # ``${X_PROJECT_DIR}`` still falls through to the env lookup below,
            # so no existing behaviour changes.
            if name in ("CLAUDE_PLUGIN_ROOT", "CODEBUDDY_PLUGIN_ROOT"):
                return str(ctx.get("plugin_root") or "")
            if name in ("CLAUDE_PLUGIN_DATA", "CODEBUDDY_PLUGIN_DATA"):
                return str(ctx.get("plugin_data") or "")
            if name in ("CLAUDE_PROJECT_DIR", "CODEBUDDY_PROJECT_DIR"):
                return str(ctx.get("project_dir") or "")
            if name.startswith("user_config."):
                uc = ctx.get("user_config")
                return (uc(name[len("user_config.") :]) if callable(uc) else None) or ""
            if name in ("pathSeparator", "pathseparator"):
                return os.sep
            special = _mcpb_user_dir(name)
            if special is not None:
                return special
            env = ctx.get("env") or {}
            if name in env:
                return str(env[name])
            return m.group(0)  # unknown → leave the literal in place

        return _PLUGIN_VAR_RE.sub(_sub, value)
    if isinstance(value, dict):
        return {k: expand_plugin_vars(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_plugin_vars(v, ctx) for v in value]
    return value
