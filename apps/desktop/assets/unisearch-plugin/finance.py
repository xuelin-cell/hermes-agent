"""UniClaw search parsing, ported from uniwork_release d413208e1830fa9bc82f506cad1fc6b90e292522.

Original contributor attribution is retained in PROVENANCE.md.
"""

from __future__ import annotations
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable
from .common import (
    _QUOTE_STATS_LABELS,
    _derive_trend,
    _display,
    _info,
    _parse_passage_segments,
    _scan_side_meta,
)

logger = logging.getLogger(__name__)


def _render_stock(item: dict[str, Any]) -> str:
    """股价卡片. 优先走 passage canonical (当前 active variants 70280301/02/05),
    fallback 到老 jsonData.display_info.group[] schema (兼容历史 variant)。

    老 schema 字段:
        display_info.group[]: {name, code_stock, type, price, number_closed,
            number_open, number_high, number_low, time, key_status}
    """
    # 优先 canonical: passage 文本路径, 当前所有 active stock vrid 走这里
    canonical = _canonical_stock(item)
    if canonical:
        return _format_stock_canonical(canonical)

    # Fallback: 老 jsonData.display_info.group[] (无探针实证的历史 variant)
    info = _info(item)
    group = info.get("group") or []
    if not isinstance(group, list) or not group:
        # 兜底: 没匹配到 group 数组, dump 全部
        return json.dumps(info, ensure_ascii=False)[:800] if info else ""

    parts: list[str] = []
    for stock in group[:5]:  # 多股展示最多 5 支
        if not isinstance(stock, dict):
            continue
        name = stock.get("name", "")
        code = stock.get("code_stock", "")
        market = stock.get("type", "")  # 港股/美股/A股
        price = stock.get("price", "?")
        closed = stock.get("number_closed", "?")
        open_p = stock.get("number_open", "?")
        high = stock.get("number_high", "?")
        low = stock.get("number_low", "?")
        time_str = stock.get("time", "")
        status = stock.get("key_status", "")

        # 计算涨跌幅 (腾讯不直接返回, 用 price - closed)
        change_str = "?"
        try:
            change = float(price) - float(closed)
            pct = (change / float(closed)) * 100 if float(closed) else 0
            sign = "+" if change >= 0 else ""
            change_str = f"{sign}{change:.3f} ({sign}{pct:.2f}%)"
        except (ValueError, TypeError, ZeroDivisionError):
            pass

        header = f"{name} ({code} {market})" if code else name
        parts.append(header)
        parts.append(f"  现价: {price}  涨跌: {change_str}")
        parts.append(f"  今开 {open_p} / 昨收 {closed} / 最高 {high} / 最低 {low}")
        if time_str:
            parts.append(f"  报价时间: {time_str}")
        if status:
            parts.append(f"  状态: {status}")

    return "\n".join(parts) if parts else json.dumps(info, ensure_ascii=False)[:800]


def _render_exchangerate(item: dict[str, Any]) -> str:
    """汇率卡片. 优先 passage canonical (当前 active 70269501),
    fallback 到老 jsonData.display_info.tab_location[] schema."""
    canonical = _canonical_exchangerate(item)
    if canonical:
        return _format_quote_canonical(canonical)

    # Fallback: 老 jsonData.display_info.tab_location[]
    info = _info(item)
    source = info.get("source", "")
    tabs = info.get("tab_location") or []
    if not isinstance(tabs, list) or not tabs:
        return json.dumps(info, ensure_ascii=False)[:800] if info else ""

    parts: list[str] = []
    tab = tabs[0] if isinstance(tabs[0], dict) else {}
    current = tab.get("current") or []
    if isinstance(current, list) and current:
        cur = current[0] if isinstance(current[0], dict) else {}
        unit = cur.get("unit", "?")
        rate = cur.get("number_info", "?")
        pct = cur.get("number_per", "")
        rng = cur.get("range", "")
        status = cur.get("key_status", "")
        # 方向箭头
        arrow = {"up": "↑", "down": "↓", "draw": "→"}.get(status, "")
        change_str = f"{arrow} {rng} ({pct})".strip() if rng or pct else ""
        parts.append(f"{unit} 当前汇率: {rate} {change_str}".rstrip())

    listing = tab.get("list") or []
    if isinstance(listing, list) and listing:
        details = []
        for entry in listing:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name", "?")
            value = entry.get("value", "?")
            details.append(f"{name} {value}")
        if details:
            parts.append("当日: " + " / ".join(details))

    if source:
        parts.append(f"数据源: {source}")

    return "\n".join(parts) if parts else json.dumps(info, ensure_ascii=False)[:800]


