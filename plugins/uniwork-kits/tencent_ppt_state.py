"""Receipts for native page writes/checks; no extra rendering or model review."""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ordered_relationships(data: bytes) -> ET.Element:
    root = ET.fromstring(data)
    root[:] = sorted(root, key=lambda node: tuple(sorted(node.attrib.items())))
    return root


def relationship_bytes(root: ET.Element) -> bytes:
    return ET.canonicalize(ET.tostring(root, encoding="unicode"), rewrite_prefixes=True).encode("utf-8")


def _import_defaults(slide: ET.Element) -> None:
    """Discard only observed SDK import metadata, in memory, never in the PPTX."""
    metadata = slide.find(f"{P}cSld/{P}spTree/{P}nvGrpSpPr/{P}cNvPr")
    if metadata is not None and re.match(r"^[\s\ufeff]*<Slide(?:\s|>)", metadata.get("descr", "")):
        metadata.attrib.pop("descr")
    for paragraph in slide.iter(A + "p"):
        if any(node.tag not in {A + "pPr", A + "endParaRPr"} for node in paragraph):
            continue
        for node in list(paragraph):
            if not node.attrib and not len(node) and not (node.text or "").strip():
                paragraph.remove(node)


def _xml_digest(slide: ET.Element) -> str:
    return digest(ET.canonicalize(ET.tostring(slide, encoding="unicode")).encode("utf-8"))


def _slide_digests(data: bytes) -> tuple[str, str, str]:
    """Hash slide content independently of SDK-assigned shape numbers.

    Renumber definitions and their connector/animation references together so
    a different connection still changes the signature. Never change the PPTX.
    """
    slide = ET.fromstring(data)
    shape_ids = {node.attrib["id"]: str(index) for index, node in enumerate(slide.iter(P + "cNvPr"))}
    generated_chart_names = [node for frame in slide.iter(P + "nvGraphicFramePr")
                             if (node := frame.find(P + "cNvPr")) is not None
                             and node.get("name", "").isdigit() and node.get("name") == node.get("id")]
    for node in slide.iter():
        if node.tag == P + "cNvPr" or node.tag in {A + "stCxn", A + "endCxn"}:
            attribute = "id"
        elif node.tag.startswith(P) and "spid" in node.attrib:
            attribute = "spid"
        else:
            continue
        value = node.get(attribute)
        if value in shape_ids:
            node.set(attribute, "shape-" + shape_ids[value])
    previous = _xml_digest(slide)
    for node in generated_chart_names:
        node.set("name", "auto-" + node.attrib["id"])
    version_three = _xml_digest(slide) if generated_chart_names else previous
    _import_defaults(slide)
    return previous, version_three, _xml_digest(slide)


def slide_digest(data: bytes) -> str:
    """Return the current content fingerprint without modifying the PPTX."""
    return _slide_digests(data)[2]


