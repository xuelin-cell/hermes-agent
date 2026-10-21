"""Measure a generated ``.pptx`` the way 数字员工's delivery check does.

The numbers come from decks that actually failed: pictures stretched because
the frame size was passed as the image size, shapes laid out for 13.3×7.5 on
a 10×5.625 page, coordinates multiplied by 96, text sitting on other text,
and a portrait cropped to a landscape sliver. A defect that can be read from
the file is decided here. This module does not call a model.
"""

from __future__ import annotations

import re
import struct
import zipfile
from dataclasses import dataclass
from io import BytesIO
from typing import List, Optional, Tuple

from . import deck_integrity

EMU = 914400
RATIO_TOLERANCE_PCT = 3.0
BLEED_IN = 0.02
CROP_KEEP_MIN = 0.55
CONTENT_PICTURE_MAX_SHARE = 0.6
UNDERFILL_RATIO = 0.8
TEXT_OVERFLOW_RATIO = 1.4
CROWD_H_OVERLAP = 0.3
CROWD_MIN_GAP_EM = 0.15
_CROWD_MAX_PT = 48.0
_CROWD_MAX_LISTED = 6
_PT_PER_INCH = 72.0
_CARD_MAX_SHARE = 0.6
_CARD_MIN_ALPHA = 5000
_CARD_TOLERANCE_IN = 0.05
_SPILL_MIN_IN = 0.02
_EDGE_IN = 0.05
_DEFAULT_SIDE_IN = 91440 / EMU
_DEFAULT_TOP_IN = 45720 / EMU
_RUNAWAY_DIGITS = 12

_SLIDE_RE = re.compile(r"ppt/slides/slide(\d+)\.xml")
_SHAPE_RE = re.compile(r"<p:(sp|pic)>.*?</p:\1>", re.DOTALL)
_SP_RE = re.compile(r"<p:sp>.*?</p:sp>", re.DOTALL)
_OFF_RE = re.compile(r'<a:off x="(-?\d+)" y="(-?\d+)"')
_EXT_RE = re.compile(r'<a:ext cx="(-?\d+)" cy="(-?\d+)"')
_BOX_RE = re.compile(r'<a:off x="(-?\d+)" y="(-?\d+)"/>\s*<a:ext cx="(-?\d+)" cy="(-?\d+)"/>')
_EMBED_RE = re.compile(r'r:embed="([^"]+)"')
_SRC_RECT_RE = re.compile(r"<a:srcRect([^/>]*)/?>")
_CROP_RE = re.compile(r'\b([ltrb])="(-?\d+)"')
_REL_RE = re.compile(r'Id="([^"]+)"[^>]*Target="([^"]+)"')
_SLD_SZ_RE = re.compile(r'<p:sldSz cx="(\d+)" cy="(\d+)"')
_FRACTIONAL_RE = re.compile(r'\b(?:cx|cy|x|y)="-?\d+\.\d+"')
_NEGATIVE_RE = re.compile(r'<a:(?:ext|chExt)\b[^>]*\b(cx|cy)="(-\d+)"')
_RUNAWAY_RE = re.compile(r'\b(?:cx|cy|x|y|blurRad)="(-?\d{12,}(?:\.\d+)?|-?\d+(?:\.\d+)?[eE]\+\d+)"')
_TEXT_RE = re.compile(r"<a:t>([^<]*)</a:t>")
_SIZED_RE = re.compile(r'<a:(?:rPr|endParaRPr)\b[^>]*\bsz="\d+"')
_FILL_RE = re.compile(r"<a:(?:solidFill|gradFill)>")
_XFRM_RE = re.compile(
    r'<a:xfrm([^>]*)>\s*<a:off x="(-?\d+)" y="(-?\d+)"/>\s*<a:ext cx="(-?\d+)" cy="(-?\d+)"/>'
)
_BODY_PR_RE = re.compile(r"<a:bodyPr([^>]*)>")
_ALPHA_RE = re.compile(r'<a:alpha val="(\d+)"')
_ALGN_RE = re.compile(r'<a:pPr[^>]*\balgn="(\w+)"')
_PARA_RE = re.compile(r"<a:p>.*?</a:p>", re.DOTALL)
_RUN_RE = re.compile(r"<a:r>.*?</a:r>", re.DOTALL)
_SZ_RE = re.compile(r'sz="(\d+)"')
_LINE_SPACING_RE = re.compile(r'<a:lnSpc><a:spcPct val="(\d+)"/>')
_INSET_RE = re.compile(r'(tIns|bIns|lIns|rIns)="(-?\d+)"')
_LAYOUT_REL_RE = re.compile(r"slideLayout")
_CREDIT_WORDS = ("图片来源", "图源", "来源：", "来源:", "摄影", "Source", "source", "credit")
_AI_LABEL_RE = re.compile(r"AI\s*(?:生成|绘制|创作|制图)|AIGC|人工智能生成|AI[- ]generated", re.IGNORECASE)

