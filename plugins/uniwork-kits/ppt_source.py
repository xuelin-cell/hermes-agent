"""Extract readable source content and original pictures once per task, without OCR."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import posixpath
import zipfile
from xml.etree import ElementTree as ET

from PIL import Image

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def prepare_sources(output: Path, inputs: list[str], crops: list[dict] | None = None) -> dict:
    if not inputs:
        raise ValueError("source_files 需要上传材料的实际路径")
    sources = [Path(p).expanduser().resolve() for p in inputs]
    for source in sources:
        if not source.is_file():
            raise FileNotFoundError(f"材料不存在：{source}")
    fingerprints = [(str(p), hashlib.sha256(p.read_bytes()).hexdigest()) for p in sources]
    crops = crops or []
    key = hashlib.sha256(json.dumps([fingerprints, crops], sort_keys=True).encode()).hexdigest()[:20]
    folder = output / ".ppt-sources" / key
    manifest = folder / "source.json"
    if manifest.is_file():
        result = json.loads(manifest.read_text(encoding="utf-8"))
        if all(Path(i["path"]).is_file() for s in result["sources"] for i in s["images"]):
            return {**result, "manifest_file": str(manifest), "reused": True}
    folder.mkdir(parents=True, exist_ok=True)
    result = {"sources": [], "recognition": "native_text_and_original_images; no OCR"}
    for number, (source, (_, fingerprint)) in enumerate(zip(sources, fingerprints, strict=True)):
        item = {"file": str(source), "sha256": fingerprint, "blocks": [], "images": []}

        def picture(data: bytes, suffix: str, identity: str):
            target = folder / f"source-{number + 1}-{identity}{suffix.lower()}"
            target.write_bytes(data)
            with Image.open(target) as image:
                sample = image.convert("RGB")
                sample.thumbnail((480, 480))
                colors = sorted(sample.getcolors(sample.width * sample.height), reverse=True)[:8]
                item["images"].append({"id": identity, "path": str(target), "width": image.width, "height": image.height,
                                       "dominant_colors": ["%02X%02X%02X" % color for count, color in colors]})

        suffix = source.suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}:
            picture(source.read_bytes(), suffix, "image-1")
        elif suffix in {".docx", ".pptx"}:
            with zipfile.ZipFile(source) as archive:
                if suffix == ".docx":
                    part = "word/document.xml"
                    root = ET.fromstring(archive.read(part))
                    for index, paragraph in enumerate(root.iter(W + "p")):
                        text = "".join(n.text or "" for n in paragraph.iter(W + "t"))
                        if text:
                            item["blocks"].append({"id": f"paragraph-{index + 1}", "text": text})
                    item["tables"] = [[["".join(n.text or "" for n in cell.iter(W + "t"))
                                        for cell in row.findall(W + "tc")] for row in table.findall(W + "tr")]
                                      for table in root.iter(W + "tbl")]
                    relationships = {n.attrib["Id"]: n for n in ET.fromstring(archive.read("word/_rels/document.xml.rels"))}
                    seen = set()
                    for node in root.iter(A + "blip"):
                        identity = node.get(R + "embed")
                        if not identity or identity in seen:
                            continue
                        seen.add(identity)
                        rel = relationships[identity]
                        if rel.get("TargetMode") == "External":
                            continue
                        target = rel.attrib["Target"]
                        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath("word/" + target)
                        if Path(target).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}:
                            picture(archive.read(target), Path(target).suffix, f"image-{len(item['images']) + 1}")
                else:
                    document = ET.fromstring(archive.read("ppt/presentation.xml"))
                    rels = {n.attrib["Id"]: n.attrib["Target"] for n in ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))}
                    p = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
                    for index, page in enumerate(document.findall(f"{p}sldIdLst/{p}sldId")):
                        target = rels[page.attrib[R + "id"]]
                        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath("ppt/" + target)
                        text = "\n".join(n.text or "" for n in ET.fromstring(archive.read(target)).iter(A + "t"))
                        item["blocks"].append({"id": f"page-{index + 1}", "text": text})
                    item["next"] = "已有PPT的图表、图片与样式保留原稿，用SDK理解或增量修改；这里的blocks只是原生文字。"
        elif suffix in {".txt", ".md", ".csv", ".tsv", ".json"}:
            item["blocks"].append({"id": "text", "text": source.read_text(encoding="utf-8-sig")})
        else:
            item["next"] = "此格式沿用现有文档读取工具提取；不要安装新的解析环境。"
        for crop_index, crop in enumerate(crops):
            if crop.get("source", 0) != number:
                continue
            with Image.open(source) as image:
                box = crop["box"]
                if len(box) != 4 or not (0 <= box[0] < box[2] <= image.width and 0 <= box[1] < box[3] <= image.height):
                    raise ValueError("crops.box须为原图范围内的[left,top,right,bottom]像素坐标")
                region = image.crop(box)
                region = region.resize((region.width * 2, region.height * 2), Image.Resampling.LANCZOS)
                target = folder / f"crop-{crop_index + 1}.png"
                region.save(target)
                item["images"].append({"id": f"crop-{crop_index + 1}", "path": str(target), "width": region.width,
                                       "height": region.height, "original_box": box})
        result["sources"].append(item)
    result["next"] = ("直接使用blocks中的原文；图片按images顺序读图，每页一次同时提取全文、框形、颜色和连线。"
                      "将原文记录与排版分开保存，不改写专业词、数字或比较符号。只有具体疑点才裁剪补查；"
                      "材料齐备后用material-info中的页面JSON构建，不再重解包、探测环境或研究绘图API。")
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**result, "manifest_file": str(manifest), "reused": False}