def _render_gold(item: dict[str, Any]) -> str:
    """黄金/贵金属价格卡片. 优先 passage canonical (当前 active 70227501 quote +
    70099201 merchant), fallback 到老 jsonData/display schema."""
    canonical = _canonical_gold(item)
    if canonical:
        return _format_gold_canonical(canonical)

    # Fallback: 老 schema (jsonData.display_info.tab_location 或 display.subitem.subdisplay)
    info = _info(item)
    if info.get("tab_location"):
        return _render_exchangerate(item)

    # 旧版 fallback (700992** 多商家黄金报价)
    display = _display(item)
    subitem = display.get("subitem") or {}
    if not isinstance(subitem, dict):
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""

    sub_display = subitem.get("subdisplay") or {}
    if not isinstance(sub_display, dict):
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""

    parts: list[str] = []
    date = sub_display.get("date", "")
    if date:
        parts.append(f"日期: {date}")

    tabs = sub_display.get("tab") or []
    for tab in tabs[:3] if isinstance(tabs, list) else []:
        if not isinstance(tab, dict):
            continue
        tab_type = tab.get("type", "")
        if tab_type:
            parts.append(f"\n{tab_type}:")
        symbols = tab.get("symbol") or []
        for s in symbols[:5] if isinstance(symbols, list) else []:
            if not isinstance(s, dict):
                continue
            name = s.get("name", "")
            price = s.get("price", "")
            shop = s.get("shopname", "")
            updown = s.get("updown", "")
            line = f"  {name} {price}".strip()
            if updown:
                line += f" {updown}"
            if shop:
                line += f" ({shop})"
            parts.append(line)

    if not parts:
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""
    return "\n".join(parts)


def _canonical_stock(item: dict[str, Any]) -> dict[str, Any] | None:
    """股票卡 canonical: passage 全 "# key：value" 行 KV 解析。

    必需字段: 股票名称 + 实时股价 (缺则返回 None)。
    """
    passage = item.get("passage")
    if not isinstance(passage, str) or not passage.strip():
        return None
    global_meta, _ = _parse_passage_segments(passage)

    name = global_meta.get("股票名称")
    price = global_meta.get("实时股价")
    if not name or not price:
        return None

    change_value = global_meta.get("涨跌额")
    return {
        "name": name,
        "code": global_meta.get("股票代码"),
        "code_prefix": global_meta.get("股票代码前缀"),  # sh / sz / hk
        "market": global_meta.get("股票类型"),  # A股 / 港股 / 美股
        "price": price,
        "change_value": change_value,
        "change_pct": global_meta.get("涨跌幅"),
        "trend": _derive_trend(change_value),
        "trade_status": global_meta.get("交易状态"),
        "updated": global_meta.get("更新时间"),
        "open": global_meta.get("今日开盘价"),
        "prev_close": global_meta.get("昨日收盘价"),
        "high": global_meta.get("今日最高价"),
        "low": global_meta.get("今日最低价"),
        "volume": global_meta.get("成交量"),
        "pe_ttm": global_meta.get("市盈率TTM"),
        "market_cap": global_meta.get("总市值"),
        "url": global_meta.get("详情页地址"),
    }


def _format_stock_canonical(c: dict[str, Any]) -> str:
    """canonical → LLM 友好的多行文本 (跟前端卡数据同源)。"""
    parts: list[str] = []
    header = c["name"]
    if c.get("code") and c.get("market"):
        header += f" ({c['code']} {c['market']})"
    elif c.get("code"):
        header += f" ({c['code']})"
    parts.append(header)

    change_bits: list[str] = []
    if c.get("change_value"):
        change_bits.append(str(c["change_value"]))
    if c.get("change_pct"):
        change_bits.append(f"({c['change_pct']}%)")
    change_str = f"  涨跌: {' '.join(change_bits)}" if change_bits else ""
    parts.append(f"  现价: {c['price']}{change_str}")

    range_parts: list[str] = []
    for label, key in (
        ("今开", "open"),
        ("昨收", "prev_close"),
        ("最高", "high"),
        ("最低", "low"),
    ):
        if c.get(key):
            range_parts.append(f"{label} {c[key]}")
    if range_parts:
        parts.append("  " + " / ".join(range_parts))
    if c.get("updated"):
        parts.append(f"  更新: {c['updated']}")
    if c.get("trade_status"):
        parts.append(f"  状态: {c['trade_status']}")
    return "\n".join(parts)


