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
    """生成「套件--技能」形式的技能名，超长时按数字员工（UniClaw）同样的规则缩短，并避开已占用的名字。"""
    spec_taken = {t.replace(SEP, spec.NAMESPACE_SEP, 1) for t in (taken or set())}
    fitted = spec.fit_prefixed_skill_name(plugin, bare, taken=spec_taken, warnings=warnings)
    return fitted.replace(spec.NAMESPACE_SEP, SEP, 1)


def strip_own(plugin: str, name: str) -> str:
    """去掉我们自己加过的前缀（两种写法都认），用于重新打包后再装的包。"""
    for prefix in (f"{plugin}{spec.NAMESPACE_SEP}", f"{plugin}{SEP}"):
        rest = name[len(prefix):]
        if name.startswith(prefix) and rest and spec.NAMESPACE_SEP not in rest and SEP not in rest:
            return rest
    return name


def bare_of(full: str) -> str:
    """从完整技能名里取出不带套件前缀的原名。"""
    if SEP in full:
        return full.split(SEP, 1)[1]
    return full.split(spec.NAMESPACE_SEP)[-1]


def slash_command(full: str) -> str:
    """按 Hermes 生成斜杠命令的同一套规则，算出技能名对应的 /命令。"""
    slug = full.lower().replace(" ", "-").replace("_", "-")
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return f"/{slug}"


def rewrite_refs(text: str, plugin: str, mapping: Dict[str, str]) -> Tuple[str, int]:
    """把正文里「套件:旧名」的引用换成安装后的完整名字，返回新文本和替换次数。"""
    if not mapping:
        return text, 0
    alternatives = "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
    pattern = re.compile(rf"(?<![\w/.-]){re.escape(plugin)}:({alternatives})(?![\w-])")
    return pattern.subn(lambda m: mapping[m.group(1)], text)


def ref_mapping(plugin: str, skills: Iterable[Tuple[str, str]], agents: Iterable[Tuple[str, str]]) -> Dict[str, str]:
    """生成 {原名: 安装后完整名} 的对照表，技能优先，子代理名不覆盖同名技能。"""
    mapping: Dict[str, str] = {}
    for bare, full in skills:
        mapping[bare] = full
    for agent, full in agents:
        mapping.setdefault(agent, full)
    return mapping
