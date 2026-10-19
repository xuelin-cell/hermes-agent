"""Skill names for installed package components.

Hermes turns every skill into a slash command by keeping only ``[a-z0-9-]``
(``agent/skill_commands.py``), so UniClaw's ``<plugin>:<skill>`` would become
``/<plugin><skill>`` with the boundary gone. Installed skills are therefore
named ``<plugin>--<skill>`` (UniClaw's own on-disk separator): the index still
shows where the package ends, and the command reads ``/<plugin>-<skill>``.

Package texts that name their own skills the WorkBuddy way
(``equity-research:catalyst-calendar``) are rewritten on install with
:func:`rewrite_refs`, so a persona's skill table keeps pointing at real skills.
"""

from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional, Set, Tuple

from . import plugin_spec as spec

SEP = "--"


def skill_name(plugin: str, bare: str, *, taken: Optional[Set[str]] = None,
               warnings: Optional[List[str]] = None) -> str:
    """``<plugin>--<bare>``, shortened exactly like UniClaw when over budget."""
    spec_taken = {t.replace(SEP, spec.NAMESPACE_SEP, 1) for t in (taken or set())}
    fitted = spec.fit_prefixed_skill_name(plugin, bare, taken=spec_taken, warnings=warnings)
    return fitted.replace(spec.NAMESPACE_SEP, SEP, 1)


def strip_own(plugin: str, name: str) -> str:
    """Undo our own prefix (either spelling) on a re-zipped installed package."""
    for prefix in (f"{plugin}{spec.NAMESPACE_SEP}", f"{plugin}{SEP}"):
        rest = name[len(prefix):]
        if name.startswith(prefix) and rest and spec.NAMESPACE_SEP not in rest and SEP not in rest:
            return rest
    return name


def bare_of(full: str) -> str:
    if SEP in full:
        return full.split(SEP, 1)[1]
    return full.split(spec.NAMESPACE_SEP)[-1]


def slash_command(full: str) -> str:
    """The ``/command`` Hermes derives from a skill name (same rules as skill_commands)."""
    slug = full.lower().replace(" ", "-").replace("_", "-")
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return f"/{slug}"


def rewrite_refs(text: str, plugin: str, mapping: Dict[str, str]) -> Tuple[str, int]:
    """Replace ``<plugin>:<old>`` with the installed full name ``mapping[old]``."""
    if not mapping:
        return text, 0
    alternatives = "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
    pattern = re.compile(rf"(?<![\w/.-]){re.escape(plugin)}:({alternatives})(?![\w-])")
    return pattern.subn(lambda m: mapping[m.group(1)], text)


def ref_mapping(plugin: str, skills: Iterable[Tuple[str, str]], agents: Iterable[Tuple[str, str]]) -> Dict[str, str]:
    """``{old bare name: installed full name}`` for skills and subagents."""
    mapping: Dict[str, str] = {}
    for bare, full in skills:
        mapping[bare] = full
    for agent, full in agents:
        mapping.setdefault(agent, full)
    return mapping
