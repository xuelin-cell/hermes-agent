"""UniClaw search parsing, ported from uniwork_release d413208e1830fa9bc82f506cad1fc6b90e292522.

Original contributor attribution is retained in PROVENANCE.md.
"""

from __future__ import annotations
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable
from .common import _clean_emph, _display, _info, _parse_lemma_ambi
from .weather import _canonical_weather, _render_weather
from .finance import (
    _canonical_exchangerate,
    _canonical_gold,
    _canonical_stock,
    _render_exchangerate,
    _render_gold,
    _render_stock,
)
from .train import _canonical_train, _render_train

logger = logging.getLogger(__name__)


def _render_baike(item: dict[str, Any]) -> str:
    """百科卡片: 词条标题 + 摘要。兼容 3 个 vrid 变种:

    - 300104** (主流): display.kdJsonStr.module_list[].item_list[].data.card
    - 300102** (词条卡): display.infobox[] (含 subTitle/abstracts/lemmaStructTitle)
    - 300100** (简单文本): display.{content, abstract_info, ContentTitle, date}

    所有变种都有 display.title 顶层标题, 按优先级 (复杂→简单) 依次尝试解析。
    """
    display = _display(item)
    parts: list[str] = []

    top_title = _clean_emph(display.get("title", ""))
    top_url = display.get("url", "")
    if top_title:
        parts.append(f"词条: {top_title}")

    handled = False

    # 变种 1 (300104**): kdJsonStr.module_list[].item_list[].data.card
    kd = display.get("kdJsonStr") or {}
    if isinstance(kd, dict):
        modules = kd.get("module_list") or []
        for mod in modules if isinstance(modules, list) else []:
            if not isinstance(mod, dict):
                continue
            for it in mod.get("item_list") or []:
                if not isinstance(it, dict):
                    continue
                card = (it.get("data") or {}).get("card") or {}
                if not isinstance(card, dict):
                    continue
                title = _clean_emph(card.get("title", ""))
                sub = card.get("subTitle", "")
                abstract = card.get("abstract_info") or card.get("dynAbstract") or ""
                if title or sub or abstract:
                    if title:
                        parts.append(
                            f"释义: {title} - {sub}" if sub else f"释义: {title}"
                        )
                    if abstract:
                        snippet = abstract.replace("\n", " ").strip()
                        if len(snippet) > 800:
                            snippet = snippet[:800] + "..."
                        parts.append(f"摘要: {snippet}")
                    ambi = _parse_lemma_ambi(card.get("lemmaStructTitle"))
                    if ambi:
                        parts.append(f"其它义项: {ambi}")
                    handled = True
                    break
            if handled:
                break

    # 变种 2 (300102**): infobox 数组
    if not handled:
        infobox = display.get("infobox") or []
        if isinstance(infobox, list):
            for info in infobox:
                if not isinstance(info, dict):
                    continue
                sub_title = info.get("subTitle", "")
                abstracts = info.get("abstracts", "")
                if sub_title or abstracts:
                    if sub_title:
                        parts.append(f"释义: {sub_title}")
                    if abstracts:
                        snippet = abstracts.replace("\n", " ").strip()
                        if len(snippet) > 800:
                            snippet = snippet[:800] + "..."
                        parts.append(f"摘要: {snippet}")
                    ambi = _parse_lemma_ambi(info.get("lemmaStructTitle"))
                    if ambi:
                        parts.append(f"其它义项: {ambi}")
                    handled = True
                    break
        # 也可能 display.abstract_info 顶层有完整摘要 (跟 300100 共享)
        if not handled:
            abs_info = display.get("abstract_info", "")
            if abs_info:
                snippet = abs_info.replace("\n", " ").strip()
                if len(snippet) > 800:
                    snippet = snippet[:800] + "..."
                parts.append(f"摘要: {snippet}")
                handled = True

    # 变种 3 (300100**): display.content (简短) 兜底
    if not handled:
        content = display.get("content", "")
        if content:
            snippet = _clean_emph(content).replace("\n", " ").strip()
            if len(snippet) > 800:
                snippet = snippet[:800] + "..."
            parts.append(f"摘要: {snippet}")
            handled = True

    if top_url:
        parts.append(f"详情: {top_url}")

    if not handled and len(parts) <= 1:
        # 标题之外啥都没拿到, dump display 兜底
        return json.dumps(display, ensure_ascii=False)[:1200]
    return "\n".join(parts)


def _render_calendar(item: dict[str, Any]) -> str:
    """日历/节假日卡片 (数据在 item.display.holidays)。

    实测 schema:
        display.holidays.holiday[]: [
            {"@content": "元旦", "@date": "2026-1-1",
             "guide": [{"@day": "1", "@month": "1", "@type": "vacation", "@year": "2026"}],
             "tip": {"@col1": "1月1日（周四）至3日（周六）放假调休，共3天..."}}
        ]
    """
    display = _display(item)
    holidays_obj = display.get("holidays") or {}
    holidays = holidays_obj.get("holiday") or []
    if not isinstance(holidays, list) or not holidays:
        # 没拿到节假日数组, dump display 兜底
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""

    parts: list[str] = ["节假日安排:"]
    for h in holidays[:12]:  # 最多 12 个节日避免过长
        if not isinstance(h, dict):
            continue
        name = h.get("@content", "?")
        date = h.get("@date", "?")
        tip = h.get("tip") or {}
        tip_text = ""
        if isinstance(tip, dict):
            tip_text = tip.get("@col1") or ""
        if tip_text:
            parts.append(f"  - {name} ({date}): {tip_text}")
        else:
            parts.append(f"  - {name} ({date})")

    return "\n".join(parts)


