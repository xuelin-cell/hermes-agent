"""Will Microsoft PowerPoint open this ``.pptx`` at all?

Ported from 数字员工 ``pptx_integrity.py`` (2026-10-08). There, 12 of 67 decks
would not open in PowerPoint 16 while LibreOffice and WPS showed them. Every
rule below is a cause that was confirmed by fixing that one thing alone and
reopening the deck in PowerPoint. 数字员工 judged attribute values against the
ECMA-376 schemas with lxml; Hermes ships no lxml, so the values that actually
broke decks are checked by name instead: a font size under 1 pt, a dash type
or preset shape name the schema does not know, and the animation shapes
PowerPoint refused. (Hermes, 2026-10-16: a 年会 deck drew prst="oval",
"star5Point" and "isocelesTriangle"; PowerPoint 16 refused it, and renaming just
those three to ellipse / star5 / triangle made it open.)

What PowerPoint tolerates matters as much, because flagging it would bounce
good decks: elements out of schema order (``notesMasterIdLst`` in 41 decks
that open), ``buSzPct`` pattern failures, a picture whose file is missing.
None of those are reported here. Negative sizes, runaway numbers and slides
without a layout are measured in :mod:`deck_geometry`.
"""

from __future__ import annotations

import re
import zipfile
from typing import Dict, List, Set, Tuple

_FATAL = "——PowerPoint 会因此打不开整个文件"
MAX_LISTED = 6

_SLIDE_PART_RE = re.compile(r"ppt/slides/slide(\d+)\.xml")
_SHAPE_ID_RE = re.compile(r'<p:cNvPr\b[^>]*?\bid="(\d+)"')
_TIMING_RE = re.compile(r"<p:timing\b.*?</p:timing>", re.DOTALL)
_TARGET_RE = re.compile(r'<p:(?:spTgt|bld\w*)\b[^>]*?\bspid="(\d+)"')
_REL_RE = re.compile(r"<Relationship\b[^>]*>")
_ATTR_RE = re.compile(r'(\w+)="([^"]*)"')
_FONT_SIZE_RE = re.compile(r'<a:(rPr|endParaRPr|defRPr)\b[^>]*?\bsz="(\d+)"')
_DASH_RE = re.compile(r'<a:prstDash\b[^>]*?\bval="([^"]*)"')
_SHAPE_RE = re.compile(r'<a:prstGeom\b[^>]*?\bprst="([^"]*)"')
_PRESET_CLASS_RE = re.compile(r'\bpresetClass="([^"]*)"')
_MEDIA_NODE_RE = re.compile(r"<p:(video|audio)\b[^>]*>(.*?)</p:\1>", re.DOTALL)
_EMPTY_CHILDREN_RE = re.compile(r"<p:childTnLst\s*/>|<p:childTnLst>\s*</p:childTnLst>")
_ANIM_EFFECT_RE = re.compile(r"<p:animEffect\b[^>]*?(?:/>|>(.*?)</p:animEffect>)", re.DOTALL)

