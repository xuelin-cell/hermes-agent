"""UniClaw search parsing, ported from uniwork_release d413208e1830fa9bc82f506cad1fc6b90e292522.

Original contributor attribution is retained in PROVENANCE.md.
"""

from __future__ import annotations
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable
from .common import _display, _info, _parse_passage_segments

logger = logging.getLogger(__name__)


def _normalize_intl_day(day: dict[str, Any]) -> dict[str, Any]:
    """国际版 weather day 字段名 → 国内版字段名。

    探针实测国际版 (vrid 702699**) day 元素字段:
        date, daydescription, days, description, high, low, month,
        nightdescription, week, wind, wind1
    跟国内 (number_low/number_high/summary/type_wind/...) 完全不同, 这里映射。
    国际版缺的字段 (humidity/sunrise/sunset/forbidden) 直接不映射, 渲染时自然为空。
    """
    return {
        "date": day.get("date"),
        "other_week": day.get("week"),
        "summary": day.get("description"),
        "description_day": day.get("daydescription"),
        "description_night": day.get("nightdescription"),
        "number_low": day.get("low"),
        "number_high": day.get("high"),
        "type_wind": day.get("wind"),
        "type_windlevel": day.get("wind1"),
    }


_PASSAGE_KEY_MAP: dict[str, str] = {
    # 温度
    "最低温度（摄氏度）": "temp_low",
    "最高温度（摄氏度）": "temp_high",
    "温度（摄氏度）": "temp_current",
    "体感温度（摄氏度）": "temp_feel",
    # 天气状态
    "白天天气状态": "summary",
    "夜间天气状态": "summary_night",
    "当天天气状态": "summary",  # 国际版用这个 key 名
    "国际天气预报": "summary",
    # 风
    "当日风向": "wind_direction",
    "当日风力": "wind_level",
    "白天风向": "wind_direction",
    "白天风级": "wind_level",
    "风向": "wind_direction",
    "风力": "wind_level",
    # 其它当日字段
    "湿度": "humidity",
    "空气质量": "aqi_level_today",
    "小时级空气质量等级": "aqi_level",
    "小时级空气质量值": "aqi_value",
    "尾号限行": "forbidden",
    # 日期 / 位置
    "日期": "date",
    "星期": "week",
    "城市": "city",
    "国家": "country",
    "省份": "province",
    "县镇地区（地级市以下城市名）": "town",
    # 全局元数据 (passage 里以 "# 键：值" 形式出现)
    "今日日期": "_today_date",
    "天气预报来源": "_source",
    "更新时间": "_updated",
    "日出时间": "_sunrise",
    "日落时间": "_sunset",
}


def _same_day(a: str | None, b: str | None) -> bool:
    """宽松比对两个日期串是否同一天。

    腾讯各 variant 日期格式不统一 ("2026-06-04" / "06-04" / "6月4日" / "04日"),
    统一抽出数字按 (月, 日) 比对; 任一只有单段数字时退化为按"日"比对。
    """
    if not a or not b:
        return False
    na = [int(x) for x in re.findall(r"\d+", a)]
    nb = [int(x) for x in re.findall(r"\d+", b)]
    if not na or not nb:
        return False
    if len(na) >= 2 and len(nb) >= 2:
        return na[-2:] == nb[-2:]
    return na[-1] == nb[-1]