_FIX = {
    "stretched": (
        "图片保持原比例：外层 w/h 写图片自己的尺寸（像素÷96 换成英寸），"
        "sizing 的 w/h 才是画框，两处写成同一组数就会变形。"
    ),
    "off_slide": (
        "越界的元素挪回页面内。如果整份是按另一种页面尺寸排的，页面尺寸和所有坐标要一起改，"
        "只改 layout 不改坐标会整页越界或缩在一角。"
        "LAYOUT_16x9 是 10×5.625 英寸，LAYOUT_WIDE 是 13.3×7.5 英寸。"
    ),
    "underfilled": (
        "页面尺寸和坐标要一致：内容是按小一号的页面排的，要么把 layout 换成和坐标一致的尺寸"
        "（10×5.625 是 LAYOUT_16x9），要么把所有坐标按页面比例放大重排。"
    ),
    "crowded": "把挤在一起的文字拉开：挪位置、缩短文字或调小字号。页码、页脚、图注不要和正文叠在一起。",
    "cropped": (
        "画框比例跟着图走：竖图配竖框、横图配横框；版式不好改时用 sizing type 'contain' 完整放下；"
        "确实要裁就按主体位置裁，cover 只裁正中间。"
    ),
    "text_out_of_card": (
        "文字超出卡片：加高卡片、缩短文字或调小字号。"
        "卡片高度按文字实际行数留够（中文每行字数 ≈ 框宽英寸 × 72 ÷ 字号）。"
    ),
    "empty_text": "空文字框多半是取文字的变量名或数组下标写错了，对照数据改好，生成后核对这些框有字。",
    "fractional_emu": "坐标用英寸，让 pptxgenjs 自己换算。不要把英寸乘 96，小数 EMU 会让 PowerPoint 拒绝打开。",
    "negative_size": "宽高不能是负数：往上斜的线把 y 设在下端、h 写正数并加 flipV: true，往左斜的加 flipH: true。",
    "runaway_number": (
        "数值大得离谱，是因为同一个 shadow 对象传给了多个形状，pptxgenjs 每次都会原地换算。"
        "每个形状单独写一个新对象。"
    ),
    "no_layout": "每一页都要有 ppt/slides/_rels/slideN.xml.rels，里面至少一条指向 slideLayout 的关系。",
    **deck_integrity.FIX_HINTS,
}


@dataclass(frozen=True)
class Problem:
    slide: int
    kind: str
    detail: str

    def __str__(self) -> str:
        """问题的一行文字，带上第几页（整份文件的问题不写页码）。"""
        return f"第{self.slide}页 {self.detail}" if self.slide else self.detail


