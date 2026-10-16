"""Per-turn kit hints for ordinary conversations (UniClaw hit-rate layer 2).

Ported from UniClaw ``reminders/plugin_router.py``: code matches the latest
user message against the Chinese trigger phrases stored at install time and
offers at most three installed capabilities; the model still decides. Nothing
matches → nothing is injected.

Hermes delivery: a ``pre_llm_call`` hook. Its return value is appended to the
current user message only, so the cached prefix (system prompt, earlier turns)
is never touched.

Boundaries:

* A profile that *is* an expert gets no hint — the expert routes its own
  skills, and kits are not installed there anyway.
* The hook has no ``profile_name`` in its payload, so the profile is taken from
  ``get_hermes_home()``. That is the session's own home on every surface: the
  CLI runs one profile per process, and the desktop backend sets the session's
  HERMES_HOME override on the turn thread before the agent loop (and so this
  hook) runs (``tui_gateway/server.py`` ``_run_prompt_submit``).
* Off switch: ``uniwork_kits.router: false`` in config.yaml.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import delivery, media_slot, naming, store, turns

logger = logging.getLogger(__name__)

_MAX_HINTS = 3
_SCORE_VERBATIM = 3
_SCORE_STRONG = 3
_SCORE_FUZZY = 2
_MIN_SCORE = 3
_STRONG_RATIO = 0.7
_FUZZY_RATIO = 0.6

_AUTHOR_TRIGGER_RE = re.compile(r"触发词[：:]\s*([^\n。]+)")
_PHRASE_SPLIT_RE = re.compile(r"[、,，;；/|]")

_KIND_LABEL = {"skill": "技能", "agent": "派工技能", "mcp": "MCP 服务"}


@dataclass(frozen=True)
class Candidate:
    plugin: str
    kind: str        # skill | agent | mcp
    label: str       # skill full name, or MCP config key
    phrases: Tuple[str, ...]


def author_phrases(description: str) -> List[str]:
    """Trigger phrases a package author wrote into a description (``触发词：a、b``)."""
    match = _AUTHOR_TRIGGER_RE.search(description or "")
    if not match:
        return []
    out = []
    for raw in _PHRASE_SPLIT_RE.split(match.group(1)):
        phrase = raw.strip().strip("。.，,、 ")
        if 2 <= len(phrase) <= 16:
            out.append(phrase)
    return out


def catalog_from_index(index: Dict[str, Any]) -> Tuple[Candidate, ...]:
    """Every enabled kit capability with its phrases, from one home's registry."""
    out: List[Candidate] = []
    for name, entry in sorted((index.get("plugins") or {}).items()):
        if not isinstance(entry, dict) or entry.get("kind") not in ("kit", "team") or not entry.get("enabled", True):
            continue
        triggers = entry.get("triggers") if isinstance(entry.get("triggers"), dict) else {}
        for skill in entry.get("skill_names") or []:
            out.append(Candidate(name, "skill", skill, tuple(triggers.get(skill) or ())))
        for skill in entry.get("agent_skill_names") or []:
            out.append(Candidate(name, "agent", skill, tuple(triggers.get(skill) or ())))
        for key in entry.get("mcp_keys") or []:
            out.append(Candidate(name, "mcp", key, tuple(triggers.get(key) or ())))
    return tuple(out)


def _bigrams(text: str) -> set:
    return {text[i : i + 2] for i in range(len(text) - 1)}


# Hermes-side extensions to UniClaw's scorer (its thresholds are kept as-is):
#
# * Two weak signals add up. UniClaw's comment says a weak overlap "only ever
#   contributes", but its code takes the single best score, so a fuzzy match
#   never fires. Here two *different* phrases each overlapping ≥ 0.5 count as a
#   strong match ("帮我审查一下这段代码" vs 「帮我看看这段代码」0.57 and
#   「审查一下代码质量」0.57). One weak phrase alone still never fires, which keeps
#   UniClaw's measured negative ("帮我看看这段话通不通顺" vs 「帮我看看代码」).
# * A phrase's core term counts verbatim. Spoken fillers are stripped
#   (「看看K线」→ "K线", 「今日资金流向」→ "资金流向"); the core fires when it
#   appears in the message and is specific enough: ≥ 3 characters, or ≥ 2 with
#   a Latin letter / digit ("K线", "PPT"). Two-character Chinese cores such as
#   "代码" are too common to fire alone.
# * A high bigram ratio is a strong match only when every character of that
#   core also occurs in the message. Otherwise a shared tail scores as if the
#   whole phrase matched ("测试一下这段代码" vs 「帮我审查一下这段代码」is 0.71,
#   but 「测试」never appears). The overlap stays a weak signal, so two of them
#   can still add up.
# * Content words that all occur, just not as one span, are a strong match once
#   the overlap is already in the fuzzy band ("代码审查" inside 「审查一下这段代码」
#   is 0.67 because the bridging bigram 「码审」is missing). The two-character
#   exclusion above still applies.
_PAIR_RATIO = 0.5
_FILLERS = (
    "帮我", "帮忙", "麻烦", "请", "给我", "我想", "我要", "想要", "看看", "看一下", "查一下", "查查", "查询",
    "一下", "今日", "今天", "最新", "现在", "怎么", "如何", "能不能", "可以", "做个", "做一份", "写个", "来个",
)
_LATIN_RE = re.compile(r"[A-Za-z0-9]")


