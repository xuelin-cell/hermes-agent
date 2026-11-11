"""Measure a generated ``.pptx`` the way 数字员工's delivery check does.

The numbers come from decks that actually failed: pictures stretched because
the frame size was passed as the image size, shapes laid out for 13.3×7.5 on
a 10×5.625 page, coordinates multiplied by 96, text sitting on other text,
and a portrait cropped to a landscape sliver. A defect that can be read from
the file is decided here. This module does not call a model.
"""

from __future__ import annotations

import html
import re
import struct
import zipfile
from dataclasses import dataclass
from io import BytesIO
from typing import Dict, List, Optional, Tuple

from . import deck_integrity

EMU = 914400
RATIO_TOLERANCE_PCT = 3.0
BLEED_IN = 0.02
# 内容图裁掉超过两成，或左右/上下裁得不一样，主体就会被切到画面边上。通栏背景不算内容图。
_SUBJECT_KEEP_MIN = 0.80
_CROP_CENTER_GAP = 0.08
CONTENT_PICTURE_MAX_SHARE = 0.6
UNDERFILL_RATIO = 0.8
TEXT_OVERFLOW_RATIO = 1.4
# 超过这个倍数、并且多出来的高度够一行以上，才拦交付。只是略紧仍只提示，避免正常页被打回去。
_OVERFLOW_BLOCK_RATIO = 2.0
_OVERFLOW_BLOCK_IN = 0.45
CROWD_H_OVERLAP = 0.3
CROWD_MIN_GAP_EM = 0.15
_CROWD_MAX_PT = 48.0
_CROWD_MAX_LISTED = 6
_PT_PER_INCH = 72.0
_SINGLE_LINE = 1.2
_CARD_MAX_SHARE = 0.6
_CARD_MIN_ALPHA = 5000
_CARD_TOLERANCE_IN = 0.05
_SPILL_MIN_IN = 0.02
# 图形挡字：不透明度至少 50%，盖住一行字至少三成高度，且图形至少一成半面积落在字上。
_COVER_MIN_ALPHA = 50000
# 后画的图切进文字墨迹大约 1 磅就算压字。按整张图的面积算会放过封面只切掉一行字的情况。
_INK_CUT_IN = 1 / 72
# 字落在图或色块上、对比度低于这个比值就看不清。WCAG 对大字的下限是 3。
_CONTRAST_MIN = 3.0
# 大号字笔画粗，同样的颜色差更容易看清。WCAG 对大字是 3，这里放到 2：橙底白字（约 2.2）、浅底上的大号青色数字
# 这类常见配色不再被打回；浅灰配白（约 1.5）这种真看不清的照样拦。
_CONTRAST_MIN_LARGE = 2.0
# 表格外框比各行高度之和矮过这么多，画出来的行就会伸到框外，压住下面的卡片。
_TABLE_OVERRUN_IN = 0.08
# 写着要居中、中心又落在圆里的文字，上下偏离圆心超过这么多，圆里的数字就偏了。
_CIRCLE_SHIFT_IN = 0.18
_CIRCLE_MIN_IN = 0.8
_CIRCLE_MAX_IN = 4.5
_EDGE_IN = 0.05
# 版面观感类的判断：靠估算和经验阈值，偶尔会把正常的设计判成问题。前两次打回照样要改；
# 改了两次还没过，带着清单交给用户，不再拦（deck_check.MAX_BOUNCES）。其余种类——打不开、程序值、
# 模板记号、文字全堆在一处、行距单位写错、图表取整、表格行溢出——是确定的错，一直拦到改好。
JUDGMENT_KINDS = frozenset({
    "covered_text", "crowded", "text_overflow", "text_out_of_card", "off_slide", "stretched", "cropped",
    "underfilled", "loose_frame", "low_contrast", "off_center", "chip_label", "misaligned",
})
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
# 脚本把程序的值原样写进了页面：对象、未定义、算不出的数。「[object Object]」在哪都是错；
# undefined / NaN 只在一段文字就是它、或者紧挨着中文时算，英文正文里正常出现的这个词不算。
_OBJECT_TEXT_RE = re.compile(r"\[object [A-Za-z]+\]")
_BARE_VALUE_RE = re.compile(r"^\s*(?:undefined|NaN|null|Infinity)\s*$|(?<=[\u4e00-\u9fff%])(?:undefined|NaN)|(?:undefined|NaN)(?=[\u4e00-\u9fff%])")
# 模板没替换干净。普通中文括号、百分号不算。
# 有字母、数字或汉字的文字；只有 emoji 和符号的不算。
_WORDY_RE = re.compile(r"[0-9A-Za-z㐀-鿿]")
# 字自己带阴影、发光或高亮底。
_HALO_RE = re.compile(r"<a:(?:outerShdw|glow|highlight)\b")
_LEFTOVER_RE = re.compile(
    r"\{\{[^}{]{1,40}\}\}|%[_A-Z][A-Z0-9_]{2,}%|\blorem ipsum\b|\[(?:insert|TODO|待填写)[^\]]{0,20}\]",
    re.IGNORECASE,
)
_SIZED_RE = re.compile(r'<a:(?:rPr|endParaRPr)\b[^>]*\bsz="\d+"')
_FILL_RE = re.compile(r"<a:(?:solidFill|gradFill)>")
# 线条自己的颜色不算形状的填充。
_LINE_RE = re.compile(r"<a:ln\b[^>]*/>|<a:ln\b[^>]*>.*?</a:ln>", re.DOTALL)
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
_LINE_POINTS_RE = re.compile(r'<a:lnSpc><a:spcPts val="(\d+)"/>')
# 按磅写的行距比字号的这个比例还小，就当作几行字叠在一起（正常的固定行距至少和字号一样大）。
_TIGHT_SPACING_SHARE = 0.8
_CHART_REL_RE = re.compile(r'Target="(?:\.\./charts/|/ppt/charts/)(chart\d+\.xml)"')
_DATA_LABELS_RE = re.compile(r"<c:dLbls>.*?</c:dLbls>", re.DOTALL)
_NUM_FORMAT_RE = re.compile(r'<c:numFmt formatCode="([^"]*)"')
_CHART_VALUES_RE = re.compile(r"<c:val>.*?</c:val>", re.DOTALL)
_CHART_POINT_RE = re.compile(r"<c:v>([^<]*)</c:v>")
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
    "covered_text": (
        "图形压在了字上：把图形挪开或缩小，给标题和下面的元素之间留够空间；"
        "图标放进卡片里或卡片旁边，不要和标题、正文叠在一起。"
    ),
    "low_contrast": (
        "字和底下的颜色太接近：换成更深或更浅的字色，或在字底下垫一块浅色底。"
        "书影、产品、人物这些真图不要为了让字让路而重画，把字挪到图旁边。"
    ),
    "cropped": (
        "画框比例跟着图走：竖图配竖框、横图配横框；版式不好改时用 sizing type 'contain' 完整放下；"
        "产品、机器、人物必须完整，主体留在画面正中：用 contain 整张放下，不要用 cover 把主体切到边上。"
        "原图里主体已经贴边或被切掉就换一张。确实要裁就用 crop 按主体位置裁，cover 只会裁正中间。"
    ),
    "loose_frame": (
        "图要铺满它所在的卡片，并放在卡片正中。不要贴在上沿或一侧，另一边留一大块空白。"
        "卡片的宽高比跟图片不一致时，改卡片去贴图片，不要让图片缩在卡片的一角。"
    ),
    "text_out_of_card": (
        "文字超出卡片：加高卡片、缩短文字或调小字号。"
        "卡片高度按文字实际行数留够（中文每行字数 ≈ 框宽英寸 × 72 ÷ 字号）。"
    ),
    "table_overflow": (
        "表格的每一行高度加起来比表格外框高，画出来会伸到框外，压住下面的内容。"
        "把外框加高到能放下所有行，或者减少行高；外框下面的卡片要整段挪到表格实际底部之下。"
    ),
    "off_center": (
        "圆里的数字没有对准圆心：文字框本身居中不够，框的中心要和圆的中心重合。"
    ),
    "chip_label": (
        "同一排同样宽的小标签里，有一格字明显更长，这排会挤、会对不齐。"
        "字多的那格加宽，或者改成和旁边一样短的字；不要把五个字塞进给日期留的格子。"
    ),
    "leftover_token": (
        "页面上还留着模板变量或占位符：换成真正的标题、日期或正文，不要把 {{title}}、%DATE% 这种记号交出去。"
    ),
    "text_unplaced": (
        "这一页的文字都堆在同一个起点，是写文字的函数没有把 x、y 传给 addText。"
        "打开 theme.js 或分页文件里的 function txt，把 o.x、o.y 写进 addText 的参数，改完重新生成到同一路径。"
    ),
    "text_overflow": (
        "文字装不进自己的框，末尾会被裁掉：缩短文字、调小字号，或把框加高。"
        "开了自动缩字号（autofit）的框不用这条。"
    ),
    "misaligned": (
        "同一列、大小差不多的文字框，左边距要对齐。偏出去的那一格挪回和其他格子同一条左边线上。"
    ),
    "empty_text": "空文字框多半是取文字的变量名或数组下标写错了，对照数据改好，生成后核对这些框有字。",
    "bad_text": (
        "页面上出现了程序的值：[object Object] 是把对象或数组当成文字传了进去，要取它的字段（如 item.title）"
        "或把数组逐条拼成文字；undefined / NaN 是变量名、字段名或下标写错，或者拿空值算数。对照数据改好再生成。"
    ),
    "fractional_emu": "坐标用英寸，让 pptxgenjs 自己换算。不要把英寸乘 96，小数 EMU 会让 PowerPoint 拒绝打开。",
    "negative_size": "宽高不能是负数：往上斜的线把 y 设在下端、h 写正数并加 flipV: true，往左斜的加 flipH: true。",
    "runaway_number": (
        "数值大得离谱，是因为同一个 shadow 对象传给了多个形状，pptxgenjs 每次都会原地换算。"
        "每个形状单独写一个新对象。"
    ),
    "no_layout": "每一页都要有 ppt/slides/_rels/slideN.xml.rels，里面至少一条指向 slideLayout 的关系。",
    "tight_spacing": (
        "行距按磅写成了比字号还小的数：pptxgenjs 的 lineSpacing 单位是磅，写 1.2 就是 1.2 磅，几行字会叠成一团。"
        "按倍数设行距改用 lineSpacingMultiple（如 1.2），或者去掉 lineSpacing。"
    ),
    "chart_rounding": (
        "图表数值带小数时，数据标签要用带小数的格式：pptxgenjs 写 dataLabelFormatCode: '0.0'"
        "（两位小数写 '0.00'），否则图上的数字会被四舍五入成整数，和正文对不上。"
    ),
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