# ECMA-376 ST_PresetLineDashVal and ST_TLTimeNodePresetClassType.
_DASHES = frozenset({
    "solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot",
    "sysDash", "sysDot", "sysDashDot", "sysDashDotDot",
})
_PRESET_CLASSES = frozenset({"entr", "exit", "emph", "path", "verb", "mediacall"})
# ECMA-376 ST_ShapeType (dml-main.xsd): every preset a <a:prstGeom prst> may name.
_SHAPES = frozenset({
    "line", "lineInv", "triangle", "rtTriangle", "rect", "diamond", "parallelogram", "trapezoid",
    "nonIsoscelesTrapezoid", "pentagon", "hexagon", "heptagon", "octagon", "decagon", "dodecagon",
    "star4", "star5", "star6", "star7", "star8", "star10", "star12", "star16", "star24", "star32",
    "roundRect", "round1Rect", "round2SameRect", "round2DiagRect", "snipRoundRect", "snip1Rect",
    "snip2SameRect", "snip2DiagRect", "plaque", "ellipse", "teardrop", "homePlate", "chevron",
    "pieWedge", "pie", "blockArc", "donut", "noSmoking", "rightArrow", "leftArrow", "upArrow",
    "downArrow", "stripedRightArrow", "notchedRightArrow", "bentUpArrow", "leftRightArrow",
    "upDownArrow", "leftUpArrow", "leftRightUpArrow", "quadArrow", "leftArrowCallout",
    "rightArrowCallout", "upArrowCallout", "downArrowCallout", "leftRightArrowCallout",
    "upDownArrowCallout", "quadArrowCallout", "bentArrow", "uturnArrow", "circularArrow",
    "leftCircularArrow", "leftRightCircularArrow", "curvedRightArrow", "curvedLeftArrow",
    "curvedUpArrow", "curvedDownArrow", "swooshArrow", "cube", "can", "lightningBolt", "heart", "sun",
    "moon", "smileyFace", "irregularSeal1", "irregularSeal2", "foldedCorner", "bevel", "frame",
    "halfFrame", "corner", "diagStripe", "chord", "arc", "leftBracket", "rightBracket", "leftBrace",
    "rightBrace", "bracketPair", "bracePair", "straightConnector1", "bentConnector2", "bentConnector3",
    "bentConnector4", "bentConnector5", "curvedConnector2", "curvedConnector3", "curvedConnector4",
    "curvedConnector5", "callout1", "callout2", "callout3", "accentCallout1", "accentCallout2",
    "accentCallout3", "borderCallout1", "borderCallout2", "borderCallout3", "accentBorderCallout1",
    "accentBorderCallout2", "accentBorderCallout3", "wedgeRectCallout", "wedgeRoundRectCallout",
    "wedgeEllipseCallout", "cloudCallout", "cloud", "ribbon", "ribbon2", "ellipseRibbon",
    "ellipseRibbon2", "leftRightRibbon", "verticalScroll", "horizontalScroll", "wave", "doubleWave",
    "plus", "flowChartProcess", "flowChartDecision", "flowChartInputOutput",
    "flowChartPredefinedProcess", "flowChartInternalStorage", "flowChartDocument",
    "flowChartMultidocument", "flowChartTerminator", "flowChartPreparation", "flowChartManualInput",
    "flowChartManualOperation", "flowChartConnector", "flowChartPunchedCard", "flowChartPunchedTape",
    "flowChartSummingJunction", "flowChartOr", "flowChartCollate", "flowChartSort", "flowChartExtract",
    "flowChartMerge", "flowChartOfflineStorage", "flowChartOnlineStorage", "flowChartMagneticTape",
    "flowChartMagneticDisk", "flowChartMagneticDrum", "flowChartDisplay", "flowChartDelay",
    "flowChartAlternateProcess", "flowChartOffpageConnector", "actionButtonBlank", "actionButtonHome",
    "actionButtonHelp", "actionButtonInformation", "actionButtonForwardNext",
    "actionButtonBackPrevious", "actionButtonEnd", "actionButtonBeginning", "actionButtonReturn",
    "actionButtonDocument", "actionButtonSound", "actionButtonMovie", "gear6", "gear9", "funnel",
    "mathPlus", "mathMinus", "mathMultiply", "mathDivide", "mathEqual", "mathNotEqual", "cornerTabs",
    "squareTabs", "plaqueTabs", "chartX", "chartStar", "chartPlus",
})
# Names models write for a shape the schema calls something else.
_SHAPE_SPELLINGS: Dict[str, str] = {
    "oval": "ellipse", "circle": "ellipse", "star5Point": "star5", "star": "star5",
    "isocelesTriangle": "triangle", "isoscelesTriangle": "triangle", "rectangle": "rect", "square": "rect",
    "roundedRectangle": "roundRect", "roundRectangle": "roundRect", "arrow": "rightArrow",
}
_MIN_SZ, _MAX_SZ = 100, 400000