def _parse_weather_passage(passage: str) -> dict[str, Any] | None:
    """Parse Tencent weather VR passage text into CanonicalWeather dict.

    格式: "键：值\\n" 重复, 空行分段, 顶层 "# 键：值" 是全局元数据。
    支持的 variant: 70269801 / 70269811 / 70269909 (探针验证).

    Returns:
        Canonical weather dict, or ``None`` if temp_low/temp_high/summary 都缺
        (即没识别到 day 数据)。
    """
    raw_global, raw_segs = _parse_passage_segments(passage)

    # Apply weather-specific key map: 中文 key → canonical key
    global_meta: dict[str, str] = {}
    for k, v in raw_global.items():
        mapped = _PASSAGE_KEY_MAP.get(k)
        if mapped:
            global_meta[mapped.lstrip("_")] = v

    parsed_segs: list[dict[str, str]] = []
    for raw_seg in raw_segs:
        seg_data: dict[str, str] = {}
        for k, v in raw_seg.items():
            mapped = _PASSAGE_KEY_MAP.get(k)
            if not mapped:
                continue
            if mapped.startswith("_"):
                # canonical key 标记为全局 (e.g. _updated): 即使出现在 segment
                # 也归到 global_meta, 不放进当日数据
                global_meta[mapped.lstrip("_")] = v
            else:
                seg_data[mapped] = v
        if seg_data:
            parsed_segs.append(seg_data)

    # 找出包含 day 数据的 segments (temp_low + temp_high + summary 全有才算)
    days = [
        s
        for s in parsed_segs
        if s.get("temp_low") and s.get("temp_high") and s.get("summary")
    ]
    if not days:
        return None

    # 腾讯 day 数组第一段可能是"昨天"(它把昨天也塞进预报里), 不能盲目取 days[0],
    # 否则卡片把昨天当今天 (实测 2026-06-04 北京: days[0]=06-03)。用 passage 顶层
    # "今日日期" (今日日期 → today_date) 对齐出真正的今天; 对不齐再回退 days[0] 保底。
    today_date = global_meta.get("today_date")
    today_idx = 0
    if today_date:
        for i, d in enumerate(days):
            if _same_day(d.get("date"), today_date):
                today_idx = i
                break

    today = days[today_idx]
    forecast_segs = days[today_idx + 1 : today_idx + 8]  # 今天之后最多 7 天

    # 拼地点: 优先 city, 否则 country + city, 否则 province
    location = (
        global_meta.get("city")
        or today.get("city")
        or _compose_location(global_meta, today)
    )

    # 合并 wind 字段为一个字符串
    def _wind(d: dict[str, Any]) -> str | None:
        wd = d.get("wind_direction") or global_meta.get("wind_direction")
        wl = d.get("wind_level") or global_meta.get("wind_level")
        s = " ".join(p for p in (wd, wl) if p)
        return s or None

    # 合并 aqi 字段为 "等级 数值"
    def _aqi(d: dict[str, Any]) -> str | None:
        lvl = (
            d.get("aqi_level")
            or global_meta.get("aqi_level")
            or d.get("aqi_level_today")
        )
        val = d.get("aqi_value") or global_meta.get("aqi_value")
        if lvl and val:
            return f"{lvl} {val}"
        return lvl or None

    today_out = {
        "date": today.get("date") or global_meta.get("today_date"),
        "week": today.get("week"),
        "summary": today.get("summary"),
        "temp_low": today.get("temp_low"),
        "temp_high": today.get("temp_high"),
        "wind": _wind(today),
        "humidity": today.get("humidity") or global_meta.get("humidity"),
        "aqi": _aqi(today),
        "forbidden": today.get("forbidden") or global_meta.get("forbidden"),
        "temp_feel": today.get("temp_feel") or global_meta.get("temp_feel"),
    }

    forecast_out = [
        {
            "date": d.get("date"),
            "week": d.get("week"),
            "summary": d.get("summary"),
            "temp_low": d.get("temp_low"),
            "temp_high": d.get("temp_high"),
            "wind": _wind(d),
        }
        for d in forecast_segs
    ]

    return {
        "location": location,
        "today": today_out,
        "forecast": forecast_out,
        "source": global_meta.get("source"),
        "updated": global_meta.get("updated"),
    }


def _compose_location(global_meta: dict[str, str], today: dict[str, str]) -> str | None:
    """从 country / city / province / town 字段拼出可读位置字符串。"""
    country = global_meta.get("country") or today.get("country")
    city = global_meta.get("city") or today.get("city")
    province = global_meta.get("province") or today.get("province")
    if country and city:
        return f"{country} {city}"
    return city or province or country


