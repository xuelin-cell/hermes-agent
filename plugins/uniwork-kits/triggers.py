"""Chinese trigger phrases for installed components (UniClaw hit-rate layer 1).

Ported from UniClaw ``plugin_index.py`` (``generate`` / ``verify`` /
``refresh_plugin``):

1. The model writes 3–6 spoken Chinese phrases per component, batches of 20;
   answers are cleaned (Chinese, 2–16 characters, de-duplicated).
2. Gates drop generic phrases and phrases three or more components share.
3. A second call scores every surviving phrase 2 (precise) / 1 (related but
   vague) / 0 (wrong or misleading); only scores ≥ 1 are kept.
4. Phrases the verifier never answered for stay *unverified* and are not used.
   A component left with nothing goes back to *pending*. Both are retried on
   the next refresh of the same package, at most ``MAX_ATTEMPTS`` times; a
   changed package starts over.

Unlike UniClaw, components whose description is already Chinese are included:
Hermes shows only 60 characters of a description and the router can only match
phrases, so a Chinese description without a ``触发词：`` line would otherwise
never be suggested.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

MAX_ATTEMPTS = 3
VERIFY_MIN_SCORE = 1
_BATCH = 20
# Verification carries every candidate phrase, so a batch is ~6x the size of a
# generation batch. Measured 2026-10-12 on glm-5.3-flash (reasoning high): 11
# components / ~66 phrases in one call used 10k tokens and timed out twice at
# 180 s; 8 components took ~160 s, 3 took ~23 s. Five per call keeps a slow
# reasoning model well inside the call timeout (llm.py, 300 s).
_VERIFY_BATCH = 5
_DESC_EXCERPT = 300
_MAX_PHRASES = 6
_MIN_PHRASE_LEN = 2
_MAX_PHRASE_LEN = 16
_SHARED_LIMIT = 3

_CJK_RE = re.compile(r"[一-鿿]")
_PHRASE_SPLIT_RE = re.compile(r"[、,，;；/|]")
_PHRASE_STRIP = " \t\"'“”‘’「」『』《》【】()（）[].。!！?？:："
_ENTRY_RE = re.compile(r'"(\d+)"\s*:\s*(\[[^\[\]]*\])')
_KIND_LABEL = {"skill": "技能", "agent": "子智能体", "mcp": "MCP 工具服务"}

GENERIC_PHRASES = frozenset({
    "帮我", "处理", "管理", "分析", "工具", "助手", "功能", "文档", "报告", "数据", "操作", "使用",
    "设置", "查询", "任务", "项目", "工作", "内容", "信息", "问题", "优化", "生成", "创建", "编辑",
    "查看", "搜索", "检查", "写作", "总结", "数据分析", "帮我处理", "帮我分析", "处理数据", "生成报告",
})

Invoke = Callable[[str], Optional[str]]


@dataclass(frozen=True)
class Component:
    key: str          # the installed full name (skill / dispatch skill) or MCP key
    kind: str         # skill | agent | mcp
    label: str
    description: str


def _excerpt(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:_DESC_EXCERPT]


def build_prompt(plugin: str, plugin_desc: str, batch: List[Component]) -> str:
    header = f"插件：{plugin}" + (f"（{_excerpt(plugin_desc)}）" if plugin_desc.strip() else "")
    lines = [
        "你在为一个中文 AI 助手整理插件能力的「中文触发词」。用户会用中文口语提需求，助手要据此判断该调用哪个能力。",
        header,
        "下面每行是一个能力，格式为「编号 | 类型 | 名称 | 说明」：",
    ]
    for i, c in enumerate(batch, 1):
        lines.append(f"{i} | {_KIND_LABEL.get(c.kind, c.kind)} | {c.label} | {_excerpt(c.description)}")
    lines.append(
        "请为每个能力写 3 到 6 个中文触发词。要求：\n"
        "1. 是用户真的会说出口的中文短语，每个 2 到 12 个字，例如「月末对账」「写事故复盘」。\n"
        "2. 覆盖不同说法，不要只把名称直译。\n"
        "3. 可以带常见英文产品名（如 Slack、Notion、Figma），但每个触发词里必须有中文。\n"
        "4. 写通用说法，不要带具体的公司、股票代码、人名、地名或作品名做例子"
        "（写「看K线」「查最新财报」，不要写「看腾讯的K线」「比亚迪最新财报」）。\n"
        "5. 只输出一个 JSON 对象：键是编号（字符串），值是触发词数组。不要输出解释，不要代码块标记。"
    )
    # Rule 4 is not in UniClaw's prompt. Measured 2026-10-12: without it the
    # model wrote 「看看腾讯的K线」「比亚迪最新财报」, which never match a user who
    # names another company, so the router stayed silent on 「宁德时代的K线」.
    return "\n".join(lines)


def _json_object(text: str) -> Optional[Dict[str, Any]]:
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start : end + 1])
        except ValueError:
            pass
        else:
            return data if isinstance(data, dict) else None
    salvaged: Dict[str, Any] = {}
    for m in _ENTRY_RE.finditer(text):
        try:
            salvaged[m.group(1)] = json.loads(m.group(2))
        except ValueError:
            continue
    return salvaged or None


def clean_phrases(raw: List[object]) -> List[str]:
    out: List[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        for part in _PHRASE_SPLIT_RE.split(item):
            phrase = re.sub(r"\s+", " ", part).strip(_PHRASE_STRIP)
            if not _CJK_RE.search(phrase):
                continue
            if not _MIN_PHRASE_LEN <= len(phrase) <= _MAX_PHRASE_LEN or phrase in out:
                continue
            out.append(phrase)
            if len(out) >= _MAX_PHRASES:
                return out
    return out


def parse_phrases(text: str, count: int) -> Dict[int, List[str]]:
    data = _json_object(text or "")
    if data is None:
        return {}
    out: Dict[int, List[str]] = {}
    for key, value in data.items():
        try:
            idx = int(str(key).strip())
        except ValueError:
            continue
        if 1 <= idx <= count and isinstance(value, list):
            phrases = clean_phrases(value)
            if phrases:
                out[idx] = phrases
    return out


def apply_gates(phrases_by_key: Dict[str, List[str]]) -> Dict[str, List[str]]:
    specific = {k: [p for p in v if p not in GENERIC_PHRASES] for k, v in phrases_by_key.items()}
    shared = Counter(p for phrases in specific.values() for p in set(phrases))
    out: Dict[str, List[str]] = {}
    for key, phrases in specific.items():
        kept = [p for p in phrases if shared[p] < _SHARED_LIMIT]
        if kept:
            out[key] = kept
    return out


def _ask(invoke: Invoke, prompt: str) -> Optional[str]:
    try:
        return invoke(prompt)
    except Exception:
        return None


def generate(plugin: str, plugin_desc: str, components: List[Component], invoke: Invoke) -> Tuple[Dict[str, List[str]], bool]:
    """``({component key: phrases}, answered)`` — raw, ungated. Never raises."""
    raw: Dict[str, List[str]] = {}
    answered = False
    for start in range(0, len(components), _BATCH):
        batch = components[start : start + _BATCH]
        answer = _ask(invoke, build_prompt(plugin, plugin_desc, batch))
        if not answer:
            continue
        answered = True
        for idx, phrases in parse_phrases(answer, len(batch)).items():
            raw[batch[idx - 1].key] = phrases
    return raw, answered


_VERIFY_HEAD = (
    "你在审核一批「中文触发词」。用途：用户用中文口语提需求时，助手靠这些词判断该调用哪个能力。\n"
    "请逐个给触发词打分：\n"
    "2 = 准确：用户说出这句话，确实就是想要这个能力，而且不太会被理解成同一插件里的别的能力\n"
    "1 = 勉强：和这个能力有关，但太泛（很多能力都适用），或说法生硬、用户不太会这么说\n"
    "0 = 不对：意思和这个能力不符，或者会误导到别的能力\n"
    "只输出一个 JSON 对象：键是能力编号（字符串），值是与候选顺序一致的分数数组（只含 0、1、2）。不要输出其他任何内容。"
)


def build_verify_prompt(plugin: str, plugin_desc: str, items: List[Tuple[Component, List[str]]]) -> str:
    header = f"插件：{plugin}" + (f"（{_excerpt(plugin_desc)}）" if plugin_desc.strip() else "")
    lines = [_VERIFY_HEAD, header, ""]
    for i, (c, phrases) in enumerate(items, 1):
        candidates = "；".join(f"{j}) {p}" for j, p in enumerate(phrases, 1))
        lines.append(
            f"能力 {i} | {_KIND_LABEL.get(c.kind, c.kind)} | {c.label} | {_excerpt(c.description)}\n  候选：{candidates}"
        )
    return "\n".join(lines)


def parse_verdicts(text: str, items: List[Tuple[Component, List[str]]]) -> Dict[str, List[int]]:
    """Scores per component key; an entry whose length does not match its candidates is ignored."""
    data = _json_object(text or "")
    if data is None:
        return {}
    out: Dict[str, List[int]] = {}
    for key, value in data.items():
        try:
            idx = int(str(key).strip())
        except ValueError:
            continue
        if not 1 <= idx <= len(items):
            continue
        component, phrases = items[idx - 1]
        if not isinstance(value, list) or len(value) != len(phrases):
            continue
        try:
            out[component.key] = [max(0, min(2, int(v))) for v in value]
        except (TypeError, ValueError):
            continue
    return out


def verify(plugin: str, plugin_desc: str, items: List[Tuple[Component, List[str]]],
           invoke: Invoke) -> Tuple[Dict[str, List[str]], bool]:
    """``({key: kept phrases}, answered)``; a key absent was not checked."""
    kept: Dict[str, List[str]] = {}
    answered = False
    for start in range(0, len(items), _VERIFY_BATCH):
        batch = items[start : start + _VERIFY_BATCH]
        answer = _ask(invoke, build_verify_prompt(plugin, plugin_desc, batch))
        if not answer:
            continue
        answered = True
        phrases_by_key = {c.key: phrases for c, phrases in batch}
        for key, scores in parse_verdicts(answer, batch).items():
            kept[key] = [p for p, s in zip(phrases_by_key[key], scores) if s >= VERIFY_MIN_SCORE]
    return kept, answered


@dataclass
class TriggerState:
    """Model-made phrases for one installed package (author / imported ones live elsewhere)."""

    triggers: Dict[str, List[str]] = field(default_factory=dict)     # verified, in use
    unverified: Dict[str, List[str]] = field(default_factory=dict)   # waiting for the verifier
    pending: List[str] = field(default_factory=list)                 # need (re)generation
    attempts: int = 0
    stats: Dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Any) -> "TriggerState":
        data = data if isinstance(data, dict) else {}

        def phrases(value: Any) -> Dict[str, List[str]]:
            return {str(k): [p for p in v if isinstance(p, str)] for k, v in (value or {}).items() if isinstance(v, list)}

        return cls(
            triggers=phrases(data.get("triggers")),
            unverified=phrases(data.get("unverified")),
            pending=[str(k) for k in data.get("pending") or []],
            attempts=int(data.get("attempts") or 0),
            stats={str(k): int(v) for k, v in (data.get("stats") or {}).items() if isinstance(v, int)},
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "triggers": self.triggers,
            "unverified": self.unverified,
            "pending": self.pending,
            "attempts": self.attempts,
            "stats": self.stats,
        }

    @property
    def open(self) -> bool:
        return bool(self.pending or self.unverified)


def refresh(
    plugin: str,
    plugin_desc: str,
    components: List[Component],
    invoke: Invoke,
    *,
    previous: Optional[TriggerState] = None,
    verify_invoke: Optional[Invoke] = None,
) -> Tuple[TriggerState, bool]:
    """Bring the model-made phrases for *components* up to date.

    *previous* is the state recorded for the **same package digest**; pass
    ``None`` for a new or changed package (or to force regeneration). Returns
    ``(state, called_model)``.
    """
    by_key = {c.key: c for c in components}
    order = {c.key: i for i, c in enumerate(components)}
    if previous is not None:
        state = TriggerState(
            triggers={k: v for k, v in previous.triggers.items() if k in by_key},
            unverified={k: v for k, v in previous.unverified.items() if k in by_key},
            pending=[k for k in previous.pending if k in by_key],
            attempts=previous.attempts,
        )
        if not state.open or state.attempts >= MAX_ATTEMPTS:
            state.stats = dict(previous.stats)
            return state, False
    else:
        state = TriggerState(pending=list(by_key))

    stats: Counter = Counter()
    targets = sorted((by_key[k] for k in state.pending), key=lambda c: order[c.key])
    generated, gen_answered = generate(plugin, plugin_desc, targets, invoke) if targets else ({}, False)
    stats["generated"] = sum(len(v) for v in generated.values())

    candidate = {**state.triggers, **state.unverified, **generated}
    gated = apply_gates(candidate)
    stats["gated"] = sum(len(v) for v in candidate.values()) - sum(len(v) for v in gated.values())
    triggers = {k: v for k, v in gated.items() if k in state.triggers}
    to_verify = {k: v for k, v in gated.items() if k in generated or k in state.unverified}
    items = [(by_key[k], v) for k, v in sorted(to_verify.items(), key=lambda kv: order[kv[0]])]
    verdicts, check_answered = verify(plugin, plugin_desc, items, verify_invoke or invoke) if items else ({}, False)
    for key, kept in verdicts.items():
        stats["rejected"] += len(to_verify[key]) - len(kept)
        if kept:
            triggers[key] = kept

    called = bool(targets or items)
    if called and not gen_answered and not check_answered:
        # No model answered at all: keep the previous state for a later retry.
        keep = previous or TriggerState(pending=list(by_key))
        return TriggerState(keep.triggers, keep.unverified, keep.pending, keep.attempts, dict(keep.stats)), True

    unverified = {k: v for k, v in to_verify.items() if k not in verdicts}
    pending = [c.key for c in targets if c.key not in gated]
    pending += [k for k, kept in verdicts.items() if not kept and k not in pending]
    open_items = bool(pending or unverified)
    return TriggerState(
        triggers=dict(sorted(triggers.items(), key=lambda kv: order[kv[0]])),
        unverified=unverified,
        pending=sorted(pending, key=lambda k: order[k]),
        attempts=state.attempts + 1 if open_items else 0,
        stats=dict(stats),
    ), called
