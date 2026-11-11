"""Portable drawing helpers adapted from the verified WorkBuddy material workflow.

Coordinates and sizes are points throughout (960 x 540 is 16:9). These are
ordinary python-pptx objects, not a layout template or a replacement DSL.
"""

from __future__ import annotations

import sys

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.table import _Cell
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Pt

DEFAULT_FONT = "Microsoft YaHei" if sys.platform == "win32" else "PingFang SC" if sys.platform == "darwin" else "Noto Sans CJK SC"
SHAPES = {"rect": MSO_SHAPE.RECTANGLE, "roundRect": MSO_SHAPE.ROUNDED_RECTANGLE,
          "diamond": MSO_SHAPE.DIAMOND, "ellipse": MSO_SHAPE.OVAL, "pentagon": MSO_SHAPE.PENTAGON,
          "chevron": MSO_SHAPE.CHEVRON, "homePlate": MSO_SHAPE.PENTAGON,
          "rightArrow": MSO_SHAPE.RIGHT_ARROW, "leftArrow": MSO_SHAPE.LEFT_ARROW}
ALIGN = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT, "justify": PP_ALIGN.JUSTIFY}
ANCHOR = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}


def rgb(color: str) -> RGBColor:
    """Accept an ordinary six-digit RGB color, with or without #."""
    return RGBColor.from_string(color.lstrip("#").upper())


def set_text(shape, text: str, *, size: float = 18, color: str = "1F2937", bold: bool = False,
             font: str = DEFAULT_FONT, align: str = "center", valign: str = "middle",
             margin: float = 5, line_spacing: float = 1.15):
    """Replace text with explicit wrapping, alignment, margins and East Asian font.

    The returned text frame remains accessible for rich runs or other native
    python-pptx formatting; callers are not restricted to these shortcuts.
    """
    frame = shape.text_frame
    frame.clear()
    frame.word_wrap = True
    # Table cell alignment/margins live in tcPr, not the textbox bodyPr.
    owner = shape if isinstance(shape, _Cell) else frame
    owner.vertical_anchor = ANCHOR[valign]
    owner.margin_left = owner.margin_right = owner.margin_top = owner.margin_bottom = Pt(margin)
    for i, line in enumerate(text.split("\n")):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        paragraph.alignment = ALIGN[align]
        paragraph.line_spacing = line_spacing
        run = paragraph.add_run()
        run.text = line
        run.font.name, run.font.size, run.font.bold = font, Pt(size), bold
        run.font.color.rgb = rgb(color)
        props = run._r.get_or_add_rPr()
        for name in ["a:ea", "a:cs"]:
            node = props.find(name, props.nsmap)
            if node is None:
                node = OxmlElement(name)
                props.append(node)
            node.set("typeface", font)
    return frame


def add_shape(slide, kind, x: float, y: float, w: float, h: float, *, text: str = "",
              fill: str | None = "E8F2FA", line: str | None = "145A8C", width: float = 1,
              **text_style):
    """Add any native preset shape, optionally with fully formatted internal text."""
    preset = SHAPES[kind] if isinstance(kind, str) else kind
    shape = slide.shapes.add_shape(preset, Pt(x), Pt(y), Pt(w), Pt(h))
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = rgb(fill)
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = rgb(line)
        shape.line.width = Pt(width)
    shape.shadow.inherit = False
    if text:
        set_text(shape, text, **text_style)
    return shape


def add_text(slide, x: float, y: float, w: float, h: float, text: str, **style):
    """Add a free text box. Node labels should instead use add_shape(text=...)."""
    box = slide.shapes.add_textbox(Pt(x), Pt(y), Pt(w), Pt(h))
    set_text(box, text, **{"align": "left", "valign": "top", "margin": 0, **style})
    return box


def add_route(slide, points, *, color: str = "145A8C", width: float = 1.5,
              arrow: bool = True, dash=None):
    """Add one native straight line or one open freeform polyline.

    A multi-point route is a single editable freeform; it does not bind to nodes.
    Use connect() for a native connector with actual shape connections.
    """
    points = [(Pt(x), Pt(y)) for x, y in points]
    if len(points) < 2:
        raise ValueError("A route needs at least two points")
    if len(points) == 2:
        shape = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, *points[0], *points[1])
    else:
        builder = slide.shapes.build_freeform(*points[0], scale=1.0)
        builder.add_line_segments(points[1:], close=False)
        shape = builder.convert_to_shape()
        shape.fill.background()
    shape.line.color.rgb = rgb(color)
    shape.line.width = Pt(width)
    shape.shadow.inherit = False
    if dash is not None:
        shape.line.dash_style = dash
    if arrow:
        end = OxmlElement("a:tailEnd")
        end.set("type", "triangle")
        shape.line._get_or_add_ln().append(end)
    return shape


def connect(slide, source, target, *, source_site: int = 3, target_site: int = 1,
            elbow: bool = False, color: str = "145A8C", width: float = 1.5):
    """Connect two native shapes using python-pptx's shape connection API.

    Rectangles use 0=top, 1=left, 2=bottom, 3=right; other preset sites can vary.
    Freeform paths cannot have this binding through this helper.
    """
    shape = slide.shapes.add_connector(MSO_CONNECTOR.ELBOW if elbow else MSO_CONNECTOR.STRAIGHT,
                                       source.left+source.width, source.top+source.height//2,
                                       target.left, target.top+target.height//2)
    shape.begin_connect(source, source_site)
    shape.end_connect(target, target_site)
    shape.line.color.rgb = rgb(color)
    shape.line.width = Pt(width)
    shape.shadow.inherit = False
    end = OxmlElement("a:tailEnd")
    end.set("type", "triangle")
    shape.line._get_or_add_ln().append(end)
    return shape