def _line_height(shape: str) -> float:
    """一行字占的高度（以字号为单位）。行距倍数（lnSpc 的 spcPct）是乘在单倍行距上的，单倍约为字号的 1.2 倍；
    以前把倍数直接当行高，设了行距倍数的文本框会被算矮，实际装不下或叠在一起的字查不出来。"""
    match = _LINE_SPACING_RE.search(shape)
    return _SINGLE_LINE * (int(match.group(1)) / 100000 if match else 1.0)


def _needed_height(shape: str, width_in: float) -> Tuple[float, str]:
    """估算文本框按当前字号、行距和边距排下全部文字需要的高度（英寸），并返回第一段文字作示例。"""
    insets = {key: int(value) / EMU for key, value in _INSET_RE.findall(shape)}
    usable = width_in - insets.get("lIns", _DEFAULT_SIDE_IN) - insets.get("rIns", _DEFAULT_SIDE_IN)
    if usable <= 0:
        return 0.0, ""
    spacing = _line_height(shape)
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
        spacing = _line_height(shape)
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


def _table_overruns(xml: str) -> List[Tuple[str, float]]:
    """表格各行高度之和明显超过外框时，返回（最后一行的文字, 超出英寸）。

    外框只框住声明的范围。放映和预览按每一行的高度往下排，多出来的行会压住表格下面的卡片。
    自检以前只看外框，所以这种压字查不出来。
    """
    found: List[Tuple[str, float]] = []
    for frame in re.findall(r"<p:graphicFrame\b.*?</p:graphicFrame>", xml, re.DOTALL):
        if "<a:tbl>" not in frame and "<a:tbl " not in frame:
            continue
        off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"', frame)
        ext = re.search(r'<a:ext cx="(-?\d+)" cy="(-?\d+)"', frame)
        rows = [int(value) / EMU for value in re.findall(r'<a:tr\b[^>]*\bh="(\d+)"', frame)]
        if not off or not ext or not rows:
            continue
        frame_h = int(ext.group(2)) / EMU
        overrun = sum(rows) - frame_h
        if overrun <= _TABLE_OVERRUN_IN:
            continue
        row_blocks = re.findall(r"<a:tr\b.*?</a:tr>", frame, re.DOTALL)
        last = "".join(_TEXT_RE.findall(row_blocks[-1])).strip() if row_blocks else ""
        found.append((last[:14] or "表格", overrun))
    return found


