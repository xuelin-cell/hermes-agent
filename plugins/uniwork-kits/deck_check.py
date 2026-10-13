"""Deck geometry and landing a searched image onto a slide.

The check measures the file: a picture whose frame does not match its pixel
aspect is stretched, and a shape past the page edge is off the slide. Landing
writes the image into the pptx at that same aspect, so the check can pass.
Search itself stays in :mod:`media_slot`; this module only stores bytes it is
given.
"""

from __future__ import annotations

import io
import re
import struct
import zipfile
from pathlib import Path
from typing import List, Optional, Tuple

EMU = 914400
RATIO_TOLERANCE_PCT = 3.0
BLEED_IN = 0.02


def image_pixels(data: bytes) -> Optional[Tuple[int, int]]:
    """Width and height of a PNG or JPEG, or ``None`` when the format is unknown."""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
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


def _problems(data: bytes) -> List[str]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        presentation = archive.read("ppt/presentation.xml").decode("utf-8", "ignore")
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        return [f"文件读不开：{exc}"]
    size = re.search(r'sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"', presentation)
    page_w = int(size.group(1)) / EMU if size else 0.0
    page_h = int(size.group(2)) / EMU if size else 0.0
    problems: List[str] = []
    slides = sorted(name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name))
    for name in slides:
        number = int(re.search(r"slide(\d+)", name).group(1))
        xml = archive.read(name).decode("utf-8", "ignore")
        try:
            rels = archive.read(f"ppt/slides/_rels/slide{number}.xml.rels").decode("utf-8", "ignore")
        except KeyError:
            rels = ""
        rel_map = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
        for shape in re.findall(r"<p:pic>.*?</p:pic>|<p:sp>.*?</p:sp>", xml, flags=re.S):
            off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"', shape)
            ext = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', shape)
            if not off or not ext:
                continue
            x = int(off.group(1)) / EMU
            y = int(off.group(2)) / EMU
            width = int(ext.group(1)) / EMU
            height = int(ext.group(2)) / EMU
            over = []
            if page_w and x + width > page_w + BLEED_IN:
                over.append("右边超出页面")
            if page_h and y + height > page_h + BLEED_IN:
                over.append("下边超出页面")
            if x < -BLEED_IN or y < -BLEED_IN:
                over.append("左边或上边出界")
            if over:
                problems.append(f"第{number}页有形状{'、'.join(over)}")
            if "<p:pic>" not in shape or not width or not height:
                continue
            embed = re.search(r'r:embed="([^"]+)"', shape)
            if not embed:
                continue
            target = rel_map.get(embed.group(1), "").replace("../", "")
            try:
                blob = archive.read("ppt/" + target)
            except KeyError:
                continue
            pixels = image_pixels(blob)
            if not pixels:
                continue
            deviation = abs((pixels[0] / pixels[1]) - (width / height)) / (width / height) * 100
            if deviation > RATIO_TOLERANCE_PCT:
                problems.append(
                    f"第{number}页图片被拉伸 {deviation:.0f}%：原图 {pixels[0]}×{pixels[1]}，"
                    f"画框 {width:.2f}×{height:.2f} 英寸"
                )
    return problems


def check_pptx(path: Path) -> List[str]:
    """Problems in *path*. An unreadable file yields one problem, not an exception."""
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        return [f"文件读不开：{exc}"]
    return _problems(data)