FIX_HINTS: Dict[str, str] = {
    "invalid_value": (
        "按提示改成规范允许的取值：字号最小 1 磅；虚线只能是 solid、dot、dash、lgDash、dashDot、sysDash、sysDot 等，"
        "pptxgenjs 的 dashType 别写 roundDot 这类自造名字；图形只能用规范里的预设名（圆和椭圆是 ellipse、五角星 star5、"
        "三角形 triangle、圆角矩形 roundRect），pptxgenjs 里用 pptx.ShapeType 的常量，不要手写字符串。"
    ),
    "broken_animation": (
        "动画 XML 按 PowerPoint 的结构写：<p:video>/<p:audio> 里必须是 <p:cMediaNode>，不放媒体就不要写这类节点；"
        "spTgt / bldP 的 spid 必须是这一页上真实存在的形状 id（<p:cNvPr id=…>）；"
        "presetClass 只能是 entr、exit、emph、path、verb、mediacall；childTnLst 不能是空的。"
        "拿不准就删掉这一页的 <p:timing>，切换效果不受影响。"
    ),
    # One fix only, and it does not touch notesMasterIdLst: a model told both
    # "move it" and "validate.py's complaint about it is harmless" read the pair
    # as a contradiction and left the deck broken (青禾, 2026-10-09).
    "notes_master": (
        "给备注母版单独一份主题：把它现在用的主题文件复制一份新名字（例如 theme1.xml → theme2.xml），"
        "把备注母版 .rels 里指向旧主题的 Target 改成新文件，再在 [Content_Types].xml 里给新文件加一条 "
        "<Override PartName=\"/ppt/theme/theme2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>。"
        "presentation.xml 不用动；套件 validate.py 报 notesMasterIdLst 位置的那一条不要去改。"
    ),
}


def _rels(archive: zipfile.ZipFile, part: str) -> List[Dict[str, str]]:
    """读出某个部件的 .rels 关系列表；没有就返回空。"""
    folder, name = part.rsplit("/", 1)
    try:
        xml = archive.read(f"{folder}/_rels/{name}.rels").decode("utf-8", "ignore")
    except KeyError:
        return []
    return [dict(_ATTR_RE.findall(tag)) for tag in _REL_RE.findall(xml)]


def _resolve(part: str, target: str) -> str:
    """把关系里的相对路径换算成包内的绝对部件名。"""
    if target.startswith("/"):
        return target.lstrip("/")
    parts = part.rsplit("/", 1)[0].split("/")
    for segment in target.split("/"):
        if segment == "..":
            parts = parts[:-1]
        elif segment not in ("", "."):
            parts.append(segment)
    return "/".join(parts)


def _slide_number(part: str) -> int:
    """部件是第几页幻灯片；不是幻灯片返回 0。"""
    match = _SLIDE_PART_RE.fullmatch(part)
    return int(match.group(1)) if match else 0


def _value_findings(part: str, xml: str) -> List[Tuple[int, str, str]]:
    """查字号、虚线类型、图形预设名这类超出规范的取值，任何一处都会让 PowerPoint 打不开。"""
    found: List[Tuple[int, str, str]] = []
    slide = _slide_number(part)
    sizes = [(tag, int(value)) for tag, value in _FONT_SIZE_RE.findall(xml)]
    bad_sizes = [value for _tag, value in sizes if not _MIN_SZ <= value <= _MAX_SZ]
    if bad_sizes:
        shown = "、".join(f"{value / 100:g} 磅" for value in bad_sizes[:2])
        more = f"等 {len(bad_sizes)} 处" if len(bad_sizes) > 1 else ""
        found.append((slide, "invalid_value", f"字号 {shown}{more}超出规范（1–4000 磅）{_FATAL}"))
    dashes = sorted({value for value in _DASH_RE.findall(xml) if value not in _DASHES})
    if dashes:
        found.append((slide, "invalid_value", f"虚线类型 prstDash=\"{'、'.join(dashes[:3])}\" 不是合法取值{_FATAL}"))
    shapes = sorted({value for value in _SHAPE_RE.findall(xml) if value not in _SHAPES})
    if shapes:
        named = "、".join(
            f"{value}（应为 {_SHAPE_SPELLINGS[value]}）" if value in _SHAPE_SPELLINGS else value for value in shapes[:3]
        )
        found.append((slide, "invalid_value", f"图形预设名 prst=\"{named}\" 不是合法取值{_FATAL}"))
    return found


