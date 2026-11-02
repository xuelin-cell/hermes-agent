"""UniClaw search parsing, ported from uniwork_release d413208e1830fa9bc82f506cad1fc6b90e292522.

Original contributor attribution is retained in PROVENANCE.md.
"""

from __future__ import annotations
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable
from .common import _display, _parse_passage_segments

logger = logging.getLogger(__name__)


def _format_train_subdisplay(sub: dict[str, Any]) -> str:
    """格式化单个车次: G5 高铁 北京 07:42 → 上海 12:32 (4h50m) ¥672"""
    # 探针实测腾讯实际字段是 number (文档里写的 num/checi_num 跟实际不一致)
    num = sub.get("number") or sub.get("checi_num") or sub.get("num") or "?"
    train_type = sub.get("type", "")
    start_st = sub.get("start_station", "?")
    end_st = sub.get("end_station", "?")
    start_t = sub.get("start_time", "?")
    end_t = sub.get("end_time", "?")
    alltime = sub.get("alltime", "")

    header = f"{num}"
    if train_type:
        header += f" [{train_type}]"
    line = f"{header}: {start_st} {start_t} → {end_st} {end_t}"
    if alltime:
        line += f" (全程 {alltime})"

    stations = sub.get("station") or []
    if isinstance(stations, list) and stations:
        line += f" 经停 {len(stations)} 站"

    # 票价 (vrid 703300** 含 ticket.{price, ticket_type})
    ticket = sub.get("ticket") or {}
    if isinstance(ticket, dict):
        price = ticket.get("price")
        ticket_type = ticket.get("ticket_type")
        if price:
            line += f" ¥{price}"
            if ticket_type:
                line += f" ({ticket_type})"
    return line


def _render_train(item: dict[str, Any]) -> str:
    """火车时刻表卡片. 优先 passage canonical (当前 active 70083601/70330101),
    fallback 到老 display.subitem.subdisplay schema (703300/703301)."""
    canonical = _canonical_train(item)
    if canonical:
        return _format_train_canonical(canonical)

    # Fallback: 老 display.subitem.subdisplay schema
    display = _display(item)
    subitem = display.get("subitem")

    rows: list[str] = []
    if isinstance(subitem, list):
        # 703300 线路: 多个车次
        for entry in subitem[:8]:
            if not isinstance(entry, dict):
                continue
            sub = entry.get("subdisplay") or {}
            if isinstance(sub, dict):
                rows.append(_format_train_subdisplay(sub))
    elif isinstance(subitem, dict):
        # 700836/703301: 单车次
        sub = subitem.get("subdisplay") or {}
        if isinstance(sub, dict):
            rows.append(_format_train_subdisplay(sub))

    if not rows:
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""
    return "\n".join(rows)


def _clean_train_time(v: str | None) -> str | None:
    """归一化 train 站台时间: "----" / "发站" / "终点站" → None。"""
    if not v or v in ("----", "发站", "终点站"):
        return None
    return v


def _canonical_train(item: dict[str, Any]) -> dict[str, Any] | None:
    """火车卡 canonical: 2 路径, passage 优先, 老 display.subitem 兜底。

    Canonical shape (容纳单/多车次):
      {
        "trains": [
          {
            "number", "from_station", "to_station", "type",
            "depart_time", "arrive_time", "duration",
            "stops": [{"name","arrive","depart","stay"}] | None,  # 详细时刻表
            "stops_count": int | None,                              # 兜底站数
            "price": str | None, "ticket_type": str | None,         # 票价 (老 schema)
          },
          ...
        ],
        "updated", "url"
      }

    路径 1: passage (vrid 70083601/70330101, 单车次): trains 长 1, 含详细 stops.
    路径 2: display.subitem (老 vrid 703300 线路 / 703301 单车次): trains 长 1-N,
            没详细 stops 只有 station 数量 + 可能含 ticket.
    两路径全失败 → None。
    """
    # 路径 1: 新 passage variant
    canon_new = _canonical_train_passage(item)
    if canon_new:
        return canon_new
    # 路径 2: 老 display.subitem schema (路线/单车次, station 列表 + 票价)
    return _canonical_train_legacy(item)