def insert_picture(pptx_path: Path, image: bytes, slide: int = 1) -> str:
    """Put *image* on *slide*, sized to its pixel aspect, and rewrite the pptx."""
    pixels = image_pixels(image)
    if not pixels:
        raise ValueError("这张图不是 PNG 或 JPEG，没有放进幻灯片")
    path = Path(pptx_path)
    original = path.read_bytes()
    archive = zipfile.ZipFile(io.BytesIO(original))
    slide_name = f"ppt/slides/slide{slide}.xml"
    rels_name = f"ppt/slides/_rels/slide{slide}.xml.rels"
    try:
        slide_xml = archive.read(slide_name).decode("utf-8")
        rels_xml = archive.read(rels_name).decode("utf-8")
    except KeyError as exc:
        raise ValueError(f"幻灯片里没有第 {slide} 页") from exc
    media_name = "ppt/media/landed-image.png" if image.startswith(b"\x89PNG") else "ppt/media/landed-image.jpg"
    relation = "rIdLanded"
    width_in = 6.0
    height_in = width_in * pixels[1] / pixels[0]
    if height_in > 4.5:
        height_in = 4.5
        width_in = height_in * pixels[0] / pixels[1]
    cx = int(width_in * EMU)
    cy = int(height_in * EMU)
    off_x = int(0.5 * EMU)
    off_y = int(0.5 * EMU)
    picture = (
        "<p:pic><p:nvPicPr><p:cNvPr id=\"900\" name=\"landed\"/>"
        "<p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>"
        "<p:blipFill><a:blip r:embed=\"rIdLanded\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>"
        "<p:spPr><a:xfrm>"
        f'<a:off x="{off_x}" y="{off_y}"/><a:ext cx="{cx}" cy="{cy}"/>'
        "</a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>"
    )
    if "</p:spTree>" not in slide_xml:
        raise ValueError("这一页没有可放入图片的 spTree")
    slide_xml = slide_xml.replace("</p:spTree>", picture + "</p:spTree>", 1)
    relationship = (
        f'<Relationship Id="{relation}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        f'Target="../{media_name.removeprefix("ppt/")}"/>'
    )
    rels_xml = rels_xml.replace("</Relationships>", relationship + "</Relationships>", 1)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as rebuilt:
        names = set(archive.namelist())
        for name in names:
            if name in {slide_name, rels_name, media_name}:
                continue
            rebuilt.writestr(name, archive.read(name))
        rebuilt.writestr(slide_name, slide_xml.encode("utf-8"))
        rebuilt.writestr(rels_name, rels_xml.encode("utf-8"))
        rebuilt.writestr(media_name, image)
    path.write_bytes(buffer.getvalue())
    return f"已把图片放进第 {slide} 页，画框 {width_in:.2f}×{height_in:.2f} 英寸，比例与 {pixels[0]}×{pixels[1]} 一致。"


def land_image(directory: Path, name: str, image: bytes, source: str = "") -> str:
    """Save *image* and return the line the model should read."""
    pixels = image_pixels(image)
    if not pixels:
        raise ValueError("落地的文件不是 PNG 或 JPEG")
    safe = Path(name).name
    if not safe or safe in {".", ".."}:
        raise ValueError("落地文件名不合法")
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / safe
    dest.write_bytes(image)
    origin = f"来源：{source}。" if source else "来源未提供，放上幻灯片时标「图片来源：网络」。"
    return f"已落地 {dest}（{pixels[0]}×{pixels[1]}）。{origin}放进幻灯片时画框比例必须与像素比例一致。"


def annotate(tool_name: str, args: object, result: str) -> Optional[str]:
    """Append a geometry report when a tool just wrote a pptx. ``None`` leaves the result."""
    path = _pptx_path(args)
    notes: List[str] = []
    if isinstance(args, dict) and path is not None and path.is_file():
        image = args.get("image_path") or args.get("image")
        if isinstance(image, str) and Path(image).is_file():
            try:
                notes.append(insert_picture(path, Path(image).read_bytes()))
            except ValueError as exc:
                notes.append(str(exc))
        notes.extend(check_pptx(path))
    if not notes:
        return None
    body = result if isinstance(result, str) else str(result)
    lines = "\n".join(f"- {item}" for item in notes)
    return body.rstrip() + "\n\n配图检查：\n" + lines


def _pptx_path(args: object) -> Optional[Path]:
    if not isinstance(args, dict):
        return None
    for key in ("path", "file_path", "file", "target"):
        value = args.get(key)
        if isinstance(value, str) and value.lower().endswith(".pptx"):
            return Path(value)
    return None