def _canonical_exchangerate(item: dict[str, Any]) -> dict[str, Any] | None:
    """汇率卡 canonical: passage 含 latest 段 + 4 个 stats 段。

    必需字段: latest segment 含 "汇率" (缺则 None)。
    canonical shape 跟 gold-quote 对齐 (都用 quotes: [{...}]), 前端共用 QuoteCard.
    汇率天然 1 个 quote, gold 可能 2 个 (国内+国际)。
    """
    passage = item.get("passage")
    if not isinstance(passage, str) or not passage.strip():
        return None
    global_meta, segs = _parse_passage_segments(passage)

    latest_seg: dict[str, str] | None = None
    stats: list[dict[str, str | None]] = []
    for seg in segs:
        if "汇率" in seg and latest_seg is None:
            latest_seg = seg
        elif seg.get("汇率值类型") in _QUOTE_STATS_LABELS and "汇率值" in seg:
            stats.append({
                "label": seg["汇率值类型"],
                "value": seg.get("汇率值"),
                "trend": seg.get("涨跌状态"),
            })

    if not latest_seg or not latest_seg.get("汇率"):
        return None

    change_value = latest_seg.get("涨跌值")
    pair = (
        latest_seg.get("汇率值类型")
        or latest_seg.get("外汇兑换币种")
        or global_meta.get("外汇兑换")
    )

    side = _scan_side_meta(segs, ("更新时间戳", "交易状态"))
    return {
        "name": pair or "外汇",
        "quotes": [
            {
                "label": None,  # 汇率不分子组
                "value": latest_seg.get("汇率"),
                "unit": None,
                "trend": latest_seg.get("涨跌状态") or _derive_trend(change_value),
                "change_value": change_value,
                "change_pct": latest_seg.get("涨跌幅"),
                "stats": stats,
            }
        ],
        "source": global_meta.get("数据来源"),
        "updated": side.get("更新时间戳") or global_meta.get("更新时间戳"),
        "trade_status": side.get("交易状态") or global_meta.get("交易状态"),
        "url": global_meta.get("跳转地址") or latest_seg.get("跳转地址"),
    }


def _canonical_gold(item: dict[str, Any]) -> dict[str, Any] | None:
    """金价卡 canonical: 2 sub-style (quote / merchant), 自动分流。

    Discriminator:
      - global_meta 有 "贵金属名称" → quote (70227501)
      - segs 任一含 "在售商家类型"   → merchant (70099201)
    """
    passage = item.get("passage")
    if not isinstance(passage, str) or not passage.strip():
        return None
    global_meta, segs = _parse_passage_segments(passage)

    if global_meta.get("贵金属名称"):
        return _canonical_gold_quote(global_meta, segs)
    if any("在售商家类型" in s for s in segs):
        return _canonical_gold_merchant(global_meta, segs)
    return None


def _canonical_gold_quote(
    global_meta: dict[str, str], segs: list[dict[str, str]]
) -> dict[str, Any] | None:
    """gold quote-style (70227501): 1-2 个价格 (国内/国际), 每个 latest + 4 stats."""
    quotes: list[dict[str, Any]] = []
    current_quote: dict[str, Any] | None = None
    current_stats: list[dict[str, str | None]] = []

    # 切换报价段时先收齐本组统计项，避免混入下一报价。
    def _flush() -> None:
        nonlocal current_quote, current_stats
        if current_quote is not None:
            current_quote["stats"] = current_stats
            quotes.append(current_quote)
        current_quote = None
        current_stats = []

    for seg in segs:
        if "价格" in seg:
            _flush()
            change_value = seg.get("涨跌值")
            current_quote = {
                "label": seg.get("价格值类型"),
                "value": seg.get("价格"),
                "unit": seg.get("价格单位"),
                "trend": seg.get("涨跌状态") or _derive_trend(change_value),
                "change_value": change_value,
                "change_pct": seg.get("涨跌幅"),
            }
        elif seg.get("价格值类型") in _QUOTE_STATS_LABELS and "价格值" in seg:
            current_stats.append({
                "label": seg["价格值类型"],
                "value": seg.get("价格值"),
                "trend": seg.get("涨跌状态"),
            })
    _flush()

    if not quotes:
        return None
    side = _scan_side_meta(segs, ("更新时间", "交易状态"))
    return {
        "style": "quote",
        "name": global_meta.get("贵金属名称") or "贵金属",
        "quotes": quotes,
        "source": global_meta.get("数据来源"),
        "updated": side.get("更新时间") or global_meta.get("更新时间"),
        "trade_status": side.get("交易状态") or global_meta.get("交易状态"),
        "url": global_meta.get("转跳地址"),
    }


