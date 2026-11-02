"""UniClaw search parsing, ported from uniwork_release d413208e1830fa9bc82f506cad1fc6b90e292522.

Original contributor attribution is retained in PROVENANCE.md.
"""

from __future__ import annotations
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable

logger = logging.getLogger(__name__)


def _strip_redundant_modifiers(query: str) -> str:
    """剥除 LLM 给搜索词加的当下时间修饰词, 提高腾讯 VR 卡命中率.

    根本问题: 探针实测短 query (e.g. '今日金价') 命中率 100%, 但 LLM 改写后
    的长 query (e.g. '今日金价 2026年5月26日 黄金价格') 命中率 20%。
    腾讯 NLU 看长 query 命不上 VR 模板。

    剥除策略: 只剥**当年**的日期模板, 不动历史日期 (避免影响 '2022年世界杯'
    这种历史查询)。也剥除 "今日/今天/当前/最新/实时" 等表示"现在"的修饰词。

    Args:
        query: LLM 构造的搜索词。

    Returns:
        剥除冗余修饰后的搜索词。如果剥完空了, 回退到原 query 保底。
    """
    today_year = datetime.now().year
    patterns = [
        # 当年日期模板: "2026年5月26日" / "2026年5月26号" / "2026年5月"
        rf"\s*{today_year}年\d+月(?:\d+[日号])?",
        # 当年数字日期: "2026-05-26" / "2026/5/26"
        rf"\s*{today_year}[-/]\d+[-/]\d+",
        # 孤立的当年年份 (e.g. "高铁 时刻表 2026"). \b 保证不破坏 "G2026" 这种
        rf"\s*\b{today_year}\b",
        # "现在"语义修饰词 (中文)
        r"\s*(今日|今天|当前|最新|实时|目前|此刻)",
        # 英文 freshness 词 (大小写不敏感; "gold price today" 这类会压制腾讯 VR 卡)
        r"\s*\b(?i:today|latest|current|now|real[-\s]?time|live)\b",
    ]
    cleaned = query
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned)
    cleaned = cleaned.strip()
    # 罕见情况: 整个 query 全是修饰词被剥光, 回退到原 query 保底
    return cleaned or query


def _info(item: dict[str, Any]) -> dict[str, Any]:
    """便捷取 item.jsonData.display_info, 缺失返回空 dict。"""
    return (item.get("jsonData") or {}).get("display_info") or {}


def _display(item: dict[str, Any]) -> dict[str, Any]:
    """便捷取 item.display, 缺失返回空 dict。"""
    return item.get("display") or {}


def _parse_passage_segments(
    passage: str,
) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Parse Tencent VR passage text into (global_meta, segments).

    Args:
        passage: passage 文本, 形如 "# k：v\\n# k：v\\n\\nk：v\\nk：v\\n..."

    Returns:
        - global_meta: 顶层 "# k：v" 行汇总的 KV dict (跨所有 segment 全局)
        - segments: 每个空行分隔的 block 解析出的 KV dict 列表 (空 block 跳过)
    """
    segments = re.split(r"\n\s*\n", passage)
    global_meta: dict[str, str] = {}
    parsed_segs: list[dict[str, str]] = []

    for seg in segments:
        seg_data: dict[str, str] = {}
        for raw_line in seg.split("\n"):
            line = raw_line.strip()
            is_meta = line.startswith("#")
            content = line.lstrip("#").strip()
            if not content or "：" not in content:
                continue
            k, _, v = content.partition("：")
            k, v = k.strip(), v.strip()
            if not v:
                continue
            if is_meta:
                global_meta[k] = v
            else:
                seg_data[k] = v
        if seg_data:
            parsed_segs.append(seg_data)

    return global_meta, parsed_segs


def _derive_trend(change_value: str | None) -> str:
    """从涨跌值字符串 (e.g. "+0.12" / "-13.47" / "0.00") 推断 trend。

    返回 "up" / "down" / "draw"。无法解析 → "draw" (中性)。
    腾讯偶尔不直接给 trend 字符串, 用这个函数从数字符号反推。
    """
    if not change_value:
        return "draw"
    try:
        v = float(change_value.replace("+", "").replace("%", ""))
    except (ValueError, TypeError):
        return "draw"
    if v > 0:
        return "up"
    if v < 0:
        return "down"
    return "draw"


def _clean_emph(text: str) -> str:
    """去掉腾讯飘红标记 (unicode \\ue40a/\\ue40b 和 <em> 标签)。"""
    if not text:
        return ""
    return (
        text.replace("", "").replace("", "").replace("<em>", "").replace("</em>", "")
    )


def _parse_lemma_ambi(lemma_raw: Any) -> str:
    """解析 lemmaStructTitle JSON 字符串里的多义词列表, 返回逗号分隔的释义名。"""
    if not isinstance(lemma_raw, str) or not lemma_raw:
        return ""
    try:
        lemma = json.loads(lemma_raw)
    except (json.JSONDecodeError, AttributeError):
        return ""
    ambi_list = lemma.get("ambiList") if isinstance(lemma, dict) else None
    if not isinstance(ambi_list, list) or len(ambi_list) <= 1:
        return ""
    names = [
        f"{x.get('ambi', '')}({x.get('ambiTitle', '')})"
        for x in ambi_list[:5]
        if isinstance(x, dict)
    ]
    return ", ".join(filter(None, names))


_QUOTE_STATS_LABELS = ("最高", "最低", "昨收", "今开")


def _scan_side_meta(
    segs: list[dict[str, str]], keys: tuple[str, ...]
) -> dict[str, str]:
    """从 segments 里挑出 "side meta" 字段 (非 "# " 前缀但语义全局的字段).

    背景: 腾讯有的 passage 用 ``# 更新信息：\\n更新时间：xxx\\n交易状态：on``
    的写法 — header 是 meta, 实际数据是 non-meta 行 (会落进 seg_data 不进
    global_meta)。这个 helper 把指定 key 从任意 seg 里捞出来 (first-wins),
    canonical extractor 用它兜底 global_meta.get() 取不到的情况。
    """
    out: dict[str, str] = {}
    for seg in segs:
        for k in keys:
            v = seg.get(k)
            if v and k not in out:
                out[k] = v
    return out