def _render_medical(item: dict[str, Any]) -> str:
    """医疗问答卡片 (数据在 item.display.subDisplay)。

    实测 schema:
        display.title: 问题标题 (e.g., "感冒了怎么办_三甲医生权威解读")
        display.subDisplay.subitem[]: [
            {title (子问题), content (回答), wapUrl4Resin,
             doctorName, doctorLevel (主任医师等), hospital, hospitalLv (三甲等),
             department (科室)}
        ]
    """
    display = _display(item)
    parts: list[str] = []
    top_title = display.get("title", "").replace("<em>", "").replace("</em>", "")
    if top_title:
        parts.append(f"问题: {top_title}")

    sub_display = display.get("subDisplay") or {}
    subitems = sub_display.get("subitem") or []
    if isinstance(subitems, list) and subitems:
        for s in subitems[:3]:  # 最多 3 个回答
            if not isinstance(s, dict):
                continue
            sub_title = (s.get("title") or "").replace("<em>", "").replace("</em>", "")
            content = (s.get("content") or "").strip()
            if len(content) > 600:
                content = content[:600] + "..."
            doctor = s.get("doctorName", "")
            level = s.get("doctorLevel", "")
            hosp = s.get("hospital", "")
            hosp_lv = s.get("hospitalLv", "")
            dept = s.get("department", "")
            parts.append("")
            if sub_title:
                parts.append(f"【{sub_title}】")
            if content:
                parts.append(content)
            doctor_line = " | ".join(
                filter(
                    None,
                    [
                        f"{doctor} ({level})" if doctor else "",
                        f"{hosp} {hosp_lv}" if hosp else "",
                        dept,
                    ],
                )
            )
            if doctor_line:
                parts.append(f"  -- {doctor_line}")

    if not parts:
        return json.dumps(display, ensure_ascii=False)[:1200]
    return "\n".join(parts)


def _render_oil(item: dict[str, Any]) -> str:
    """油价卡片 (vrid 700224**, 数据在 display.subitem.subdisplay.guonei[])。

    schema:
        display.subitem.subdisplay.{city, date, guonei[]}
        guonei[].{name1, price1 (元/升), price2 (历史), increase1, type1}
            (字段名带数字后缀, 文档注 $ 是数组下标)
    """
    display = _display(item)
    subitem = display.get("subitem") or {}
    if not isinstance(subitem, dict):
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""
    sub_display = subitem.get("subdisplay") or {}
    if not isinstance(sub_display, dict):
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""

    city = sub_display.get("city", "")
    date = sub_display.get("date", "")
    guonei = sub_display.get("guonei") or []

    parts: list[str] = []
    head = " ".join(filter(None, [city, date]))
    parts.append(f"油价 ({head}):" if head else "油价:")

    if isinstance(guonei, list):
        for entry in guonei[:6]:
            if not isinstance(entry, dict):
                continue
            # 字段可能带 1/2/3 后缀, 都试一下
            name = entry.get("name1") or entry.get("name") or "?"
            price = entry.get("price1") or entry.get("price") or "?"
            increase = entry.get("increase1") or entry.get("increase") or ""
            line = f"  {name}: {price}元/升"
            if increase:
                line += f" ({increase})"
            parts.append(line)

    if len(parts) <= 1:  # 只剩 header, 没拿到油品
        return json.dumps(display, ensure_ascii=False)[:800] if display else ""
    return "\n".join(parts)


_VR_RENDERERS = {
    "weather": _render_weather,
    "stock": _render_stock,
    "exchangerate": _render_exchangerate,
    "baike": _render_baike,
    "calendar": _render_calendar,
    "medical": _render_medical,
    "gold": _render_gold,
    "oil": _render_oil,
    "train": _render_train,
}

_CANONICAL_EXTRACTORS: dict[str, Callable[[dict[str, Any]], dict[str, Any] | None]] = {
    "weather": _canonical_weather,
    "stock": _canonical_stock,
    "exchangerate": _canonical_exchangerate,
    "gold": _canonical_gold,
    "train": _canonical_train,
}


def _render_unknown_vr(category: str, item: dict[str, Any]) -> str:
    """未知 vr_category 的 fallback: dump display + display_info 全保留。

    腾讯将来加新卡片类型 (video / poi / sports / movie / ...) 我们不会崩,
    LLM 仍能从 JSON 提取信息回答用户。同时 log warning 提示该加新模板了。

    同时 dump display + jsonData 两个位置 — 因为不知道新类型把数据放在哪。
    """
    logger.warning(
        "Tencent: unknown vr_category %r, falling back to JSON dump. "
        "Add a renderer in _VR_RENDERERS to improve.",
        category,
    )
    payload = {
        "display": _display(item),
        "display_info": _info(item),
    }
    return (
        f"[{category} 卡片, 暂未做专用渲染]\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)[:2000]
    )


def _serialize_vr_card(item: dict[str, Any]) -> tuple[str, str]:
    """把 VR 卡片转成 (title, snippet) 文本对。

    Returns:
        (title, snippet): title 形如 "【weather】", snippet 是序列化后的多行文本。
        VR 卡的 url 字段固定为空字符串 (因为没有可点链接, 信息全在 snippet 里)。
    """
    category = item.get("vr_category", "unknown")
    renderer = _VR_RENDERERS.get(category)
    snippet = renderer(item) if renderer else _render_unknown_vr(category, item)
    title = f"【{category}】"
    return title, snippet