class NativePptState:
    """Remember only successful native operations for one working file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.receipt = path.parent / ".ppt-state" / (path.name + ".json")
        self.data: dict[str, Any] = json.loads(self.receipt.read_text(encoding="utf-8")) if self.receipt.exists() else {"pages": {}}
        if self.receipt.exists() and path.is_file():
            self._upgrade_receipt()

    def _page_xml(self) -> list[bytes]:
        """Read slide XML in presentation order, without image payloads."""
        with zipfile.ZipFile(self.path) as archive:
            document = ET.fromstring(archive.read("ppt/presentation.xml"))
            relationships = {node.attrib["Id"]: node.attrib["Target"]
                             for node in ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))}
            result = []
            for node in document.findall(f"{P}sldIdLst/{P}sldId"):
                target = relationships[node.attrib[R + "id"]]
                name = target.lstrip("/") if target.startswith("/") else posixpath.normpath("ppt/" + target)
                xml = archive.read(name)
                result.append(xml)
            return result

    def _page_digests(self, *, legacy_resources: bool = False) -> list[tuple[str, ...]]:
        with zipfile.ZipFile(self.path) as archive:
            names = set(archive.namelist())
            rels = {n.attrib['Id']: n.attrib['Target'] for n in ET.fromstring(archive.read('ppt/_rels/presentation.xml.rels'))}
            document = ET.fromstring(archive.read('ppt/presentation.xml'))
            size_node = document.find(P + 'sldSz')
            size = ET.tostring(size_node) if size_node is not None else b''

            def dependencies(part, seen, ordered):
                if part in seen or part not in names:
                    return b''
                seen.add(part)
                parent, name = posixpath.split(part)
                relationship = parent + '/_rels/' + name + '.rels'
                result = archive.read(part)
                if ordered and part.endswith('.rels'):
                    result = relationship_bytes(ordered_relationships(result))
                if relationship in names:
                    data = archive.read(relationship)
                    relations = ordered_relationships(data) if ordered else ET.fromstring(data)
                    result += relationship_bytes(relations) if ordered else data
                    for rel in relations:
                        if rel.get('TargetMode') != 'External':
                            target = rel.attrib['Target']
                            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath(parent + '/' + target)
                            result += dependencies(target, seen, ordered)
                return result

            result = []
            for node, xml in zip(document.findall(f'{P}sldIdLst/{P}sldId'), self._page_xml(), strict=True):
                target = rels[node.attrib[R+'id']]
                part = target.lstrip('/') if target.startswith('/') else posixpath.normpath('ppt/' + target)
                parent, name = posixpath.split(part)
                dependency = parent + '/_rels/' + name + '.rels'
                def resources(ordered):
                    value = dependencies(dependency, {part}, ordered)
                    # Relationship targets resolve relative to their owning slide.
                    if dependency in names:
                        data = archive.read(dependency)
                        for rel in ordered_relationships(data) if ordered else ET.fromstring(data):
                            if rel.get('TargetMode') != 'External':
                                t = rel.attrib['Target']
                                value += dependencies(t.lstrip('/') if t.startswith('/') else posixpath.normpath(parent+'/'+t), {part}, ordered)
                    return value
                old = (digest(xml), *_slide_digests(xml))
                previous = digest(old[-1].encode()+size+resources(False)) if legacy_resources else ''
                result.append((*old, previous, digest(old[-1].encode()+size+resources(True))))
            return result

    def pages(self) -> list[str]:
        """Return content hashes that survive native shape renumbering."""
        return [entry[-1] for entry in self._page_digests()]

    def _upgrade_receipt(self) -> None:
        """Upgrade matching legacy receipts; never assume a stale receipt passed."""
        legacy = {i: page for i, page in self.data["pages"].items() if page.get("xml_version") != 6}
        saved = self.data.get("edit_saved")
        old_saved = saved is not None and self.data.get("edit_saved_version") != 6
        if not legacy and not old_saved:
            return
        xmls = self._page_xml()
        hashes = self._page_digests(legacy_resources=True)
        changed = False
        for index, page in legacy.items():
            i = int(index)
            version = page.get("xml_version", 1)
            if i >= len(hashes):
                continue
            matches = page["xml"] == hashes[i][version - 1]
            if not matches and version in {2, 3}:
                # Recover old signatures only with an unchanged source AND an
                # exact match of the old hash after reversing import defaults.
                dsl = Path(page["dsl"])
                if dsl.is_file():
                    source = dsl.read_bytes()
                    if digest(source) == page["digest"]:
                        slide = ET.fromstring(xmls[i])
                        _import_defaults(slide)
                        metadata = slide.find(f"{P}cSld/{P}spTree/{P}nvGrpSpPr/{P}cNvPr")
                        if metadata is not None and "descr" not in metadata.attrib:
                            metadata.set("descr", source.decode("utf-8"))
                            matches = page["xml"] == _slide_digests(ET.tostring(slide))[version - 2]
            if matches:
                slide = ET.fromstring(xmls[i])
                has_media = any(node.tag in {P + "pic", P + "graphicFrame"} for node in slide.iter())
                page.update(xml=hashes[i][-1], xml_version=6,
                            checked=page.get("checked", False) and (version >= 5 or not has_media))
                changed = True
        saved_version = self.data.get("edit_saved_version", 1) - 1
        if old_saved and saved == [entry[saved_version] for entry in hashes]:
            self.data.update(edit_saved=[entry[-1] for entry in hashes], edit_saved_version=6)
            changed = True
        if changed:
            self._save()

    def _save(self) -> None:
        self.receipt.parent.mkdir(exist_ok=True)
        temporary = self.receipt.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        for attempt in range(3):
            try:
                temporary.replace(self.receipt)
                break
            except PermissionError as exc:
                # Windows scanners/readers can briefly deny replacing this small
                # receipt. Keep the old file intact and bound the delay to 75ms.
                if getattr(exc, "winerror", None) not in {5, 32} or attempt == 2:
                    raise
                time.sleep(0.025 * (attempt + 1))

    def created(self, purpose: str | None = None) -> None:
        """Register a new empty working file so repeated create calls reuse it."""
        self.data.update(origin="created", edit_baseline=[])
        if purpose is not None:
            self.data["purpose"] = purpose
        self._save()

    def begin_edit(self) -> None:
        """Baseline an imported deck before its first MCP mutation, never afterwards."""
        if "edit_baseline" not in self.data:
            self.data.update(origin="existing", edit_baseline=self.pages())
            self._save()

    def wrote(self, dsl: Path, index: int | None) -> None:
        pages = self.pages()
        index = len(pages) - 1 if index is None else index
        self.data["pages"][str(index)] = {"xml": pages[index], "xml_version": 6, "dsl": str(dsl),
                                          "digest": digest(dsl.read_bytes()), "checked": False}
        self.data.pop("edit_saved", None)
        self.data.pop("final_path", None)
        self._save()

    def checked(self, dsl: Path, index: int, ok: bool) -> None:
        page = self.data["pages"].get(str(index))
        if not ok:
            if page is not None:
                page["checked"] = False
                self._save()
            return
        pages = self.pages()
        matches = bool(page and page["dsl"] == str(dsl) and page["digest"] == digest(dsl.read_bytes())
                       and index < len(pages) and page["xml"] == pages[index])
        if page is not None:
            page["checked"] = matches
            self._save()
        if not matches:
            raise ValueError(f"第{index + 1}页原生lint通过，但源文件与已写入版本或旧版回执不匹配。"
                             f"请仅重新upsert-dsl写入第{index + 1}页后再lint；重复lint不能修复版本不匹配，无需复检其他页。")

    def edited(self, saved: bool) -> None:
        if saved and not self.data.get("edit_dirty"):
            return
        # Keep matching native receipts; a change invalidates only its own hash.
        self.data["edit_saved"] = self.pages() if saved else None
        self.data["edit_saved_version"] = 6
        self.data["edit_dirty"] = not saved
        self.data.pop("final_path", None)
        self._save()

    def check_saved_layout(self, *, indices: set[int] | None = None, include_linted: bool = False) -> list[dict[str, object]]:
        """Check saved geometry, including exported text bounds after DSL lint."""
        from .ppt_layout_guard import CHECK_VERSION, EMU_PER_PX, check_page

        pages = self.pages()
        saved_edits = self.data.get("edit_saved") == pages
        if not saved_edits and not include_linted:
            return []
        baseline = self.data.get("edit_baseline", [])
        checked = set(self.summary()["checked_indices"])
        cache = self.data.setdefault("layout_checks", {})
        pending = [i for i, value in enumerate(pages) if (indices is None or i in indices)
                   and cache.get(value) != CHECK_VERSION
                   and (include_linted and i in checked or saved_edits and i not in checked
                        and (i >= len(baseline) or baseline[i] != value))]
        if not pending:
            return []
        with zipfile.ZipFile(self.path) as archive:
            size = ET.fromstring(archive.read("ppt/presentation.xml")).find(P + "sldSz")
        if size is None:
            raise ValueError("PPT缺少页面尺寸，无法完成交付结构检查")
        xmls = self._page_xml()
        issues = []
        for i in pending:
            diagnostics = check_page(xmls[i], int(size.attrib["cx"])/EMU_PER_PX, int(size.attrib["cy"])/EMU_PER_PX, i)
            if i in checked:
                # Native lint covers intentional layering. Its source-space
                # check does not prove the exported text fits the canvas.
                diagnostics = [d for d in diagnostics if d["ruleId"] == "slide-bounds"]
            issues.extend(diagnostics)
            if not diagnostics:
                cache[pages[i]] = CHECK_VERSION
        self._save()
        return issues

    def summary(self) -> dict[str, Any]:
        from .ppt_layout_guard import CHECK_VERSION

        pages = self.pages()
        checked = []
        pending_indices = {entry["page_index"] for entry in self.data.get("editable_pages", {}).values() if entry.get("pending")}
        for index, xml in enumerate(pages):
            page = self.data["pages"].get(str(index))
            if page and page["checked"] and page["xml"] == xml:
                dsl = Path(page["dsl"])
                if dsl.is_file() and digest(dsl.read_bytes()) == page["digest"]:
                    checked.append(index)
        stat = self.path.stat()
        final = self.data.get("final_path") if self.data.get("published") else None
        # A changed working file cannot inherit an earlier final receipt.
        if (self.data.get("final_revision") != f"{stat.st_mtime_ns}-{stat.st_size}"
                or (len(checked) != len(pages) and self.data.get("edit_saved") != pages)):
            final = None
        return {"source_path": str(self.path), "file_path": final or str(self.path), "status": "final" if final else "draft",
                "purpose": self.data.get("purpose", "deliverable"),
                "written_pages": len(pages), "checked_pages": len(checked), "checked_indices": checked,
                "structural_checked_pages": sum(i not in checked and i not in pending_indices
                                                and self.data.get("layout_checks", {}).get(xml) == CHECK_VERSION
                                                for i, xml in enumerate(pages)),
                "has_unsaved_changes": bool(self.data.get("edit_dirty")),
                "visual_pending_pages": self.data.get("material_build", {}).get("pending_review", []),
                "visual_issues": self.data.get("material_build", {}).get("review_issues", {}),
                "visual_unconfirmed_pages": self.data.get("material_build", {}).get("unconfirmed_pages", {}),
                "edit_saved": self.data.get("edit_saved") == pages,
                "version": self.data.get("final_version") if final else f"{stat.st_mtime_ns}-{stat.st_size}"}

    def finalize(self, output: Path) -> dict[str, Any]:
        """Publish a separate copy after structural checks; visual results are advisory."""
        summary = self.summary()
        if summary["purpose"] == "internal":
            raise ValueError("内部试验文件不作为交付物；请只交付用户工作稿")
        if summary["status"] == "final":
            return summary
        if summary["has_unsaved_changes"]:
            raise ValueError("尚不能最终交付：SDK中有未保存修改，请仅save_file后再交付，不重建整稿")
        pending = [str(entry["page_index"]+1) for entry in self.data.get("editable_pages", {}).values() if entry.get("pending")]
        if pending:
            raise ValueError("尚不能最终交付：可编辑页面提交或检查未完成，第" + "、".join(pending) + "页；只修对应页")
        if material := self.data.get("material_build"):
            if material.get("file_digest") != digest(self.path.read_bytes()):
                raise ValueError("材料工作稿已变化，旧版预览确认失效；调用preview-material只检查改动页，再确认交付，不重建整稿")
            if material.get("require_visual_review") and (material.get("pending_review") or material.get("review_issues") or material.get("unconfirmed_pages")):
                raise ValueError("材料稿尚有未确认或有缺陷的页，不能宣称最终交付；只核对待看页并修具体缺陷，review-material确认后再finalize")
        count = summary["written_pages"]
        if count == 0:
            raise ValueError("当前演示文稿没有页面")
        if not summary["edit_saved"] and summary["checked_pages"] != count:
            missing = [str(i + 1) for i in range(count) if i not in summary["checked_indices"]]
            raise ValueError("尚不能最终交付：第" + "、".join(missing) + "页未通过当前版本的原生lint")
        issues = self.check_saved_layout(include_linted=True)
        if issues:
            raise ValueError("尚不能最终交付，保存后页面结构检查未通过：\n"
                             + "\n".join(str(item["message"]) for item in issues[:8])
                             + "\n只修复所列页面和对象，保存后再次finalize；无需重新识别材料、重建整稿或复检未改页。")
        version = uuid.uuid4().hex[:12]
        target = output / "deliveries" / version / self.path.name
        target.parent.mkdir(parents=True)
        from .ppt_compat import delivery_copy
        compatibility = delivery_copy(self.path, target)
        self.data.update(final_path=str(target), final_version=version, final_revision=summary["version"], published=False)
        self._save()
        return {**summary, "status": "final", "file_path": str(target), "version": version,
                "compatibility": compatibility}

    def published(self) -> None:
        self.data["published"] = True
        self._save()