def _canonical_from_legacy_day(
    days: list[dict[str, Any]], location: str | None
) -> dict[str, Any] | None:
    """从老 schema 的 day[] 数组构造 canonical (兼容 70269888 等老 variant)。

    老 day 字段: number_low/number_high/summary/type_wind/type_windlevel/humidity/
    forbidden/time_sunrise/time_sunset/other_week/date。
    """
    valid = [
        d
        for d in days
        if isinstance(d, dict)
        and d.get("number_low")
        and d.get("number_high")
        and isinstance(d.get("summary") or d.get("description_day"), str)
    ]
    if not valid:
        return None

    # 跟 passage 路径同样的防御: valid[0] 可能是昨天。老 schema 没有 today_date
    # 全局字段, 用本机日期对齐出今天 (仅按月/日比对, 跟 Beijing 同天即可); 对不齐
    # 回退 valid[0] 保底 (老 display_info 路径历史上 day[0] 就是今天)。
    now = datetime.now()
    today_str = f"{now.year:04d}-{now.month:02d}-{now.day:02d}"
    today_idx = 0
    for i, d in enumerate(valid):
        if _same_day(d.get("date"), today_str):
            today_idx = i
            break

    today = valid[today_idx]

    # 只组合已有风向风力，缺失字段保持空值。
    def _wind(d: dict[str, Any]) -> str | None:
        wd = d.get("type_wind")
        wl = d.get("type_windlevel")
        s = " ".join(p for p in (wd, wl) if p)
        return s or None

    today_out = {
        "date": today.get("date"),
        "week": today.get("other_week"),
        "summary": today.get("summary") or today.get("description_day"),
        "temp_low": today.get("number_low"),
        "temp_high": today.get("number_high"),
        "wind": _wind(today),
        "humidity": f"{today.get('humidity')}%" if today.get("humidity") else None,
        "aqi": None,  # 老 schema 通常没 AQI 在 day 里
        "forbidden": today.get("forbidden")
        if today.get("forbidden") != "不限号"
        else None,
        "temp_feel": None,
    }

    forecast_out = [
        {
            "date": d.get("date"),
            "week": d.get("other_week"),
            "summary": d.get("summary") or d.get("description_day"),
            "temp_low": d.get("number_low"),
            "temp_high": d.get("number_high"),
            "wind": _wind(d),
        }
        for d in valid[today_idx + 1 : today_idx + 8]
    ]

    return {
        "location": location,
        "today": today_out,
        "forecast": forecast_out,
        "source": None,
        "updated": None,
    }


def _canonical_weather(item: dict[str, Any]) -> dict[str, Any] | None:
    """跨 variant 通用 normalize: 任意 Tencent weather VR item → CanonicalWeather.

    依次尝试 3 种 schema (找到非空即返回):
      1. 老国内 schema: jsonData.display_info.day[]
      2. 老国际 schema: display.subitem.subdisplay.day[]
      3. 新 passage 文本 (vrid 70269801 / 70269811 / 70269909, 探针验证)

    缺数据兜底: 全失败返回 None, 前端拿不到 canonical 自动跳过渲染。
    """
    # 1. 老国内 schema
    info = _info(item)
    if isinstance(info.get("day"), list) and info["day"]:
        location = (
            info.get("location") if isinstance(info.get("location"), str) else None
        )
        result = _canonical_from_legacy_day(info["day"], location)
        if result:
            return result

    # 2. 老国际 schema (display.subitem.subdisplay)
    display = _display(item)
    subitem = (
        display.get("subitem") if isinstance(display.get("subitem"), dict) else None
    )
    if subitem:
        sub_display = (
            subitem.get("subdisplay")
            if isinstance(subitem.get("subdisplay"), dict)
            else None
        )
        if sub_display and isinstance(sub_display.get("day"), list):
            normalized_days = [
                _normalize_intl_day(d)
                for d in sub_display["day"]
                if isinstance(d, dict)
            ]
            key = subitem.get("key")
            location = key.replace("_", " ") if isinstance(key, str) and key else None
            result = _canonical_from_legacy_day(normalized_days, location)
            if result:
                return result

    # 3. 新 passage schema
    passage = item.get("passage")
    if isinstance(passage, str) and passage.strip():
        return _parse_weather_passage(passage)

    return None