def core_term(phrase: str) -> str:
    core = phrase.strip()
    changed = True
    while changed and core:
        changed = False
        for filler in _FILLERS:
            if core.startswith(filler) and len(core) > len(filler):
                core, changed = core[len(filler):], True
            if core.endswith(filler) and len(core) > len(filler):
                core, changed = core[: -len(filler)], True
    return core.strip("的了吗呢吧啊 ")


def _specific(core: str) -> bool:
    return len(core) >= 3 or (len(core) >= 2 and bool(_LATIN_RE.search(core)))


def _core_covered(core: str, lowered: str) -> bool:
    """Every character of a specific core occurs in the message."""
    return _specific(core) and all(ch.lower() in lowered for ch in core)


def score(candidate: Candidate, text: str, lowered: str) -> int:
    best = 0
    grams_text = _bigrams(text)
    near_misses = 0
    for phrase in candidate.phrases:
        if phrase in text or phrase.lower() in lowered:
            best = max(best, _SCORE_VERBATIM)
            continue
        core = core_term(phrase)
        if core != phrase and _specific(core) and core.lower() in lowered:
            best = max(best, _SCORE_STRONG)
            continue
        grams = _bigrams(phrase)
        if not grams:
            continue
        ratio = len(grams & grams_text) / len(grams)
        if ratio >= _PAIR_RATIO:
            near_misses += 1
        covered = _core_covered(core, lowered)
        if ratio >= _STRONG_RATIO and covered:
            best = max(best, _SCORE_STRONG)
        elif ratio >= _STRONG_RATIO:
            best = max(best, _SCORE_FUZZY)
        elif covered and ratio >= _FUZZY_RATIO:
            best = max(best, _SCORE_STRONG)
        elif ratio >= _FUZZY_RATIO:
            best = max(best, _SCORE_FUZZY)
    if near_misses >= 2:
        best = max(best, _SCORE_STRONG)
    bare = naming.bare_of(candidate.label).lower()
    if candidate.kind == "agent" and bare.startswith("agent-"):
        bare = bare[len("agent-"):]
    if len(bare) >= 4 and bare in lowered:
        best = max(best, _SCORE_VERBATIM)
    return best


def _line(candidate: Candidate) -> str:
    kind = _KIND_LABEL.get(candidate.kind, candidate.kind)
    if candidate.kind == "skill":
        return f"- {kind} `{candidate.label}` → 用 `skill_view` 加载"
    if candidate.kind == "agent":
        return f"- {kind} `{candidate.label}` → 用 `skill_view` 加载后按说明用 `delegate_task` 派工"
    safe = re.sub(r"[^A-Za-z0-9_]", "_", candidate.label)
    return (
        f"- {kind} `{candidate.label}` → 工具名以 `mcp__{safe}__` 开头；工具列表里没有就在 `tool_search` 的目录里，"
        "用 `tool_describe` 取参数后 `tool_call` 调用"
    )


def build_hint(text: str, catalog: Iterable[Candidate]) -> Optional[str]:
    if not text:
        return None
    lowered = text.lower()
    scored = sorted(((score(c, text, lowered), c) for c in catalog), key=lambda p: (-p[0], p[1].label))
    hits: List[Candidate] = []
    seen: set = set()
    for value, candidate in scored:
        if value < _MIN_SCORE:
            break
        ident = (candidate.kind, candidate.label)
        if ident in seen:
            continue
        seen.add(ident)
        hits.append(candidate)
        if len(hits) == _MAX_HINTS:
            break
    if not hits:
        return None
    return (
        "本轮请求可能用到以下已装套件能力（按需使用，不强制；判断不相关就忽略）：\n"
        + "\n".join(_line(c) for c in hits)
    )