def _off_center(xml: str) -> List[Tuple[str, float]]:
    """圆里打算居中的文字没有对准圆心时，返回（文字, 上下偏了多少英寸）。

    只看直径够大的正圆，以及中心落在这个圆里、并且写了垂直居中的文字框。
    同一组同心圆取最大的那个。离圆心最近的那一行字偏了才算，圆下方另起的说明文字不算。
    """
    circles: List[Tuple[float, float, float]] = []
    labels: List[Tuple[str, float, float, str]] = []
    for shape in _SP_RE.findall(xml):
        xfrm = _XFRM_RE.search(shape)
        if not xfrm:
            continue
        x, y, w, h = (int(v) / EMU for v in xfrm.groups()[1:])
        text = "".join(_TEXT_RE.findall(shape)).strip()
        if text:
            body = _BODY_PR_RE.search(shape)
            anchor = _attr(body.group(1), "anchor") if body else None
            labels.append((text[:14], x + w / 2, y + h / 2, anchor or ""))
            continue
        preset = re.search(r'<a:prstGeom prst="([^"]+)"', shape)
        if not preset or preset.group(1) != "ellipse":
            continue
        if w < _CIRCLE_MIN_IN or h < _CIRCLE_MIN_IN or max(w, h) > _CIRCLE_MAX_IN:
            continue
        if abs(w - h) / max(w, h) > 0.15:
            continue
        circles.append((x + w / 2, y + h / 2, max(w, h) / 2))
    grouped: List[Tuple[float, float, float]] = []
    for cx, cy, radius in circles:
        for index, (gx, gy, gr) in enumerate(grouped):
            if abs(cx - gx) <= 0.08 and abs(cy - gy) <= 0.08:
                if radius > gr:
                    grouped[index] = (cx, cy, radius)
                break
        else:
            grouped.append((cx, cy, radius))
    found: List[Tuple[str, float]] = []
    for cx, cy, radius in grouped:
        inside = [
            (text, tx, ty, anchor)
            for text, tx, ty, anchor in labels
            if anchor == "ctr" and (tx - cx) ** 2 + (ty - cy) ** 2 <= (radius * 0.9) ** 2
        ]
        # 圆里除了数字还有一行说明时，数字本来就该偏上，给说明让位置。
        if len(inside) != 1:
            continue
        text, tx, ty, _anchor = inside[0]
        shift = ty - cy
        if abs(shift) > _CIRCLE_SHIFT_IN and abs(tx - cx) <= 0.25:
            found.append((text, shift))
    return found


