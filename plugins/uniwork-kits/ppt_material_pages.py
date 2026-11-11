"""Free-position native objects from task-owned page data, without model-written plumbing."""
from __future__ import annotations

import json
from pathlib import Path
from collections import Counter
import re

from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Pt

from ppt_material_helpers import add_shape, add_text, add_route, rgb, set_text


def _text(shape, element):
    style = dict(element.get("style", {}))
    if "paragraphs" not in element and "runs" not in element:
        set_text(shape, element.get("text", ""), **style)
        return
    paragraphs = []
    for definition in element.get("paragraphs", [{"runs": element.get("runs", [])}]):
        line = {"runs": []}
        paragraphs.append(line)
        for fragment in definition["runs"]:
            for index, text in enumerate(fragment["text"].split("\n")):
                if index:
                    line = {"runs": []}
                    paragraphs.append(line)
                line["runs"].append({**fragment, "text": text})
    # Reuse exactly the same margins/font/alignment as ordinary text.
    frame = set_text(shape, "\n".join("" for _ in paragraphs), **style)
    for paragraph, definition in zip(frame.paragraphs, paragraphs, strict=True):
        paragraph.clear()
        for fragment in definition["runs"]:
            run = paragraph.add_run()
            run.text = fragment["text"]
            run.font.name = fragment.get("font", style.get("font", "Microsoft YaHei"))
            run.font.size = Pt(fragment.get("size", style.get("size", 18)))
            run.font.bold = fragment.get("bold", style.get("bold", False))
            run.font.color.rgb = rgb(fragment.get("color", style.get("color", "1F2937")))
            from pptx.oxml.xmlchemy import OxmlElement
            east_asian = OxmlElement("a:ea")
            east_asian.set("typeface", run.font.name)
            run._r.get_or_add_rPr().append(east_asian)


def _box(slide, element):
    bounds = [element[k] for k in ("x", "y", "w", "h")]
    if element["type"] == "text":
        shape = add_text(slide, *bounds, "", **element.get("style", {}))
        # Textboxes use left/top alignment unless explicitly overridden.
        element = {**element, "style": {"align": "left", "valign": "top", "margin": 0, **element.get("style", {})}}
    else:
        shape = add_shape(slide, element.get("shape", "rect"), *bounds, fill=element.get("fill", "FFFFFF"),
                          line=element.get("line"), width=element.get("line_width", 1))
    _text(shape, element)


def _table(slide, element):
    rows = element["rows"]
    if not rows or not rows[0] or any(len(r) != len(rows[0]) for r in rows):
        raise ValueError("table.rows 必须为非空等列数数组")
    table = slide.shapes.add_table(len(rows), len(rows[0]), *[Pt(element[k]) for k in ("x", "y", "w", "h")]).table
    table.first_row = table.horz_banding = False
    if widths := element.get("column_widths"):
        if len(widths) != len(rows[0]) or abs(sum(widths) - element["w"]) > 0.1:
            raise ValueError("column_widths必须与表格列数及总宽度一致")
        for col, width in zip(table.columns, widths, strict=True):
            col.width = Pt(width)
    if heights := element.get("row_heights"):
        if len(heights) != len(rows) or abs(sum(heights) - element["h"]) > 0.1:
            raise ValueError("row_heights必须与表格行数及总高度一致")
        for row, height in zip(table.rows, heights, strict=True):
            row.height = Pt(height)
    for i, row in enumerate(rows):
        for j, value in enumerate(row):
            cell = table.cell(i, j)
            value = {"text": value} if isinstance(value, str) else value
            fill = value.get("fill", element.get("fill", "FFFFFF"))
            cell.fill.solid()
            cell.fill.fore_color.rgb = rgb(fill)
            borders = value.get("borders", element.get("borders"))
            if borders is not None:
                from pptx.oxml.xmlchemy import OxmlElement
                props = cell._tc.get_or_add_tcPr()
                for position, (edge, tag) in enumerate({"left": "lnL", "right": "lnR", "top": "lnT", "bottom": "lnB"}.items()):
                    for old in list(props.findall("a:" + tag, props.nsmap)):
                        props.remove(old)
                    border = borders.get(edge)
                    line = OxmlElement("a:" + tag)
                    if border:
                        line.set("w", str(int(border.get("width", 1) * 12700)))
                        fill_node = OxmlElement("a:solidFill")
                        color_node = OxmlElement("a:srgbClr")
                        color_node.set("val", border.get("color", "CBD5E1").lstrip("#").upper())
                        fill_node.append(color_node)
                        line.append(fill_node)
                    else:
                        line.append(OxmlElement("a:noFill"))
                    # CT_TableCellProperties requires borders before fill elements.
                    props.insert(position, line)
            _text(cell, {**value, "style": {"align": "left", "valign": "middle", "margin": 5,
                                          **element.get("style", {}), **value.get("style", {})}})