@dataclass(frozen=True)
class DeckReport:
    page_inches: Tuple[float, float]
    slides: int
    pictures: int
    problems: Tuple[Problem, ...]
    notes: Tuple[str, ...] = ()
    ai_labels: int = 0

    @property
    def ok(self) -> bool:
        """没有发现任何问题。"""
        return not self.problems

    def as_text(self) -> str:
        """给模型看的自检结论：页数、页面尺寸、图片数，有问题时逐条列出并附上对应改法。"""
        head = (
            f"版面自检：{self.slides} 页，页面 {self.page_inches[0]:.2f}×{self.page_inches[1]:.2f} 英寸，"
            f"图片 {self.pictures} 张。"
        )
        if self.ok:
            tail = ("没有发现问题。" + " ".join(self.notes)) if self.notes else "没有发现问题。"
            return head + tail
        lines = [head + f"发现 {len(self.problems)} 处问题，必须改好再交付："]
        lines.extend(f"- {item}" for item in self.problems)
        kinds = list(dict.fromkeys(item.kind for item in self.problems))
        lines.append("改法：" + "".join(_FIX.get(kind, "") for kind in kinds) + "改完重新生成，宿主会再查一遍。")
        lines.extend(self.notes)
        return "\n".join(lines)


def image_pixels(data: bytes) -> Optional[Tuple[int, int]]:
    """读出 PNG、JPEG、GIF 的宽高；读不出返回 None。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return int(width), int(height)
    if data.startswith(b"\xff\xd8"):
        view = memoryview(data)
        index = 2
        while index + 9 < len(view):
            if view[index] != 0xFF:
                return None
            marker = view[index + 1]
            size = struct.unpack(">H", view[index + 2 : index + 4])[0]
            if marker in {0xC0, 0xC1, 0xC2}:
                height, width = struct.unpack(">HH", view[index + 5 : index + 9])
                return int(width), int(height)
            index += 2 + size
    return None


def _attr(attrs: str, name: str) -> Optional[str]:
    """从一段 XML 属性文本里取某个属性的值，没有返回 None。"""
    match = re.search(rf'\b{name}="([^"]*)"', attrs)
    return match.group(1) if match else None


def _text_width(text: str) -> float:
    """粗略估算一段文字的宽度（以字号为单位）：中文按 1 个字宽，西文按 0.55。"""
    return sum(1.0 if ord(ch) > 0x2E80 else 0.55 for ch in text)


def _needed_height(shape: str, width_in: float) -> Tuple[float, str]:
    """估算文本框按当前字号、行距和边距排下全部文字需要的高度（英寸），并返回第一段文字作示例。"""
    insets = {key: int(value) / EMU for key, value in _INSET_RE.findall(shape)}
    usable = width_in - insets.get("lIns", _DEFAULT_SIDE_IN) - insets.get("rIns", _DEFAULT_SIDE_IN)
    if usable <= 0:
        return 0.0, ""
    spacing_match = _LINE_SPACING_RE.search(shape)
    spacing = int(spacing_match.group(1)) / 100000 if spacing_match else 1.2
    total = 0.0
    sample = ""
    for para in _PARA_RE.findall(shape):
        runs = _RUN_RE.findall(para)
        if not runs:
            continue
        width = 0.0
        biggest = 0.0
        text = ""
        for run in runs:
            size_pt = max((int(v) / 100 for v in _SZ_RE.findall(run)), default=18.0)
            run_text = "".join(_TEXT_RE.findall(run))
            text += run_text
            biggest = max(biggest, size_pt)
            width += _text_width(run_text) * size_pt / _PT_PER_INCH
        if not text:
            continue
        sample = sample or text
        lines = max(1, int(width / usable + 0.999))
        total += lines * (biggest / _PT_PER_INCH) * spacing
    padding = insets.get("tIns", _DEFAULT_TOP_IN) + insets.get("bIns", _DEFAULT_TOP_IN)
    return (total + padding if sample else 0.0), sample


@dataclass(frozen=True)
class _Block:
    sample: str
    size_pt: float
    top: float
    bottom: float
    left: float
    right: float


def _blocks(xml: str) -> List[_Block]:
    """找出一页里横排、未旋转、不透明的文字块，估算文字实际占的位置，供判断文字挤在一起。"""
    found: List[_Block] = []
    for shape in _SP_RE.findall(xml):
        text = "".join(_TEXT_RE.findall(shape)).strip()
        xfrm, body = _XFRM_RE.search(shape), _BODY_PR_RE.search(shape)
        if not text or not xfrm or not body:
            continue
        if (_attr(xfrm.group(1), "rot") or "0") != "0":
            continue
        body_attrs = body.group(1)
        if (_attr(body_attrs, "vert") or "horz") != "horz":
            continue
        alphas = [int(v) for v in _ALPHA_RE.findall(shape)]
        if alphas and max(alphas) < 60000:
            continue
        size_pt = max((int(v) / 100 for v in _SZ_RE.findall(shape)), default=18.0)
        if size_pt > _CROWD_MAX_PT:
            continue
        x, y, w, h = (int(v) / EMU for v in xfrm.groups()[1:])
        insets = {key: int(value) / EMU for key, value in _INSET_RE.findall(body_attrs)}
        left_in = insets.get("lIns", _DEFAULT_SIDE_IN)
        right_in = insets.get("rIns", _DEFAULT_SIDE_IN)
        top_in = insets.get("tIns", _DEFAULT_TOP_IN)
        bottom_in = insets.get("bIns", _DEFAULT_TOP_IN)
        needed, _sample = _needed_height(shape, w)
        text_h = needed - top_in - bottom_in
        if text_h <= 0:
            continue
        anchor = _attr(body_attrs, "anchor") or "t"
        if anchor == "ctr":
            top = y + top_in + (h - top_in - bottom_in - text_h) / 2
        elif anchor == "b":
            top = y + h - bottom_in - text_h
        else:
            top = y + top_in
        spacing_match = _LINE_SPACING_RE.search(shape)
        spacing = int(spacing_match.group(1)) / 100000 if spacing_match else 1.2
        lead = (spacing - 1) * size_pt / _PT_PER_INCH / 2
        usable_w = w - left_in - right_in
        widest = 0.0
        for para in _PARA_RE.findall(shape):
            para_w = 0.0
            for run in _RUN_RE.findall(para):
                run_pt = max((int(v) / 100 for v in _SZ_RE.findall(run)), default=18.0)
                para_w += _text_width("".join(_TEXT_RE.findall(run))) * run_pt / _PT_PER_INCH
            widest = max(widest, para_w)
        text_w = min(usable_w, widest)
        align = _ALGN_RE.search(shape)
        align_value = align.group(1) if align else "l"
        if align_value == "ctr":
            left = x + left_in + (usable_w - text_w) / 2
        elif align_value == "r":
            left = x + w - right_in - text_w
        else:
            left = x + left_in
        found.append(_Block(text[:14], size_pt, top + lead, top + text_h - lead, left, left + text_w))
    return found


def _crowded(xml: str) -> List[Tuple[str, str, float]]:
    """找出上下贴得太近或叠在一起的文字块对。"""
    blocks = _blocks(xml)
    pairs: List[Tuple[str, str, float]] = []
    for index, first in enumerate(blocks):
        for second in blocks[index + 1 :]:
            narrower = min(first.right - first.left, second.right - second.left)
            across = min(first.right, second.right) - max(first.left, second.left)
            if narrower <= 0 or across < CROWD_H_OVERLAP * narrower:
                continue
            overlap = min(first.bottom, second.bottom) - max(first.top, second.top)
            if overlap > -CROWD_MIN_GAP_EM * min(first.size_pt, second.size_pt) / _PT_PER_INCH:
                pairs.append((first.sample, second.sample, overlap))
    return pairs


def _spills(xml: str, page_w: float, page_h: float) -> List[Tuple[str, float]]:
    """找出文字超出它所在卡片（有填色的底框）的情况，返回（示例文字, 超出多少英寸）。"""
    cards: List[Tuple[float, float, float, float]] = []
    texts: List[Tuple[str, float, float, float, float]] = []
    for shape in _SP_RE.findall(xml):
        xfrm = _XFRM_RE.search(shape)
        if not xfrm:
            continue
        x, y, w, h = (int(v) / EMU for v in xfrm.groups()[1:])
        if "".join(_TEXT_RE.findall(shape)).strip():
            texts.append((shape, x, y, w, h))
            continue
        geometry = shape.split("<p:txBody>", 1)[0]
        alphas = [int(v) for v in _ALPHA_RE.findall(geometry)]
        visible = not alphas or min(alphas) >= _CARD_MIN_ALPHA
        if _FILL_RE.search(geometry) and visible and w * h < _CARD_MAX_SHARE * page_w * page_h:
            cards.append((x, y, w, h))
    spills: List[Tuple[str, float]] = []
    for shape, x, y, w, h in texts:
        around = [
            card for card in cards
            if card[0] - _CARD_TOLERANCE_IN <= x
            and x + w <= card[0] + card[2] + _CARD_TOLERANCE_IN
            and card[1] - _CARD_TOLERANCE_IN <= y
            and y + h <= card[1] + card[3] + _CARD_TOLERANCE_IN
        ]
        blocks = _blocks(shape)
        if not around or not blocks:
            continue
        card = min(around, key=lambda item: item[2] * item[3])
        ink = blocks[0]
        past = max(ink.bottom - (card[1] + card[3]), card[1] - ink.top)
        if past > _SPILL_MIN_IN:
            spills.append((ink.sample, past))
    return spills


def _extent(xml: str, page_w: float, page_h: float) -> Tuple[float, float]:
    """一页里元素最远伸到哪里（右边和下边），铺满整页的背景不算。"""
    right = bottom = 0.0
    for match in _BOX_RE.finditer(xml):
        x, y, cx, cy = (int(v) / EMU for v in match.groups())
        if page_w and page_h and cx >= 0.95 * page_w and cy >= 0.95 * page_h:
            continue
        right, bottom = max(right, x + cx), max(bottom, y + cy)
    return right, bottom


def _crop(shape: str) -> dict:
    """图片的裁切比例（上下左右各裁掉多少），没有裁切返回空字典。"""
    match = _SRC_RECT_RE.search(shape)
    if not match:
        return {}
    return {key: int(value) / 100000 for key, value in _CROP_RE.findall(match.group(1))}


def _orientation(width: float, height: float) -> str:
    """按宽高比判断横、竖还是方。"""
    ratio = width / height if height else 1.0
    return "横" if ratio > 1.15 else ("竖" if ratio < 0.87 else "方")


def measure(data: bytes) -> DeckReport:
    """测量一份 PPT 的版面并给出问题清单；文件读不开也只算一条问题，不抛异常。"""
    try:
        archive = zipfile.ZipFile(BytesIO(data))
        presentation = archive.read("ppt/presentation.xml").decode("utf-8", "ignore")
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        return DeckReport((0.0, 0.0), 0, 0, (Problem(0, "unreadable", f"文件读不开：{exc}"),))

    size = _SLD_SZ_RE.search(presentation)
    page_w = int(size.group(1)) / EMU if size else 0.0
    page_h = int(size.group(2)) / EMU if size else 0.0
    names = sorted(
        (name for name in archive.namelist() if _SLIDE_RE.fullmatch(name)),
        key=lambda name: int(_SLIDE_RE.fullmatch(name).group(1)),  # type: ignore[union-attr]
    )
    problems: List[Problem] = [
        Problem(slide, kind, detail) for slide, kind, detail in deck_integrity.problems(archive, presentation)
    ]
    pictures = 0
    all_text: List[str] = []
    tight: List[str] = []
    crowded: List[Problem] = []
    shrunk: List[Tuple[float, float]] = []

    for name in names:
        number = int(_SLIDE_RE.fullmatch(name).group(1))  # type: ignore[union-attr]
        xml = archive.read(name).decode("utf-8", "ignore")
        all_text.extend(_TEXT_RE.findall(xml))
        try:
            rels = archive.read(f"ppt/slides/_rels/slide{number}.xml.rels").decode("utf-8", "ignore")
        except KeyError:
            rels = ""
        if not _LAYOUT_REL_RE.search(rels):
            problems.append(Problem(number, "no_layout", "这一页没有指向版式（slideLayout）的关系，PowerPoint 可能拒绝打开"))
        if _FRACTIONAL_RE.search(xml):
            sample = "、".join(_FRACTIONAL_RE.findall(xml)[:3])
            problems.append(Problem(number, "fractional_emu", f"坐标不是整数 EMU（{sample}），PowerPoint 会拒绝打开"))
        if _NEGATIVE_RE.search(xml):
            attr, value = _NEGATIVE_RE.search(xml).groups()
            problems.append(Problem(number, "negative_size", f"有形状的{('宽度' if attr == 'cx' else '高度')}是负数（{attr}={value}）"))
        runaway = _RUNAWAY_RE.search(xml)
        if runaway:
            problems.append(Problem(number, "runaway_number", f"有数值大得离谱（{runaway.group(1)[:16]}）"))
        right, bottom = _extent(xml, page_w, page_h)
        if right and page_w and page_h and right <= UNDERFILL_RATIO * page_w and bottom <= UNDERFILL_RATIO * page_h:
            shrunk.append((right, bottom))
        for first, second, overlap in _crowded(xml):
            how = f"重叠 {overlap:.2f} 英寸" if overlap > 0 else "几乎没有间距"
            crowded.append(Problem(number, "crowded", f"「{first}」和「{second}」挤在一起（{how}）"))
        if page_w and page_h:
            for sample, past in _spills(xml, page_w, page_h):
                problems.append(Problem(
                    number, "text_out_of_card", f"「{sample}」的文字超出了所在卡片的边（估计超出 {past:.2f} 英寸）",
                ))
        empty = sum(
            1 for shape in _SP_RE.findall(xml)
            if "<p:txBody>" in shape and "<p:ph" not in shape
            and not "".join(_TEXT_RE.findall(shape)).strip() and _SIZED_RE.search(shape)
        )
        if empty:
            problems.append(Problem(number, "empty_text", f"有 {empty} 个文字框是空的：设了字号，却一个字都没有"))
        rel_map = dict(_REL_RE.findall(rels))
        for match in _SHAPE_RE.finditer(xml):
            shape = match.group(0)
            off, ext = _OFF_RE.search(shape), _EXT_RE.search(shape)
            if not off or not ext:
                continue
            x = int(off.group(1)) / EMU
            y = int(off.group(2)) / EMU
            w = int(ext.group(1)) / EMU
            h = int(ext.group(2)) / EMU
            label = "".join(_TEXT_RE.findall(shape))[:14] or ("图片" if "<p:pic>" in shape else "形状")
            over = []
            if page_w and x + w > page_w + BLEED_IN:
                over.append(f"右边超出 {x + w - page_w:.2f} 英寸")
            if page_h and y + h > page_h + BLEED_IN:
                over.append(f"下边超出 {y + h - page_h:.2f} 英寸")
            if x < -BLEED_IN:
                over.append(f"左边出界 {-x:.2f} 英寸")
            if y < -BLEED_IN:
                over.append(f"上边出界 {-y:.2f} 英寸")
            if over:
                problems.append(Problem(
                    number, "off_slide",
                    f"「{label}」放在页面外：{'、'.join(over)}（页面 {page_w:.2f}×{page_h:.2f} 英寸）",
                ))
            if "<p:pic>" not in shape:
                if h > 0 and "<a:normAutofit" not in shape and "<a:spAutoFit" not in shape:
                    needed, sample = _needed_height(shape, w)
                    if sample and needed > h * TEXT_OVERFLOW_RATIO:
                        tight.append(
                            f"第{number}页「{sample[:14]}」文字可能装不下：框高 {h:.2f} 英寸，估计需要 {needed:.2f} 英寸"
                        )
                continue
            if not w or not h:
                continue
            embed = _EMBED_RE.search(shape)
            if not embed:
                continue
            target = rel_map.get(embed.group(1), "")
            try:
                blob = archive.read("ppt/" + target.replace("../", ""))
            except KeyError:
                continue
            pixels = image_pixels(blob)
            if not pixels:
                continue
            pictures += 1
            crop = _crop(shape)
            kept_w = pixels[0] * (1 - crop.get("l", 0.0) - crop.get("r", 0.0))
            kept_h = pixels[1] * (1 - crop.get("t", 0.0) - crop.get("b", 0.0))
            if kept_w <= 0 or kept_h <= 0:
                continue
            deviation = abs(kept_w / kept_h - w / h) / (w / h) * 100
            if deviation > RATIO_TOLERANCE_PCT:
                shown = "0" if not any(crop.values()) else "、".join(f"{key}={value:.0%}" for key, value in sorted(crop.items()))
                problems.append(Problem(
                    number, "stretched",
                    f"图片被拉伸 {deviation:.0f}%：原图 {pixels[0]}×{pixels[1]}，画框 {w:.2f}×{h:.2f} 英寸，裁剪量为 {shown}",
                ))
                continue
            keep_w = kept_w / pixels[0]
            keep_h = kept_h / pixels[1]
            edges = sum((
                x <= _EDGE_IN, y <= _EDGE_IN,
                page_w and x + w >= page_w - _EDGE_IN, page_h and y + h >= page_h - _EDGE_IN,
            ))
            content_picture = page_w and page_h and edges < 2 and w * h < CONTENT_PICTURE_MAX_SHARE * page_w * page_h
            if content_picture and min(keep_w, keep_h) < CROP_KEEP_MIN:
                side, kept = ("高度", keep_h) if keep_h < keep_w else ("宽度", keep_w)
                problems.append(Problem(
                    number, "cropped",
                    f"图片只保留了原图{side}的 {kept:.0%}：原图 {pixels[0]}×{pixels[1]}（{_orientation(*pixels)}图），"
                    f"画框 {w:.2f}×{h:.2f} 英寸（{_orientation(w, h)}框）",
                ))

    if len(shrunk) >= 3 and len(shrunk) * 2 > len(names):
        rights = sorted(item[0] for item in shrunk)
        bottoms = sorted(item[1] for item in shrunk)
        problems.append(Problem(
            0, "underfilled",
            f"{len(shrunk)}/{len(names)} 页的内容都缩在左上角：最右大约到 {rights[len(rights) // 2]:.2f}、"
            f"最下大约到 {bottoms[len(bottoms) // 2]:.2f} 英寸，而页面是 {page_w:.2f}×{page_h:.2f} 英寸",
        ))
    problems.extend(crowded[:_CROWD_MAX_LISTED])
    if len(crowded) > _CROWD_MAX_LISTED:
        problems.append(Problem(0, "crowded", f"另有 {len(crowded) - _CROWD_MAX_LISTED} 处文字挤在一起，改法相同"))

    notes: List[str] = []
    if tight:
        notes.append("另外，这些文字框可能装不下（估算，不拦交付）：" + "；".join(tight[:4]))
    body = "".join(all_text)
    if pictures and not any(word in body for word in _CREDIT_WORDS):
        notes.append(f"另外：{pictures} 张图片都没有标注来源。图下方加一行小字，不清楚就写「图片来源：网络」。这一条不拦交付。")
    return DeckReport(
        (page_w, page_h), len(names), pictures, tuple(problems), tuple(notes), len(_AI_LABEL_RE.findall(body)),
    )