def _canonical_gold_merchant(
    global_meta: dict[str, str], segs: list[dict[str, str]]
) -> dict[str, Any] | None:
    """gold merchant-style (70099201): 在售商家类型分组 → 商家列表。"""
    groups: list[dict[str, Any]] = []
    current_group: dict[str, Any] | None = None

    for seg in segs:
        if "在售商家类型" in seg:
            if current_group is not None and current_group["items"]:
                groups.append(current_group)
            current_group = {"type": seg["在售商家类型"], "items": []}
        elif "品牌名称" in seg:
            item_row = {
                "brand": seg["品牌名称"],
                "product": seg.get("商品"),
                "price": seg.get("价格（元）"),
            }
            if current_group is None:
                current_group = {"type": None, "items": [item_row]}
            else:
                current_group["items"].append(item_row)

    if current_group is not None and current_group["items"]:
        groups.append(current_group)

    if not groups:
        return None
    return {
        "style": "merchant",
        "name": "黄金",
        "merchant_groups": groups,
        "source": global_meta.get("信息来源地址"),
        "updated": global_meta.get("更新时间"),
        "url": global_meta.get("PC端转跳地址") or global_meta.get("无线端转跳地址"),
    }


def _format_quote_canonical(c: dict[str, Any]) -> str:
    """canonical (exchangerate / gold-quote 共用) → LLM 文本。"""
    parts: list[str] = [str(c.get("name", "?"))]
    for q in c.get("quotes", []):
        value = q.get("value", "?")
        unit = q.get("unit") or ""
        label = q.get("label")
        trend = q.get("trend", "draw")
        arrow = {"up": "↑", "down": "↓", "draw": "→"}.get(trend, "")
        change_bits = [b for b in (q.get("change_value"), q.get("change_pct")) if b]
        change_str = f" {arrow} {' '.join(change_bits)}" if change_bits else ""
        prefix = f"  {label}: " if label else "  "
        parts.append(
            f"{prefix}{value}{(' ' + unit) if unit else ''}{change_str}".rstrip()
        )

        stats = q.get("stats") or []
        stat_strs = [f"{s['label']} {s['value']}" for s in stats if s.get("value")]
        if stat_strs:
            parts.append(f"    当日: {' / '.join(stat_strs)}")

    if c.get("source"):
        parts.append(f"  数据源: {c['source']}")
    return "\n".join(parts)


def _format_gold_merchant_canonical(c: dict[str, Any]) -> str:
    """canonical (gold merchant) → LLM 文本。"""
    parts: list[str] = [f"{c.get('name', '黄金')}价格 (多商家):"]
    for group in c.get("merchant_groups", []):
        group_type = group.get("type")
        if group_type:
            parts.append(f"\n{group_type}:")
        for it in group.get("items", [])[:8]:  # 每组最多 8 个商家
            brand = it.get("brand", "?")
            product = it.get("product") or ""
            price = it.get("price", "?")
            label = brand + (f" {product}" if product else "")
            parts.append(f"  - {label}: {price}")
    if c.get("updated"):
        parts.append(f"\n更新: {c['updated']}")
    return "\n".join(parts)


def _format_gold_canonical(c: dict[str, Any]) -> str:
    """gold canonical → LLM 文本 (按 style dispatch)。"""
    if c.get("style") == "merchant":
        return _format_gold_merchant_canonical(c)
    return _format_quote_canonical(c)