def _chart(slide, element):
    types = {"column": XL_CHART_TYPE.COLUMN_CLUSTERED, "bar": XL_CHART_TYPE.BAR_CLUSTERED,
             "line": XL_CHART_TYPE.LINE, "pie": XL_CHART_TYPE.PIE, "doughnut": XL_CHART_TYPE.DOUGHNUT}
    data = CategoryChartData()
    data.categories = element["categories"]
    for series in element["series"]:
        if len(series["values"]) != len(element["categories"]):
            raise ValueError("图表系列数量必须与categories一致")
        data.add_series(series["name"], series["values"])
    chart = slide.shapes.add_chart(types[element.get("chart", "column")],
                                  *[Pt(element[k]) for k in ("x", "y", "w", "h")], data).chart
    chart.font.name = element.get("style", {}).get("font", "Microsoft YaHei")
    chart.font.size = Pt(element.get("style", {}).get("size", 14))
    chart.has_legend = element.get("legend", len(element["series"]) > 1)
    for series, definition in zip(chart.series, element["series"], strict=True):
        if color := definition.get("color"):
            if element.get("chart") == "line":
                series.format.line.color.rgb = rgb(color)
            else:
                series.format.fill.solid()
                series.format.fill.fore_color.rgb = rgb(color)


def _line(slide, element):
    add_route(slide, element["points"], color=element.get("color", "145A8C"),
              width=element.get("width", 1.5), arrow=element.get("arrow", True))


def _image(slide, element):
    path = Path(element["path"])
    if not path.is_file():
        raise FileNotFoundError(f"图片尚未下载或路径不正确：{path}")
    from PIL import Image
    with Image.open(path) as image:
        iw, ih = image.size
    x, y, w, h = [element[k] for k in ("x", "y", "w", "h")]
    fit = element.get("fit", "contain")
    if fit == "contain":
        scale = min(w / iw, h / ih)
        actual_w, actual_h = iw * scale, ih * scale
        slide.shapes.add_picture(str(path), Pt(x + (w-actual_w)/2), Pt(y + (h-actual_h)/2), Pt(actual_w), Pt(actual_h))
    elif fit == "cover":
        shape = slide.shapes.add_picture(str(path), Pt(x), Pt(y), Pt(w), Pt(h))
        scale = max(w / iw, h / ih)
        shape.crop_left = shape.crop_right = (1 - w / (iw * scale)) / 2
        shape.crop_top = shape.crop_bottom = (1 - h / (ih * scale)) / 2
    else:
        raise ValueError("image.fit使用contain或cover，不拉伸照片")


HANDLERS = {"shape": _box, "text": _box, "table": _table, "chart": _chart, "line": _line, "image": _image}
FIELDS = {"type", "x", "y", "w", "h", "shape", "fill", "line", "line_width", "text", "style", "runs",
          "paragraphs", "rows", "column_widths", "row_heights", "categories", "series", "chart", "legend",
          "points", "color", "width", "arrow", "path", "fit", "borders"}


def build_pages(prs, source: Path, *, edit_pages: list[int] | None = None) -> dict:
    document = json.loads(source.read_text(encoding="utf-8"))
    if not document.get("pages"):
        raise ValueError("页面JSON需要非空pages数组")
    canvas = document.get("canvas", {})
    width, height = Pt(canvas.get("width", 960)), Pt(canvas.get("height", 540))
    if edit_pages is not None:
        if (len(document["pages"]) != len(prs.slides) or not edit_pages
                or any(i < 0 or i >= len(prs.slides) for i in edit_pages)):
            raise ValueError("局部JSON须保留原页数并提供有效edit_pages")
        if (width, height) != (prs.slide_width, prs.slide_height):
            raise ValueError("局部JSON不能改变全稿画布尺寸")
    else:
        prs.slide_width, prs.slide_height = width, height
    required = list(document.get("required_text", []))
    for number, page in enumerate(document["pages"], 1):
        if edit_pages is not None:
            if number-1 not in edit_pages:
                continue
            slide = prs.slides[number-1]
            for shape in list(slide.shapes):
                slide.shapes._spTree.remove(shape._element)
        else:
            slide = prs.slides.add_slide(prs.slide_layouts[6])
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = rgb(page.get("background", "FFFFFF"))
        for index, element in enumerate(page["elements"], 1):
            kind = element.get("type")
            if kind not in HANDLERS:
                raise ValueError(f"第{number}页第{index}个对象type={kind!r}不支持；使用{list(HANDLERS)}")
            if unknown := set(element)-FIELDS:
                raise ValueError(f"第{number}页第{index}个对象未知字段{sorted(unknown)}；文字格式统一放style")
            try:
                HANDLERS[kind](slide, element)
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"第{number}页第{index}个{kind}对象：{exc}") from exc
        # Source transcription is independent of the layout. Do not silently
        # rewrite it to match generated text or look on other slides for a match.
        expected = page.get("source_text", [])
        if not isinstance(expected, list) or any(not isinstance(t, str) for t in expected):
            raise ValueError(f"第{number}页source_text须为原文字符串数组")
        actual = "\n".join(shape.text if shape.has_text_frame else "\n".join(c.text for row in shape.table.rows for c in row.cells)
                           if shape.has_table else "" for shape in slide.shapes)
        normalize = lambda text: re.sub(r"\s+", "", text)
        if missing := [t for t, count in Counter(expected).items() if normalize(actual).count(normalize(t)) < count]:
            raise ValueError(f"第{number}页遗漏或改写原文{missing[:8]}；修布局元素，不要改source_text")
    references = [page.get("source_image", "") for page in document["pages"]]
    return {"required_text": required, "page_data": str(source), "reference_images": references}
