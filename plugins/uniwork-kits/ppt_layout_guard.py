"""Small, deterministic OOXML checks for pages edited without DSL lint.

This is a host delivery check, not a replacement for native lint or visual QA.
Only explicit page geometry is inspected; no font guesses or general overlap
rules that would reject intentional text-on-image designs are used.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from xml.etree import ElementTree as ET

from .tencent_ppt_state import A, P

EMU_PER_PX = 9525
CHECK_VERSION = 1
Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)


def _multiply(a: Matrix, b: Matrix) -> Matrix:
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])


def _orientation(xf: ET.Element, x: float, y: float, w: float, h: float) -> Matrix:
    angle = math.radians(float(xf.get("rot", "0")) / 60000)
    c, s = math.cos(angle), math.sin(angle)
    fx = -1 if xf.get("flipH") in {"1", "true"} else 1
    fy = -1 if xf.get("flipV") in {"1", "true"} else 1
    cx, cy = x+w/2, y+h/2
    return (c*fx, s*fx, -s*fy, c*fy, cx-c*fx*cx+s*fy*cy, cy-s*fx*cx-c*fy*cy)


@dataclass
class Shape:
    """A visible page object in slide coordinates."""

    id: str
    text: str
    x: float
    y: float
    w: float
    h: float
    bar: bool
    bounded: bool


def _shapes(tree: ET.Element, parent: Matrix = IDENTITY) -> list[Shape]:
    result = []
    for node in tree:
        if node.tag not in {P+"sp", P+"pic", P+"graphicFrame", P+"grpSp"}:
            continue
        xf = node.find(f"{P}grpSpPr/{A}xfrm") if node.tag == P+"grpSp" else node.find(f"{P}spPr/{A}xfrm")
        if node.tag == P+"graphicFrame":
            xf = node.find(P+"xfrm")
        if xf is None:
            continue  # Inherited layout geometry cannot be inferred safely here.
        off, ext = xf.find(A+"off"), xf.find(A+"ext")
        if off is None or ext is None:
            continue
        x, y, w, h = [float(v)/EMU_PER_PX for v in (off.get("x", "0"), off.get("y", "0"), ext.get("cx", "0"), ext.get("cy", "0"))]
        matrix = _multiply(parent, _orientation(xf, x, y, w, h))
        if node.tag == P+"grpSp":
            child_off, child_ext = xf.find(A+"chOff"), xf.find(A+"chExt")
            if child_off is None or child_ext is None:
                continue
            cw, ch = float(child_ext.get("cx", "0"))/EMU_PER_PX, float(child_ext.get("cy", "0"))/EMU_PER_PX
            if not cw or not ch:
                continue
            sx, sy = w/cw, h/ch
            mapping: Matrix = (sx, 0, 0, sy, x-float(child_off.get("x", "0"))/EMU_PER_PX*sx,
                               y-float(child_off.get("y", "0"))/EMU_PER_PX*sy)
            result.extend(_shapes(node, _multiply(matrix, mapping)))
            continue
        metadata = node.find(f".//{P}cNvPr")
        if metadata is not None and metadata.get("hidden") in {"1", "true"}:
            continue
        points = [(matrix[0]*a+matrix[2]*b+matrix[4], matrix[1]*a+matrix[3]*b+matrix[5])
                  for a, b in [(x,y), (x+w,y), (x,y+h), (x+w,y+h)]]
        left, top = min(a for a,b in points), min(b for a,b in points)
        width, height = max(a for a,b in points)-left, max(b for a,b in points)-top
        text = "".join(t.text or "" for t in node.iter(A+"t")).strip()
        fill = node.find(f"{P}spPr/{A}solidFill")
        opaque = fill is not None and not any(int(a.get("val", "0")) < 100000 for a in fill.iter(A+"alpha"))
        geom = node.find(f"{P}spPr/{A}prstGeom")
        bar = not text and opaque and geom is not None and geom.get("prst") in {"rect", "roundRect"}
        result.append(Shape(metadata.get("id", "?") if metadata is not None else "?", text,
                            left, top, width, height, bar, bool(text) or node.tag == P+"graphicFrame"))
    return result


def check_page(xml: bytes, width: float, height: float, page_index: int) -> list[dict[str, object]]:
    """Report text/chart overflow and thin opaque strips crossing text interiors."""
    page = ET.fromstring(xml)
    tree = page.find(f"{P}cSld/{P}spTree")
    shapes = _shapes(tree) if tree is not None else []
    issues: list[dict[str, object]] = []
    for shape in shapes:
        overflow = {edge: round(amount, 1) for edge, amount in {
            "left": -shape.x, "top": -shape.y, "right": shape.x+shape.w-width, "bottom": shape.y+shape.h-height,
        }.items() if amount > 2}
        if shape.bounded and overflow:
            issues.append({"ruleId": "slide-bounds", "severity": "error", "page_index": page_index,
                           "shape_id": shape.id, "message": f"第{page_index+1}页对象{shape.id}超出页面(px)：{overflow}；{shape.text[:45]}"})
        if not shape.text or shape.h <= 0:
            continue
        for bar in shapes:
            if not bar.bar or not (0 < bar.h <= min(12, shape.h*0.3)):
                continue
            overlap = min(shape.x+shape.w, bar.x+bar.w)-max(shape.x, bar.x)
            if (shape.y+shape.h*0.2 < bar.y+bar.h/2 < shape.y+shape.h*0.8
                    and overlap >= max(20, shape.w*0.1) and bar.w < shape.w*0.8):
                issues.append({"ruleId": "text-crossing-strip", "severity": "error", "page_index": page_index,
                               "shape_id": shape.id, "message": f"第{page_index+1}页细色块{bar.id}穿过文字对象{shape.id}内部；请移动色块或文字：{shape.text[:45]}"})
    return issues