def _animation_findings(part: str, xml: str) -> List[Tuple[int, str, str]]:
    """查一页里坏掉的动画：指向不存在的形状、缺必需子节点、空列表、非法 presetClass。"""
    timing = _TIMING_RE.search(xml)
    if not timing:
        return []
    body = timing.group(0)
    slide = _slide_number(part)
    phrases: List[str] = []
    missing = sorted(set(_TARGET_RE.findall(body)) - set(_SHAPE_ID_RE.findall(xml)), key=int)
    if missing:
        phrases.append(f"动画指向的形状 id={'、'.join(missing[:4])} 在这一页上不存在（多半是删了形状却留着它的动画）")
    for tag, inner in _MEDIA_NODE_RE.findall(body):
        if "<p:cMediaNode" not in inner:
            phrases.append(f"动画里的 <p:{tag}> 没有 <p:cMediaNode>")
            break
    if _EMPTY_CHILDREN_RE.search(body):
        phrases.append("动画里有空的 <p:childTnLst>")
    classes = sorted({value for value in _PRESET_CLASS_RE.findall(body) if value not in _PRESET_CLASSES})
    if classes:
        phrases.append(f"动画 presetClass=\"{'、'.join(classes[:3])}\" 不是合法取值")
    for match in _ANIM_EFFECT_RE.finditer(body):
        if "<p:cBhvr" not in (match.group(1) or ""):
            phrases.append("动画里的 <p:animEffect> 缺少 <p:cBhvr>")
            break
    return [(slide, "broken_animation", "；".join(phrases) + _FATAL)] if phrases else []


def _notes_master_finding(archive: zipfile.ZipFile, presentation: str, names: Set[str]) -> List[Tuple[int, str, str]]:
    """查备注母版和幻灯片母版共用同一个主题；PowerPoint 遇到会拒绝打开，并给出具体改法。"""
    notes_at = presentation.find("<p:notesMasterIdLst")
    slides_at = presentation.find("<p:sldIdLst")
    if notes_at < 0 or not (slides_at < 0 or notes_at < slides_at):
        return []  # out of schema order: PowerPoint skips the notes master and opens the deck

    def themes(folder: str) -> Set[str]:
        """某类母版用到的全部主题文件。"""
        out: Set[str] = set()
        for name in names:
            if re.fullmatch(rf"ppt/{folder}/[^/]+\.xml", name):
                out |= {
                    _resolve(name, rel["Target"]) for rel in _rels(archive, name)
                    if rel.get("Type", "").endswith("/theme") and "Target" in rel
                }
        return out

    shared = themes("notesMasters") & themes("slideMasters")
    if not shared:
        return []
    theme = min(shared).rsplit("/", 1)[-1]
    taken = [int(m) for m in re.findall(r"ppt/theme/theme(\d+)\.xml", "\n".join(names))]
    fresh = f"theme{max(taken, default=0) + 1}.xml"
    return [(0, "notes_master", (
        f"备注母版和幻灯片母版共用同一个主题 {theme}；备注母版在 presentation.xml 里登记了，"
        f"PowerPoint 打开时会加载它，遇到共用的主题就拒绝打开{_FATAL}。"
        f"改法：把 ppt/theme/{theme} 复制成 ppt/theme/{fresh}，备注母版 .rels 指向新文件，"
        f"[Content_Types].xml 里加 /ppt/theme/{fresh} 的 Override"
    ))]


def problems(archive: zipfile.ZipFile, presentation: str) -> List[Tuple[int, str, str]]:
    """找出所有会让 PowerPoint 打不开文件的问题，每条是（第几页, 类别, 说明），太多时只列前几条。"""
    names = set(archive.namelist())
    found: List[Tuple[int, str, str]] = []
    for part in sorted(names, key=lambda name: (_slide_number(name) or 10**6, name)):
        if not part.endswith(".xml") or not part.startswith("ppt/"):
            continue
        if not re.match(r"ppt/(?:slides|slideLayouts|slideMasters|notesSlides|notesMasters)/[^/]+\.xml$", part):
            continue
        xml = archive.read(part).decode("utf-8", "ignore")
        found.extend(_value_findings(part, xml))
        if _SLIDE_PART_RE.fullmatch(part):
            found.extend(_animation_findings(part, xml))
    found = _notes_master_finding(archive, presentation, names) + found
    if len(found) > MAX_LISTED:
        rest = len(found) - MAX_LISTED
        found = found[:MAX_LISTED] + [(0, found[MAX_LISTED][1], f"……另有 {rest} 处同类问题，改法相同")]
    return found