# One entry per profile home: a desktop backend alternates between profiles.
_memo: Dict[str, Tuple[int, Tuple[Candidate, ...], bool]] = {}


def _load(home: Path) -> Tuple[Tuple[Candidate, ...], bool]:
    """``(catalog, is_expert_profile)`` for *home*, memoised on the index mtime."""
    path = store.index_path(home)
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return (), False
    cached = _memo.get(str(path))
    if cached is not None and cached[0] == mtime:
        return cached[1], cached[2]
    index = store.load_index(home)
    result = (catalog_from_index(index), store.self_expert(index) is not None)
    _memo[str(path)] = (mtime, result[0], result[1])
    return result


def is_expert_home(home: Path) -> bool:
    """Whether *home* is a profile an expert was installed as."""
    return _load(home)[1]


_PPT_INTENT_RE = re.compile(
    r"幻灯片|演示文稿|课件|(?<![A-Za-z])(?:pptx?|powerpoint|slides?|slide\s+deck|pitch\s+deck|presentation)(?![A-Za-z])",
    re.IGNORECASE,
)


def names_a_deck(text: str) -> bool:
    """Whether *text* says the deliverable is a slide deck."""
    return bool(text) and _PPT_INTENT_RE.search(text) is not None


def _user_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    if not isinstance(message, dict) or message.get("role") not in (None, "user"):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    return ""


def deck_requested(user_message: str, history: Any) -> bool:
    """A deck named in this turn, or earlier in the same conversation."""
    if names_a_deck(user_message):
        return True
    if not isinstance(history, list):
        return False
    return any(names_a_deck(_user_text(item)) for item in history)


def pictures_enabled() -> bool:
    return _pictures_enabled()


def _pictures_enabled() -> bool:
    try:
        from hermes_cli.config import load_config_readonly

        section = (load_config_readonly() or {}).get("uniwork_kits") or {}
        return isinstance(section, dict) and section.get("pictures", True) is not False
    except Exception:
        return True


def _router_enabled() -> bool:
    try:
        from hermes_cli.config import load_config_readonly

        section = (load_config_readonly() or {}).get("uniwork_kits") or {}
        return isinstance(section, dict) and section.get("router", True) is not False
    except Exception:
        return True


def on_pre_llm_call(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Suggest kit skills, and attach PPT picture rules when this turn is a deck.

    Picture rules name whatever :func:`media_slot.load_slot` currently says.
    An expert profile gets neither: it routes itself. Either way this opens
    the session's request (:mod:`turns`) for the tool hooks that follow.
    """
    try:
        from hermes_constants import get_hermes_home

        text = str(kwargs.get("user_message") or "").strip()
        platform = str(kwargs.get("platform") or "")
        catalog, is_expert = _load(Path(get_hermes_home()))
        deck = not is_expert and deck_requested(text, kwargs.get("conversation_history"))
        turn = turns.begin(
            str(kwargs.get("session_id") or ""),
            str(kwargs.get("turn_id") or ""),
            platform=platform,
            deck=deck,
            parent_session_id=str(kwargs.get("parent_session_id") or ""),
        )
        if not text:
            return None
        if is_expert:
            from . import eastmoney_slot, xiaohongshu

            home = Path(get_hermes_home())
            xiaohongshu.ensure_running(home)
            extras = [
                delivery.stale_rule_correction(home, str(kwargs.get("session_id") or ""), platform),
                xiaohongshu.turn_context(home, text),
                media_slot.picture_request_hint(text) if _pictures_enabled() else "",
                eastmoney_slot.turn_note(home),
            ]
            extra = "\n\n".join(item for item in extras if item)
            return {"context": extra} if extra else None
        parts: List[str] = []
        if _router_enabled() and catalog:
            hint = build_hint(text, catalog)
            if hint:
                parts.append(hint)
        if _pictures_enabled() and deck:
            parts.append(media_slot.picture_rules(delivery=delivery.deck_line(platform)))
            turn.rules_shown = True
        elif _pictures_enabled():
            parts.append(media_slot.picture_request_hint(text))
        parts = [part for part in parts if part]
        return {"context": "\n\n".join(parts)} if parts else None
    except Exception:  # never break a turn over a suggestion
        logger.warning("[uniwork-kits] router hint failed", exc_info=True)
        return None

