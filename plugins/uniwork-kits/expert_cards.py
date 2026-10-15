"""What users see of an expert: a name that says what it does, and prompts they can read.

Expert packages give each persona a character name (福帮手, 严估深, 种草草…)
and put the job in ``profession``. A user scanning the Bots list or the summon
picker cannot tell what 福帮手 does, so an expert is named by its job: the
profession, with a ``<job>-<maker>`` profession split into the name and a
subtitle (``基金诊断专家-东方财富妙想`` → 基金诊断专家 · 东方财富妙想). The
same name is pinned as what the expert calls itself (``host_rules.identity_line``),
so the card and the conversation agree.

``CARDS`` fixes the few bundled experts the rule alone gets wrong — a job
that is not phrased as an expert, a name too long for the Bots list — and
replaces prompts written for WorkBuddy's own workflow vocabulary (续接胶囊,
回执, "本次WorkBuddy任务") with requests a user would actually type, or
patches a phrase (``replace``) that still calls the expert by its old title.
The package itself is left untouched; this only changes what installing shows.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Tuple

CARDS: Dict[str, Dict[str, Any]] = {
    "douyin-strategist": {"name": "抖音运营专家", "replace": {"请抖音战略家帮我们": "请帮我们"}},
    "mx-market-intelligence": {"name": "市场情报专家", "subtitle": "东方财富妙想"},
    "long-manuscript-expert": {
        "name": "长文档写作专家",
        "init_prompt": (
            "我想把手头的文档、扫描件、图片或表格整理成一份长文档。"
            "请先说明你能读到哪些材料，再给出目录和正文，标出拿不准的地方，最后告诉我下一步做什么。"
        ),
        "quick_prompts": [
            "我想把手头的文档、扫描件、图片或表格整理成一份长文档。"
            "请先说明你能读到哪些材料，再给出目录和正文，标出拿不准的地方，最后告诉我下一步做什么。",
            "接着上次的进度继续写我的稿子；只改我指定的部分，其他内容保持不变。",
            "帮我检查这份成稿的结构、连贯性和可读性，列出最该改的问题，并直接给出改好的文字。",
        ],
    },
}

_MAKER_SEPARATORS = ("-", "－", "—")


def _localized(value: object) -> str:
    from .host_rules import localized

    return localized(value)


def card_name(plugin: str, persona: Mapping[str, Any]) -> Tuple[str, str]:
    """``(name, subtitle)`` an installed expert is shown and addressed by."""
    card = CARDS.get(plugin, {})
    if card.get("name"):
        return str(card["name"]), str(card.get("subtitle") or "")
    profession = _localized(persona.get("profession"))
    if not profession:
        return _localized(persona.get("displayName")) or plugin, ""
    for sep in _MAKER_SEPARATORS:
        job, found, maker = profession.partition(sep)
        if found and job.strip() and maker.strip():
            return job.strip(), maker.strip()
    return profession, ""


def intro(plugin: str, persona: Mapping[str, Any]) -> Dict[str, Any]:
    """What summoning shows: description, opening prompt, quick prompts, tags (Chinese first)."""

    card = CARDS.get(plugin, {})
    replace: Mapping[str, str] = card.get("replace") or {}

    def patched(text: str) -> str:
        for old, new in replace.items():
            text = text.replace(old, new)
        return text

    def texts(value: Any) -> List[str]:
        items = value if isinstance(value, list) else []
        return [patched(text) for text in (_localized(item) for item in items) if text]

    return {
        "description": _localized(persona.get("displayDescription")),
        "init_prompt": str(card.get("init_prompt") or patched(_localized(persona.get("defaultInitPrompt")))),
        "quick_prompts": list(card.get("quick_prompts") or texts(persona.get("quickPrompts")))[:6],
        "tags": texts(persona.get("tags"))[:6],
    }