def _chip_labels(xml: str) -> List[str]:
    """同一排、同样宽的小标签里，有一格字数明显长过其余格子时，返回那格的文字。

    用来抓里程碑那一排：日期格子和「导入旧文档」一样宽，字多的那格看起来就不齐。
    只看矮而窄的格子，正文卡片不在这里。
    """
    chips: List[Tuple[str, float, float, float, float]] = []
    for shape in _SP_RE.findall(xml):
        xfrm = _XFRM_RE.search(shape)
        text = "".join(_TEXT_RE.findall(shape)).strip()
        if not xfrm or not text:
            continue
        x, y, w, h = (int(v) / EMU for v in xfrm.groups()[1:])
        if not (0.28 <= h <= 0.48 and 0.7 <= w <= 1.8):
            continue
        size_pt = max((int(v) / 100 for v in _SZ_RE.findall(shape)), default=12.0)
        text_w = _text_width(text) * size_pt / _PT_PER_INCH
        chips.append((text[:14], x, y, w, text_w))
    chips.sort(key=lambda item: (round(item[2], 1), item[1]))
    flagged: List[str] = []
    index = 0
    while index < len(chips):
        row = [chips[index]]
        index += 1
        while index < len(chips) and abs(chips[index][2] - row[0][2]) <= 0.06:
            row.append(chips[index])
            index += 1
        if len(row) < 3:
            continue
        widths = [item[3] for item in row]
        if max(widths) - min(widths) > 0.08:
            continue
        ordered = sorted(item[4] for item in row)
        median = ordered[len(ordered) // 2]
        if median <= 0:
            continue
        dates = [item for item in row if re.fullmatch(r"[\d.\s/\-]+", item[0])]
        # 日期格子里夹了一句词，才会把这一排撑乱。全是步骤名（到店、检查设备）不算。
        if len(dates) < len(row) - 1:
            continue
        for text, _x, _y, width, text_w in row:
            if text in {item[0] for item in dates}:
                continue
            if text_w >= 1.8 * median and text_w >= 0.5 * width:
                flagged.append(text)
    return flagged


def _rotated_ink(shape: str) -> Optional[_Block]:
    """旋转过的文字不进挤字估算，压字检查仍用它的外框，免得整类被跳过。"""
    text = "".join(_TEXT_RE.findall(shape)).strip()
    xfrm = _XFRM_RE.search(shape)
    if not text or not xfrm or (_attr(xfrm.group(1), "rot") or "0") == "0":
        return None
    x, y, w, h = (int(value) / EMU for value in xfrm.groups()[1:])
    if w <= 0 or h <= 0:
        return None
    return _Block(text[:14], 18.0, y, y + h, x, x + w)


def _ink_of(shape: str) -> List[_Block]:
    """这段文字实际占的位置；旋转的用外框。"""
    blocks = _blocks(shape)
    spun = _rotated_ink(shape)
    if spun:
        blocks.append(spun)
    return blocks


def _cuts_ink(block: _Block, x: float, y: float, w: float, h: float) -> bool:
    """后画的图形切进墨迹至少约 1 磅。只碰到文字框的空白不算。"""
    across = min(x + w, block.right) - max(x, block.left)
    down = min(y + h, block.bottom) - max(y, block.top)
    return across >= _INK_CUT_IN and down >= _INK_CUT_IN


def _covered(xml: str) -> List[Tuple[str, int]]:
    """找出被后画的图形压住的文字，返回（示例文字, 压住它的图形个数）。

    按绘制顺序看：后画的在上面。有填充（不透明度 50% 以上）的形状或图片，只要切进文字墨迹约 1 磅就算挡字。
    不按整张图的面积算：封面很大、只切掉一行字时，重叠只占图的很小一块，按面积会放行。
    字下面先画的卡片、只有边框的框线、半透明的装饰不算。
    """
    texts: List[_Block] = []
    hits: Dict[str, int] = {}
    for match in _SHAPE_RE.finditer(xml):
        shape = match.group(0)
        if "".join(_TEXT_RE.findall(shape)).strip():
            texts.extend(_ink_of(shape))
            continue
        box = _BOX_RE.search(shape)
        if not box or not texts:
            continue
        geometry = _LINE_RE.sub("", shape.split("<p:txBody>", 1)[0])
        alphas = [int(v) for v in _ALPHA_RE.findall(geometry)]
        filled = match.group(1) == "pic" or bool(_FILL_RE.search(geometry))
        if not filled or (alphas and max(alphas) < _COVER_MIN_ALPHA):
            continue
        x, y, w, h = (int(v) / EMU for v in box.groups())
        if w <= 0 or h <= 0:
            continue
        for block in texts:
            if _cuts_ink(block, x, y, w, h):
                hits[block.sample] = hits.get(block.sample, 0) + 1
                break
    return list(hits.items())


def _rgb(value: str) -> Tuple[int, int, int]:
    """六位十六进制颜色转成 RGB。"""
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def _contrast_ratio(fore: Tuple[int, int, int], back: Tuple[int, int, int]) -> float:
    """两种颜色的对比度。1 是同色，21 是黑白。"""
    def channel(component: int) -> float:
        """sRGB 分量换成线性亮度。"""
        unit = component / 255
        return unit / 12.92 if unit <= 0.04045 else ((unit + 0.055) / 1.055) ** 2.4

    def luminance(color: Tuple[int, int, int]) -> float:
        """相对亮度。"""
        red, green, blue = (channel(component) for component in color)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue

    fore_l, back_l = luminance(fore), luminance(back)
    lighter, darker = max(fore_l, back_l), min(fore_l, back_l)
    return (lighter + 0.05) / (darker + 0.05)


def _contrast_need(shape: str) -> float:
    """这段字要求的最低对比度：大号字（18 磅以上，或 14 磅以上加粗）笔画粗，彩色圆底上的白色数字这类常见配色看得清。"""
    sizes = [int(value) / 100 for value in _SZ_RE.findall(shape)]
    size = max(sizes) if sizes else 12.0
    bold = bool(re.search(r'<a:rPr\b[^>]*\bb="1"', shape))
    return _CONTRAST_MIN_LARGE if size >= 18 or (bold and size >= 14) else _CONTRAST_MIN


def _overlap_share(block: _Block, x: float, y: float, w: float, h: float) -> float:
    """墨迹有多大一块落在这个矩形里。"""
    ink_w = block.right - block.left
    ink_h = block.bottom - block.top
    if ink_w <= 0 or ink_h <= 0 or w <= 0 or h <= 0:
        return 0.0
    across = min(x + w, block.right) - max(x, block.left)
    down = min(y + h, block.bottom) - max(y, block.top)
    if across <= 0 or down <= 0:
        return 0.0
    return (across * down) / (ink_w * ink_h)


def _sample_rgb(blob: bytes, crop: dict, box: Tuple[float, float, float, float], block: _Block) -> List[Tuple[int, int, int]]:
    """在文字落在图片上的那一块取 3×3 个点的颜色；读不出图片就返回空，不拿来拦交付。"""
    try:
        from PIL import Image
    except ImportError:
        return []
    try:
        image = Image.open(BytesIO(blob)).convert("RGB")
    except Exception:
        return []
    x, y, w, h = box
    left = max(block.left, x)
    right = min(block.right, x + w)
    top = max(block.top, y)
    bottom = min(block.bottom, y + h)
    if right - left < _INK_CUT_IN or bottom - top < _INK_CUT_IN:
        return []
    keep_w = 1 - crop.get("l", 0.0) - crop.get("r", 0.0)
    keep_h = 1 - crop.get("t", 0.0) - crop.get("b", 0.0)
    if keep_w <= 0 or keep_h <= 0:
        return []
    width, height = image.size
    samples = []
    for row in range(3):
        for column in range(3):
            sx = left + (right - left) * (column + 0.5) / 3
            sy = top + (bottom - top) * (row + 0.5) / 3
            px = int((crop.get("l", 0.0) + ((sx - x) / w) * keep_w) * width)
            py = int((crop.get("t", 0.0) + ((sy - y) / h) * keep_h) * height)
            samples.append(image.getpixel((min(width - 1, max(0, px)), min(height - 1, max(0, py))))[:3])
    return samples


def _low_contrast(xml: str, rel_map: dict, archive: zipfile.ZipFile) -> List[str]:
    """字画在图片或实心色块上、对比度不够时返回示例文字。

    只认写明了 RGB 的字色。主题色读不到，不强行当成黑色，免得浅色字被误判。
    字自己的色块底优先于底下的图。图在字下面才比；图盖住字已经由压字检查处理。
    """
    layers: List[tuple] = []
    found: List[str] = []
    for match in _SHAPE_RE.finditer(xml):
        shape = match.group(0)
        box = _BOX_RE.search(shape)
        if not box:
            continue
        x, y, w, h = (int(value) / EMU for value in box.groups())
        text = "".join(_TEXT_RE.findall(shape)).strip()
        if text:
            body = shape.split("<p:txBody>", 1)[-1] if "<p:txBody>" in shape else ""
            font = re.search(r'<a:srgbClr val="([0-9A-Fa-f]{6})"', body)
            if not font or w <= 0 or h <= 0:
                continue
            # 只有 emoji、符号：彩色字形不受字色影响，按字色比会误判（10-23 回放电竞耳机的 🎧 被报）。
            if not _WORDY_RE.search(text):
                continue
            fore = _rgb(font.group(1))
            # 加了阴影、发光或高亮的字，正是为了压在图上也看得清，按底色比会误判。
            if _HALO_RE.search(body):
                continue
            own_fill = _LINE_RE.sub("", shape.split("<p:txBody>", 1)[0])
            own = re.search(r'<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"', own_fill)
            if own and _ALPHA_RE.search(own_fill):
                # 半透明底叠在图上，实际颜色是两者混出来的，算不准就不判。
                continue
            need = _contrast_need(shape)
            for block in _ink_of(shape):
                if own:
                    if _contrast_ratio(fore, _rgb(own.group(1))) < need:
                        found.append(block.sample)
                    break
                for kind, layer_box, payload in reversed(layers):
                    if _overlap_share(block, *layer_box) < 0.5:
                        continue
                    if kind == "solid":
                        if _contrast_ratio(fore, payload) < need:
                            found.append(block.sample)
                        break
                    # 照片明暗不均，平均色会被拉成中灰；按点比，大半的点都看不清才算。
                    samples = _sample_rgb(payload[0], payload[1], layer_box, block)
                    dim = sum(1 for color in samples if _contrast_ratio(fore, color) < need)
                    if samples and dim * 3 >= len(samples) * 2:
                        found.append(block.sample)
                    break
            continue
        if w <= 0 or h <= 0:
            continue
        if match.group(1) == "pic":
            embed = _EMBED_RE.search(shape)
            target = rel_map.get(embed.group(1), "") if embed else ""
            try:
                blob = archive.read("ppt/" + target.replace("../", "")) if target else b""
            except KeyError:
                blob = b""
            if blob:
                layers.append(("pic", (x, y, w, h), (blob, _crop(shape))))
            continue
        geometry = _LINE_RE.sub("", shape)
        alphas = [int(value) for value in _ALPHA_RE.findall(geometry)]
        color = re.search(r'<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"', geometry)
        if color and (not alphas or max(alphas) >= _COVER_MIN_ALPHA):
            layers.append(("solid", (x, y, w, h), _rgb(color.group(1))))
    return found


def _tight_spacing(xml: str) -> List[Tuple[str, float, float]]:
    """找出行距按磅写、却比字号还小的文字框：(文字开头, 行距磅数, 字号)。

    只算会排成两行以上的框：一行字的框行距再小也叠不到别的字上。
    """
    found: List[Tuple[str, float, float]] = []
    for shape in _SP_RE.findall(xml):
        xfrm, body = _XFRM_RE.search(shape), _BODY_PR_RE.search(shape)
        if not xfrm or not body:
            continue
        insets = {key: int(value) / EMU for key, value in _INSET_RE.findall(body.group(1))}
        usable = int(xfrm.group(4)) / EMU - insets.get("lIns", _DEFAULT_SIDE_IN) - insets.get("rIns", _DEFAULT_SIDE_IN)
        if usable <= 0:
            continue
        lines = 0
        worst: Optional[Tuple[str, float, float]] = None
        for para in _PARA_RE.findall(shape):
            text = "".join(_TEXT_RE.findall(para)).strip()
            sizes = [int(v) / 100 for v in _SZ_RE.findall(para)]
            if not text or not sizes:
                continue
            size = max(sizes)
            lines += max(1, int(_text_width(text) * size / _PT_PER_INCH / usable + 0.999))
            points = _LINE_POINTS_RE.search(para)
            if worst is None and points and int(points.group(1)) / 100 < _TIGHT_SPACING_SHARE * size:
                worst = (html.unescape(text)[:14], int(points.group(1)) / 100, size)
        if worst and lines >= 2:
            found.append(worst)
    return found


def _rounded_labels(chart: str) -> Optional[Tuple[str, str]]:
    """图表数值带小数、数据标签却按整数格式显示时，返回 (带小数的一个数值, 标签格式)；没有这种情况返回 None。

    pptxgenjs 默认的标签格式是 #,##0，传 18.6 图上就标 19。百分比格式和「常规」格式会照实显示小数，不算。
    """
    sample = None
    for block in _CHART_VALUES_RE.findall(chart):
        for value in _CHART_POINT_RE.findall(block):
            try:
                number = float(value)
            except ValueError:
                continue
            if number != round(number):
                sample = value
                break
        if sample:
            break
    if sample is None:
        return None
    for labels in _DATA_LABELS_RE.findall(chart):
        if '<c:showVal val="1"/>' not in labels:
            continue
        found = _NUM_FORMAT_RE.search(labels)
        code = found.group(1) if found else "General"
        if "." not in code and "%" not in code and code.lower() != "general":
            return sample, code
    return None


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


def _unplaced(xml: str) -> Optional[Tuple[int, str]]:
    """一页里大半文字落在同一个起点时，返回 (个数, 示例)。写文字的函数没把坐标传进去就是这样。"""
    piles: Dict[Tuple[str, str], List[str]] = {}
    for shape in _SP_RE.findall(xml):
        text = "".join(_TEXT_RE.findall(shape)).strip()
        xfrm = _XFRM_RE.search(shape)
        if not text or not xfrm:
            continue
        piles.setdefault((xfrm.group(2), xfrm.group(3)), []).append(text[:20])
    if not piles:
        return None
    _point, texts = max(piles.items(), key=lambda item: len(item[1]))
    total = sum(len(group) for group in piles.values())
    if len(texts) < 8 or len(texts) * 2 < total:
        return None
    return len(texts), texts[0]


def _loose_frame(xml: str, page_w: float = 0.0, page_h: float = 0.0) -> List[str]:
    """图片缩在更大的色块里、没有铺满，或贴在一边留出大块空白。

    细边框（每边不到约 0.22 英寸）算卡片的内边距。只查边长超过 1 英寸的图，小图标不算。
    最大那块空白里放着文字、并且字占得够多（图上文下的图文卡片）不算，那块空白本来就是留给字的；
    图下面一行很小的来源说明撑不起一大块空白，照样算没铺满。
    占了大半页的色块是背景或大面板，不当作这张图的卡片。
    """
    frames: List[Tuple[float, float, float, float]] = []
    pictures: List[Tuple[float, float, float, float]] = []
    texts: List[Tuple[float, float, float, float]] = []
    for match in _SHAPE_RE.finditer(xml):
        box = _BOX_RE.search(match.group(0))
        if not box:
            continue
        x, y, w, h = (int(value) / EMU for value in box.groups())
        if match.group(1) == "sp" and "".join(_TEXT_RE.findall(match.group(0))).strip():
            texts.append((x, y, w, h))
        if w < 1.0 or h < 1.0:
            continue
        if match.group(1) == "pic":
            pictures.append((x, y, w, h))
            continue
        geometry = _LINE_RE.sub("", match.group(0).split("<p:txBody>", 1)[0])
        if "".join(_TEXT_RE.findall(match.group(0))).strip() or not _FILL_RE.search(geometry):
            continue
        frames.append((x, y, w, h))
    found: List[str] = []
    for left, top, width, height in pictures:
        containers = [
            frame for frame in frames
            if left >= frame[0] - 0.04 and top >= frame[1] - 0.04
            and left + width <= frame[0] + frame[2] + 0.04
            and top + height <= frame[1] + frame[3] + 0.04
            and frame[2] * frame[3] > width * height * 1.08
            and not (page_w and page_h and frame[2] * frame[3] >= 0.6 * page_w * page_h)
        ]
        if not containers:
            continue
        frame = min(containers, key=lambda item: item[2] * item[3])
        gaps = (
            left - frame[0],
            frame[0] + frame[2] - (left + width),
            top - frame[1],
            frame[1] + frame[3] - (top + height),
        )
        # 空白要同时超过约 0.22 英寸和卡片这一边长的两成才算没铺满：产品图在卡片里四周留一圈边是正常的
        # （10-23 回放华为汽车两页照片卡被误报），七龙珠那种半张卡片空着的照样拦。
        side_len = (frame[2], frame[2], frame[3], frame[3])
        if not any(gap >= 0.22 and gap >= 0.2 * length for gap, length in zip(gaps, side_len)):
            continue
        if not _gap_holds_text(frame, (left, top, width, height), gaps, texts):
            found.append("图片")
    return found


def _gap_holds_text(
    frame: Tuple[float, float, float, float],
    picture: Tuple[float, float, float, float],
    gaps: Tuple[float, float, float, float],
    texts: List[Tuple[float, float, float, float]],
) -> bool:
    """卡片里最大那块空白放着文字、并且字沿空白方向占到四成以上：这是图文卡片，不是图没铺满。"""
    fx, fy, fw, fh = frame
    px, py, pw, ph = picture
    side = max(range(4), key=lambda index: gaps[index])
    region = (
        (fx, fy, px - fx, fh),
        (px + pw, fy, fx + fw - (px + pw), fh),
        (fx, fy, fw, py - fy),
        (fx, py + ph, fw, fy + fh - (py + ph)),
    )[side]
    rx, ry, rw, rh = region
    for tx, ty, tw, th in texts:
        cx, cy = tx + tw / 2, ty + th / 2
        if not (rx <= cx <= rx + rw and ry <= cy <= ry + rh):
            continue
        # 左右的空白看字的宽，上下的空白看字的高。
        if (tw if side < 2 else th) >= 0.4 * gaps[side]:
            return True
    return False


def _crop_off_center(crop: dict) -> bool:
    """裁切窗口不在正中：一边裁得多、对边几乎不裁。contain 的负值是留白，不算裁。"""
    left, top, right, bottom = (max(0.0, float(crop.get(key, 0.0))) for key in ("l", "t", "r", "b"))
    if max(left, top, right, bottom) < 0.04:
        return False
    return abs(left - right) >= _CROP_CENTER_GAP or abs(top - bottom) >= _CROP_CENTER_GAP


def _orientation(width: float, height: float) -> str:
    """按宽高比判断横、竖还是方。"""
    ratio = width / height if height else 1.0
    return "横" if ratio > 1.15 else ("竖" if ratio < 0.87 else "方")


_GRP_TOKEN_RE = re.compile(r"<p:grpSp(?:\s[^>]*)?>|</p:grpSp>")


def _flatten_groups(xml: str) -> str:
    """把组合形状拆开，子形状的坐标换算到页面上。

    只扫最外层会漏掉组里的文字和越界。换算按组合自己的 off/ext 和 chOff/chExt。
    从最里层往外拆，嵌套组合也能换算到页面坐标。
    """
    while "<p:grpSp>" in xml or "<p:grpSp " in xml:
        start = _innermost_group(xml)
        if start is None:
            return xml
        end = _group_end(xml, start)
        if end is None:
            return xml
        xml = xml[:start] + _hoist_group(xml[start:end]) + xml[end:]
    return xml


def _innermost_group(xml: str) -> Optional[int]:
    """最深一层组合的起点；没有组合返回 None。"""
    stack: List[int] = []
    found: Optional[int] = None
    depth = -1
    for token in _GRP_TOKEN_RE.finditer(xml):
        if token.group(0).startswith("</"):
            if not stack:
                continue
            start = stack.pop()
            if len(stack) >= depth:
                found, depth = start, len(stack)
        else:
            stack.append(token.start())
    return found


def _group_end(xml: str, start: int) -> Optional[int]:
    """从某个组合起点找到与之配对的结束位置。"""
    depth = 0
    for token in _GRP_TOKEN_RE.finditer(xml, start):
        if token.group(0).startswith("</"):
            depth -= 1
            if depth == 0:
                return token.end()
        else:
            depth += 1
    return None


def _hoist_group(group: str) -> str:
    """去掉一层组合，把里面的形状坐标平移、缩放到页面坐标。整组被标成隐藏的直接丢掉。"""
    header = re.search(r"<p:nvGrpSpPr>.*?</p:nvGrpSpPr>", group, re.DOTALL)
    if header and re.search(r'\bhidden="1"', header.group(0)):
        return ""
    xfrm = _XFRM_RE.search(group)
    if not xfrm:
        return ""
    gx, gy, gw, gh = (int(value) for value in xfrm.groups()[1:])
    child_off = re.search(r'<a:chOff x="(-?\d+)" y="(-?\d+)"', group)
    child_ext = re.search(r'<a:chExt cx="(-?\d+)" cy="(-?\d+)"', group)
    origin_x = int(child_off.group(1)) if child_off else 0
    origin_y = int(child_off.group(2)) if child_off else 0
    space_w = int(child_ext.group(1)) if child_ext else gw
    space_h = int(child_ext.group(2)) if child_ext else gh
    scale_x = gw / space_w if space_w else 1
    scale_y = gh / space_h if space_h else 1
    body = re.sub(r"<p:nvGrpSpPr>.*?</p:nvGrpSpPr>", "", group, count=1, flags=re.DOTALL)
    body = re.sub(r"<p:grpSpPr>.*?</p:grpSpPr>", "", body, count=1, flags=re.DOTALL)
    body = re.sub(r"^<p:grpSp(?:\s[^>]*)?>", "", body)
    body = re.sub(r"</p:grpSp>$", "", body)

    def move(found: re.Match) -> str:
        x, y, w, h = (int(value) for value in found.groups()[1:])
        moved = (
            int(round(gx + (x - origin_x) * scale_x)),
            int(round(gy + (y - origin_y) * scale_y)),
            int(round(w * scale_x)),
            int(round(h * scale_y)),
        )
        return (
            f'<a:xfrm{found.group(1)}><a:off x="{moved[0]}" y="{moved[1]}"/>'
            f'<a:ext cx="{moved[2]}" cy="{moved[3]}"/>'
        )

    return _XFRM_RE.sub(move, body)


def _drop_hidden(xml: str) -> str:
    """隐藏形状不参与版面判断：看不见的装饰出界不该把整页打回去。"""
    def keep(match: re.Match) -> str:
        head = match.group(0)[:900]
        return "" if re.search(r'\bhidden="1"', head) else match.group(0)

    return _SHAPE_RE.sub(keep, xml)


def _leftover_tokens(xml: str) -> List[str]:
    """模板变量、假文还留在页面上时，返回示例。"""
    samples = []
    for text in _TEXT_RE.findall(xml):
        plain = html.unescape(text).strip()
        if _LEFTOVER_RE.search(plain) and plain not in samples:
            samples.append(plain[:30])
    return samples


def _blank_titles(xml: str) -> int:
    """标题、副标题占位符一个字都没有的个数。日期和页码占位符空着不算。"""
    return sum(
        1
        for shape in _SP_RE.findall(xml)
        if re.search(r'<p:ph\b[^>]*\btype="(?:title|ctrTitle|subTitle)"', shape)
        and not "".join(_TEXT_RE.findall(shape)).strip()
    )


def _misaligned(xml: str) -> List[str]:
    """同一列、大小接近的文字框里，左边距偏了 0.12～0.45 英寸的那几格。

    至少三格已经对齐，才把偏出去的那一格算问题。差一点点、或者本来就是两列，都不算。
    """
    boxes = []
    for shape in _SP_RE.findall(xml):
        text = "".join(_TEXT_RE.findall(shape)).strip()
        xfrm = _XFRM_RE.search(shape)
        if not text or not xfrm or len(text) < 2:
            continue
        x, y, w, h = (int(value) / EMU for value in xfrm.groups()[1:])
        if not (0.28 <= h <= 1.2 and 1.2 <= w <= 6.0):
            continue
        boxes.append((x, y, w, h, text[:14]))
    flagged: List[str] = []
    seen = set()
    for anchor in boxes:
        peers = [
            other for other in boxes
            if abs(other[3] - anchor[3]) <= 0.06 and abs(other[2] - anchor[2]) <= 0.15
        ]
        if len(peers) < 4:
            continue
        ys = [item[1] for item in peers]
        if max(ys) - min(ys) < 0.5:
            continue
        best_left = 0.0
        best_count = 0
        for left, *_rest in peers:
            count = sum(1 for item in peers if abs(item[0] - left) <= 0.05)
            if count > best_count:
                best_left, best_count = left, count
        if best_count < 3:
            continue
        for item in peers:
            shift = abs(item[0] - best_left)
            if 0.12 <= shift <= 0.45 and item[4] not in seen:
                seen.add(item[4])
                flagged.append(item[4])
    return flagged


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
    overflows: List[Problem] = []
    crowded: List[Problem] = []
    close: List[str] = []
    shrunk: List[Tuple[float, float]] = []
    spacing: List[Tuple[int, int, Tuple[str, float, float]]] = []
    remote: List[int] = []
    typefaces: set[str] = set()

    for name in names:
        number = int(_SLIDE_RE.fullmatch(name).group(1))  # type: ignore[union-attr]
        xml = _drop_hidden(_flatten_groups(archive.read(name).decode("utf-8", "ignore")))
        all_text.extend(_TEXT_RE.findall(xml))
        try:
            rels = archive.read(f"ppt/slides/_rels/slide{number}.xml.rels").decode("utf-8", "ignore")
        except KeyError:
            rels = ""
        if not _LAYOUT_REL_RE.search(rels):
            problems.append(Problem(number, "no_layout", "这一页没有指向版式（slideLayout）的关系，PowerPoint 可能拒绝打开"))
        if re.search(r'Target="https?://', rels):
            remote.append(number)
        for face in re.findall(r'<a:(?:latin|ea)\b[^>]*\btypeface="([^"]+)"', xml):
            if face and not face.startswith("+"):
                typefaces.add(face)
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
        pile = _unplaced(xml)
        if pile:
            count, sample = pile
            problems.append(Problem(
                number, "text_unplaced",
                f"有 {count} 处文字叠在同一个起点，例如「{sample}」",
            ))
        else:
            for first, second, overlap in _crowded(xml):
                # 估算的文字区（已扣掉内边距和行距）叠上了才退回；只是间距小，字没有碰到，只提示。
                if overlap > 0:
                    crowded.append(Problem(number, "crowded", f"「{first}」和「{second}」挤在一起（重叠 {overlap:.2f} 英寸）"))
                else:
                    close.append(f"第{number}页「{first}」和「{second}」")
        if page_w and page_h:
            for sample, past in _spills(xml, page_w, page_h):
                problems.append(Problem(
                    number, "text_out_of_card", f"「{sample}」的文字超出了所在卡片的边（估计超出 {past:.2f} 英寸）",
                ))
        for sample, count in _covered(xml):
            problems.append(Problem(number, "covered_text", f"「{sample}」被后画的 {count} 个图形压住了"))
        if _loose_frame(xml, page_w, page_h):
            problems.append(Problem(
                number, "loose_frame",
                "有图片缩在卡片里，没有铺满，或贴在一边留下大块空白",
            ))
        for sample, overrun in _table_overruns(xml):
            problems.append(Problem(
                number, "table_overflow",
                f"表格各行加起来比外框高出 {overrun:.2f} 英寸，多出来的行会画到框外"
                + (f"，例如「{sample}」" if sample else ""),
            ))
        for sample, shift in _off_center(xml):
            problems.append(Problem(
                number, "off_center",
                f"「{sample}」写在圆里，但没有对准圆心（上下偏了 {abs(shift):.2f} 英寸）",
            ))
        for sample in _chip_labels(xml):
            problems.append(Problem(
                number, "chip_label",
                f"「{sample}」和同一排其他标签一样宽，字却长得多，这一排会对不齐",
            ))
        for sample in _misaligned(xml):
            problems.append(Problem(
                number, "misaligned",
                f"「{sample}」和同一列其他文字框差不多大，左边却偏了一截",
            ))
        empty = sum(
            1 for shape in _SP_RE.findall(xml)
            if "<p:txBody>" in shape and "<p:ph" not in shape
            and not "".join(_TEXT_RE.findall(shape)).strip() and _SIZED_RE.search(shape)
        )
        if empty:
            problems.append(Problem(number, "empty_text", f"有 {empty} 个文字框是空的：设了字号，却一个字都没有"))
        blank = _blank_titles(xml)
        if blank:
            problems.append(Problem(number, "empty_text", f"有 {blank} 个标题占位符是空的"))
        bad = [text for text in _TEXT_RE.findall(xml) if _OBJECT_TEXT_RE.search(text) or _BARE_VALUE_RE.search(text)]
        if bad:
            problems.append(Problem(number, "bad_text", f"有 {len(bad)} 处文字是程序的值，例如「{bad[0].strip()[:30]}」"))
        leftover = _leftover_tokens(xml)
        if leftover:
            problems.append(Problem(
                number, "leftover_token",
                f"还有模板记号没换成正文，例如「{leftover[0]}」",
            ))
        squeezed = _tight_spacing(xml)
        if squeezed:
            spacing.append((number, len(squeezed), squeezed[0]))
        for chart_name in dict.fromkeys(_CHART_REL_RE.findall(rels)):
            try:
                chart = archive.read(f"ppt/charts/{chart_name}").decode("utf-8", "ignore")
            except KeyError:
                continue
            rounded = _rounded_labels(chart)
            if rounded:
                problems.append(Problem(
                    number, "chart_rounding",
                    f"图表的数值带小数（如 {rounded[0]}），数据标签却按整数格式（{rounded[1]}）显示，图上会被四舍五入",
                ))
        rel_map = dict(_REL_RE.findall(rels))
        for sample in _low_contrast(xml, rel_map, archive):
            problems.append(Problem(number, "low_contrast", f"「{sample}」和底下的颜色太接近，字看不清"))
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
            # 没有字的装饰形状（封面上露半个的圆、贴边色条）故意出血，放映时自然裁掉，不算问题；
            # 整个都在页面外才算坐标写错。字和图片出界照样拦。
            bleeding = label == "形状" and page_w and page_h and x < page_w and y < page_h and x + w > 0 and y + h > 0
            if over and not bleeding:
                problems.append(Problem(
                    number, "off_slide",
                    f"「{label}」放在页面外：{'、'.join(over)}（页面 {page_w:.2f}×{page_h:.2f} 英寸）",
                ))
            if "<p:pic>" not in shape:
                if h > 0 and "<a:normAutofit" not in shape and "<a:spAutoFit" not in shape:
                    needed, sample = _needed_height(shape, w)
                    if sample and needed > h * TEXT_OVERFLOW_RATIO:
                        clipped = needed > h * _OVERFLOW_BLOCK_RATIO and needed - h > _OVERFLOW_BLOCK_IN
                        if clipped:
                            overflows.append(Problem(
                                number, "text_overflow",
                                f"「{sample[:14]}」装不进文字框：框高 {h:.2f} 英寸，估计需要 {needed:.2f} 英寸",
                            ))
                        else:
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
            if content_picture and _crop_off_center(crop):
                problems.append(Problem(
                    number, "cropped",
                    f"图片裁切不在正中：原图 {pixels[0]}×{pixels[1]}，左右或上下裁掉的比例不一样，主体会被切到画面边上",
                ))
                continue
            if content_picture and min(keep_w, keep_h) < _SUBJECT_KEEP_MIN:
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
    # 行距写错通常整份都错（一个公共版式函数用到每一页），页数多时合成一条，免得退回清单被它刷满。
    if len(spacing) > 3:
        total = sum(count for _number, count, _first in spacing)
        sample, points, size = spacing[0][2]
        problems.append(Problem(
            0, "tight_spacing",
            f"第 {'、'.join(str(number) for number, _count, _first in spacing)} 页共 {total} 处文字的行距比字号还小，"
            f"几行字会叠在一起，例如第{spacing[0][0]}页「{sample}」：行距 {points:g} 磅，字号 {size:g} 磅",
        ))
    else:
        for number, count, (sample, points, size) in spacing:
            problems.append(Problem(
                number, "tight_spacing",
                f"{count} 处文字的行距比字号还小，几行字会叠在一起，例如「{sample}」：行距 {points:g} 磅，字号 {size:g} 磅",
            ))
    problems.extend(crowded[:_CROWD_MAX_LISTED])
    if len(crowded) > _CROWD_MAX_LISTED:
        problems.append(Problem(0, "crowded", f"另有 {len(crowded) - _CROWD_MAX_LISTED} 处文字挤在一起，改法相同"))
    problems.extend(overflows[:_CROWD_MAX_LISTED])
    if len(overflows) > _CROWD_MAX_LISTED:
        problems.append(Problem(0, "text_overflow", f"另有 {len(overflows) - _CROWD_MAX_LISTED} 处文字装不进框，改法相同"))

    for notes_name in archive.namelist():
        if not notes_name.startswith("ppt/notesSlides/notesSlide"):
            continue
        notes_xml = archive.read(notes_name).decode("utf-8", "ignore")
        leftover = _leftover_tokens(notes_xml)
        if leftover:
            problems.append(Problem(0, "leftover_token", f"备注里还有模板记号没换成正文，例如「{leftover[0]}」"))
            break

    notes: List[str] = []
    if tight:
        notes.append("另外，这些文字框可能装不下（估算，不拦交付）：" + "；".join(tight[:4]))
    if close:
        notes.append("另外，这些文字靠得很近，但没有叠在一起（不拦交付，顺手能拉开就拉开）：" + "；".join(close[:4]))
    if remote:
        shown = "、".join(str(number) for number in remote[:4])
        notes.append(f"另外：第 {shown} 页有外链图片，断网或链接失效后这一页会空。这一条不拦交付。")
    if len(typefaces) > 3:
        shown = "、".join(sorted(typefaces)[:4])
        notes.append(f"另外：这份用了 {len(typefaces)} 种字体（{shown}）。正文收成两种更整齐。这一条不拦交付。")
    body = "".join(all_text)
    if pictures and not any(word in body for word in _CREDIT_WORDS):
        notes.append(f"另外：{pictures} 张图片都没有标注来源。图下方加一行小字，不清楚就写「图片来源：网络」。这一条不拦交付。")
    return DeckReport(
        (page_w, page_h), len(names), pictures, tuple(_condense(problems)), tuple(notes), len(_AI_LABEL_RE.findall(body)),
    )


_SAMPLE_RE = re.compile(r"^「([^」]*)」(.*)$", re.DOTALL)
# 只是数字不同的（页码、编号 01/02）当作同一段字。
_NUMBERING_RE = re.compile(r"[\d\s/·.\-]+")


def _condense(problems: List[Problem]) -> List[Problem]:
    """同一段字在三页以上出同样的问题（页脚、页码、编号这类每页都用的写法），合成一条；同类问题最多列几条。

    退回清单太长时模型会逐页去改、改上好几轮：10-23 相机一次列了 58 条（同一个页脚每页一条），
    逐页 patch 六七轮、每轮先长时间思考，返工花了 21 分钟，其实改公共函数一处就够。问题种类不变，
    确定的错照样一直拦，只是写法变短。
    """
    groups: Dict[tuple, List[Problem]] = {}
    for item in problems:
        match = _SAMPLE_RE.match(item.detail) if item.slide else None
        if not match:
            key: tuple = (item.kind, None, id(item))
        else:
            sample, rest = match.groups()
            key = (item.kind, "#" if _NUMBERING_RE.fullmatch(sample) else sample, rest)
        groups.setdefault(key, []).append(item)
    merged: List[Problem] = []
    for (kind, token, rest), items in groups.items():
        pages = sorted({item.slide for item in items})
        if token is None or len(pages) < 3:
            merged.extend(items)
            continue
        samples = list(dict.fromkeys(_SAMPLE_RE.match(item.detail).group(1) for item in items))  # type: ignore[union-attr]
        shown = "「" + "」「".join(samples[:3]) + "」" if token == "#" else f"「{samples[0]}」"
        merged.append(Problem(
            0, kind,
            f"{shown}在第 {'、'.join(str(page) for page in pages)} 页都{rest}"
            "（每页都用的公共写法，如页脚、页码、编号：改公共函数一处即可）",
        ))
    listed: List[Problem] = []
    counts: Dict[str, int] = {}
    hidden: Dict[str, int] = {}
    for item in merged:
        counts[item.kind] = counts.get(item.kind, 0) + 1
        if counts[item.kind] <= _CROWD_MAX_LISTED:
            listed.append(item)
        else:
            hidden[item.kind] = hidden.get(item.kind, 0) + 1
    listed.extend(Problem(0, kind, f"另有 {count} 处同类问题，改法相同") for kind, count in hidden.items())
    return listed