def _canonical_train_passage(item: dict[str, Any]) -> dict[str, Any] | None:
    """passage 路径: 当前 active vrid (70083601/70330101) 单车次 + 详细 stops."""
    passage = item.get("passage")
    if not isinstance(passage, str) or not passage.strip():
        return None
    global_meta, segs = _parse_passage_segments(passage)

    number = global_meta.get("火车车次") or global_meta.get("车次")
    from_st = global_meta.get("始发站")
    to_st = global_meta.get("终点站")
    if not (number and from_st and to_st):
        return None

    stops: list[dict[str, str | None]] = []
    for seg in segs:
        if "经停站名称" not in seg:
            continue
        stops.append({
            "name": seg["经停站名称"],
            "arrive": _clean_train_time(seg.get("到站时间")),
            "depart": _clean_train_time(seg.get("发车时间")),
            "stay": _clean_train_time(seg.get("停留时长")),
        })

    train: dict[str, Any] = {
        "number": number,
        "from_station": from_st,
        "to_station": to_st,
        "type": global_meta.get("火车类型"),
        "depart_time": global_meta.get("出发时间"),
        "arrive_time": global_meta.get("到达时间"),
        "duration": global_meta.get("全程时间"),
        "stops": stops,
        "stops_count": len(stops) if stops else None,
        "price": None,  # passage variant 不带 ticket 字段
        "ticket_type": None,
    }
    return {
        "trains": [train],
        "updated": global_meta.get("数据更新时间"),
        "url": global_meta.get("PC端转跳地址") or global_meta.get("无线端转跳地址"),
    }


def _canonical_train_legacy(item: dict[str, Any]) -> dict[str, Any] | None:
    """老 display.subitem schema 路径: 路线 query (703300) 多车次 / 单车次 (703301)。

    subitem 可能是 array (多车次路线) 或 dict (单车次), 取 subdisplay 提取字段:
      number/checi_num/num, type, start_station, start_time, end_station, end_time,
      alltime, station[] (经停站, len 给数量), ticket.{price, ticket_type}
    """
    display = _display(item)
    subitem = display.get("subitem")

    subs: list[dict[str, Any]] = []
    if isinstance(subitem, list):
        for entry in subitem:
            if not isinstance(entry, dict):
                continue
            sub = entry.get("subdisplay")
            if isinstance(sub, dict):
                subs.append(sub)
    elif isinstance(subitem, dict):
        sub = subitem.get("subdisplay")
        if isinstance(sub, dict):
            subs.append(sub)

    if not subs:
        return None

    trains: list[dict[str, Any]] = []
    for sub in subs:
        # 探针实测字段是 number; 文档里写的 num/checi_num 也兜一下
        number = sub.get("number") or sub.get("checi_num") or sub.get("num")
        if not number:
            continue
        ticket = sub.get("ticket") or {}
        if not isinstance(ticket, dict):
            ticket = {}
        stations = sub.get("station") or []
        stops_count = len(stations) if isinstance(stations, list) else None
        trains.append({
            "number": number,
            "from_station": sub.get("start_station"),
            "to_station": sub.get("end_station"),
            "type": sub.get("type"),
            "depart_time": sub.get("start_time"),
            "arrive_time": sub.get("end_time"),
            "duration": sub.get("alltime"),
            "stops": None,  # 老 schema 没详细经停时刻表
            "stops_count": stops_count,
            "price": ticket.get("price"),
            "ticket_type": ticket.get("ticket_type"),
        })

    if not trains:
        return None
    return {"trains": trains, "updated": None, "url": None}


def _format_train_canonical(c: dict[str, Any]) -> str:
    """canonical → LLM 文本 (单/多车次都走这条; 详细 stops 有则展开)。"""
    parts: list[str] = []
    for t in c.get("trains", []):
        header = str(t["number"])
        if t.get("type"):
            header += f" [{t['type']}]"
        header += (
            f": {t.get('from_station') or '?'} {t.get('depart_time') or '?'} →"
            f" {t.get('to_station') or '?'} {t.get('arrive_time') or '?'}"
        )
        if t.get("duration"):
            header += f" (全程 {t['duration']})"
        if t.get("price"):
            header += f" ¥{t['price']}"
            if t.get("ticket_type"):
                header += f" ({t['ticket_type']})"
        parts.append(header)

        stops = t.get("stops") or []
        if stops:
            parts.append(f"经停 {len(stops)} 站:")
            for s in stops:
                name = s.get("name", "?")
                arr = s.get("arrive") or "—"
                dep = s.get("depart") or "—"
                stay = s.get("stay")
                line = f"  {name}  到 {arr}  发 {dep}"
                if stay:
                    line += f"  停 {stay}"
                parts.append(line)
        elif t.get("stops_count"):
            parts.append(f"  经停 {t['stops_count']} 站")
    if c.get("updated"):
        parts.append(f"更新: {c['updated']}")
    return "\n".join(parts)