def _render_weather(item: dict[str, Any]) -> str:
    """天气卡片: 多日预报 + 小时级 + 地点。兼容国内/国际两种 schema:

    - 国内版 (vrid 702698**): jsonData.display_info.{location, day[], hour[]}
    - 国际版 (vrid 702699**): display.subitem.subdisplay.day[]
                              (location 从 display.subitem.key 取, 格式"国家_城市")

    实测国内 schema:
        display_info.location: str (城市名)
        display_info.day[]: {date, other_week, summary, description_day,
            description_night, number_low, number_high, type_wind,
            type_windlevel, humidity, time_sunrise, time_sunset, forbidden, ...}
        display_info.hour[]: {day_hour, time, state, temperature, value_hour_pm25}
        display_info.url: 详情页 URL
    """
    # 国内版数据位置
    info = _info(item)
    location: Any = info.get("location")
    days = info.get("day") or []
    hours = info.get("hour") or []

    # 国际版 fallback: 没拿到 day 数组 → 尝试 display.subitem.subdisplay
    if not days and not hours:
        display = _display(item)
        subitem = display.get("subitem") or {}
        if isinstance(subitem, dict):
            sub_display = subitem.get("subdisplay") or {}
            if isinstance(sub_display, dict):
                intl_days = sub_display.get("day") or []
                hours = sub_display.get("hour") or []
                # 国际版 day 字段名跟国内不一样, 映射到国内 schema
                # 国际: {low, high, description, daydescription, nightdescription,
                #        wind, wind1, week} → 国内: {number_low, number_high,
                #        summary, description_day, description_night,
                #        type_wind, type_windlevel, other_week}
                days = [
                    _normalize_intl_day(d) for d in intl_days if isinstance(d, dict)
                ]
                # location 从 subitem.key 取 ("国家_城市" 格式)
                key = subitem.get("key")
                if isinstance(key, str) and key and not location:
                    location = key.replace("_", " ")

    parts: list[str] = []
    if isinstance(location, str) and location:
        parts.append(f"地点: {location}")
    elif isinstance(location, dict):
        loc_name = location.get("name") or location.get("city") or ""
        if loc_name:
            parts.append(f"地点: {loc_name}")

    if isinstance(days, list) and days:
        parts.append("\n多日预报:")
        for d in days[:7]:  # 限制 7 天避免过长
            if not isinstance(d, dict):
                continue
            date = d.get("date", "?")
            other_week = d.get("other_week", "")
            label = f"{date}({other_week})" if other_week else date
            summary = (
                d.get("summary")
                or f"{d.get('description_day', '?')}/{d.get('description_night', '?')}"
            )
            temp = f"{d.get('number_low', '?')}~{d.get('number_high', '?')}℃"
            wind = f"{d.get('type_wind', '')} {d.get('type_windlevel', '')}".strip()
            humidity = f"湿度{d.get('humidity', '?')}%"
            forbidden = d.get("forbidden")
            extra = (
                f"  尾号限行: {forbidden}"
                if forbidden and forbidden != "不限号"
                else ""
            )
            parts.append(f"  {label}: {summary}, {temp}, {wind}, {humidity}{extra}")

        first = days[0] if isinstance(days[0], dict) else {}
        sunrise = first.get("time_sunrise")
        sunset = first.get("time_sunset")
        if sunrise or sunset:
            parts.append(f"  日出 {sunrise or '?'} | 日落 {sunset or '?'}")

    hours = info.get("hour") or []
    if isinstance(hours, list) and hours:
        parts.append("\n小时级预报 (近 6 小时):")
        for h in hours[:6]:
            if not isinstance(h, dict):
                continue
            t = h.get("time", "?")
            state = h.get("state", "?")  # 实际字段名是 state, 不是 description
            temp = h.get("temperature", "?")
            pm25 = h.get("value_hour_pm25", "")
            pm25_str = f" PM2.5={pm25}" if pm25 else ""
            parts.append(f"  {t}: {state} {temp}℃{pm25_str}")

    return "\n".join(parts) if parts else json.dumps(info, ensure_ascii=False)[:800]
