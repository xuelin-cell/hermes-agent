"""Host execution, revisions and SDK previews for material reconstruction scripts."""

from __future__ import annotations

import base64
from collections import Counter
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import posixpath
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from xml.etree import ElementTree as ET

from PIL import Image, ImageChops, ImageDraw
import httpx

from .native_ppt_events import emit, file_ref, safe_text, get_log_context_fields
from .ppt_layout_guard import CHECK_VERSION
from .native_ppt_runtime import NativeRuntime as TencentPptRuntime
from .tencent_ppt_state import A, P, R, NativePptState, digest, slide_digest, ordered_relationships, relationship_bytes
from .office.file_lock import file_lock

logger = logging.getLogger(__name__)
_PREVIEW_ATTEMPTS_PER_TURN = 2


def _current_preview_failure(receipt: dict) -> dict:
    failure = receipt.get("preview_failure", {})
    return failure if failure.get("turn_id") == get_log_context_fields()["turn_id"] else {}


def page_fingerprints(path: Path) -> list[str]:
    """Include related charts/images/layouts when deciding which pages need review."""
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())

        def closure(part: str, seen: set[str], slide_part: str) -> list[bytes]:
            if part in seen or part not in names:
                return []
            seen.add(part)
            payload = archive.read(part)
            result = [part.encode()+b"\0"+(slide_digest(payload).encode() if part == slide_part else payload)]
            parent, filename = posixpath.split(part)
            relationships = f"{parent}/_rels/{filename}.rels"
            if relationships in names:
                relations = ordered_relationships(archive.read(relationships))
                result.append(relationship_bytes(relations))
                for rel in relations:
                    if rel.get("TargetMode") != "External":
                        target = rel.attrib["Target"]
                        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(parent+"/"+target)
                        result.extend(closure(target, seen, slide_part))
            return result

        document = ET.fromstring(archive.read("ppt/presentation.xml"))
        rels = {node.attrib["Id"]: node.attrib["Target"] for node in ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))}
        size = ET.tostring(document.find(P+"sldSz"))
        values = []
        for node in document.findall(f"{P}sldIdLst/{P}sldId"):
            target = rels[node.attrib[R+"id"]]
            part = target.lstrip("/") if target.startswith("/") else posixpath.normpath("ppt/"+target)
            values.append(digest(size+b"".join(closure(part, set(), part))))
        return values


def worker_environment() -> dict[str, str]:
    allowed = {"path", "systemroot", "windir", "temp", "tmp", "userprofile", "home", "appdata", "localappdata", "lang", "lc_all"}
    env = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONNOUSERSITE="1")
    return env


def material_python() -> Path:
    import pm
    from hermes_constants import get_hermes_home
    from .script_python import environment_root

    name = "uniwork-native-ppt"
    root = environment_root(get_hermes_home(), name)
    ready = pm.environment_python(name, root=root)
    if ready:
        return Path(ready)
    return Path(pm.ensure_environment(name, ["python-pptx==1.0.2", "Pillow>=11.3,<13"],
                root=root, explicit=True))


def _worker(script: Path, stage: Path, source: Path | None, *, edit_pages: list[int] | None = None) -> dict:
    args = [str(material_python()), str(Path(__file__).with_name("ppt_material_worker.py")),
            "--pages" if script.suffix == ".json" else "--script", str(script),
            "--output", str(stage/"candidate.pptx"), "--result", str(stage/"result.json")]
    if source:
        args += ["--input", str(source)]
    if edit_pages is not None:
        args += ["--edit-pages", ",".join(map(str, edit_pages))]
    started = time.monotonic()
    # Logs survive a timeout and do not depend on inherited pipe handles closing.
    try:
        with (stage/"worker.stdout.log").open("wb") as stdout, (stage/"worker.stderr.log").open("wb") as stderr:
            proc = subprocess.run(args, cwd=script.parent, env=worker_environment(), stdin=subprocess.DEVNULL,
                                  stdout=stdout, stderr=stderr, timeout=90,
                                  creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    finally:
        emit("material_worker", seconds=round(time.monotonic()-started, 3), stage=stage.name)
    if proc.returncode:
        raise RuntimeError("材料脚本生成失败，原稿未覆盖；只修脚本，不重新识别整稿。"+(stage/"worker.stderr.log").read_text(encoding="utf-8", errors="replace")[-3000:])
    return json.loads((stage/"result.json").read_text(encoding="utf-8"))


def _contact_sheet(files: list[Path], target: Path, indices: list[int]) -> None:
    sheet = Image.new("RGB", (1600, ((len(files)+1)//2)*480), "#D9DDE3")
    draw = ImageDraw.Draw(sheet)
    for i, (file, index) in enumerate(zip(files, indices, strict=True)):
        with Image.open(file) as source:
            source.thumbnail((790, 445))
            x, y = i % 2 * 800, i // 2 * 480
            sheet.paste(source, (x+5, y+28))
            draw.text((x+8, y+5), f"P{index+1}", fill="black")
    sheet.save(target)


def build_material(engine: TencentPptRuntime, path: Path, script: Path, state: NativePptState,
                         *, expected_pages: int | None, edit_pages: list[int] | None, purpose: str = "deliverable") -> dict:
    with file_lock(path):
        return _build_material(engine, path, script, state, expected_pages=expected_pages,
                               edit_pages=edit_pages, purpose=purpose)


def _build_material(engine: TencentPptRuntime, path: Path, script: Path, state: NativePptState,
                    *, expected_pages: int | None, edit_pages: list[int] | None, purpose: str) -> dict:
    """Build a candidate, keep the previous revision, then inspect only changed pages."""
    started = time.monotonic()
    receipt = state.data.get("material_build", {})
    source_fingerprint = None
    if script.suffix == ".json":
        document = json.loads(script.read_text(encoding="utf-8"))
        assets = [Path(e["path"]) for p in document.get("pages", []) for e in p.get("elements", []) if e.get("type") == "image"]
        assets += [Path(p["source_image"]) for p in document.get("pages", []) if p.get("source_image")]
        assets = [p if p.is_absolute() else script.parent / p for p in assets]
        source_fingerprint = digest(script.read_bytes() + b"".join(digest(p.read_bytes()).encode() for p in assets))
        if (receipt.get("source_fingerprint") == source_fingerprint and path.is_file()
                and receipt.get("file_digest") == digest(path.read_bytes())
                and (expected_pages is None or len(receipt["page_fingerprints"]) == expected_pages)):
            return {**preview_material(engine, state), "reused_saved_draft": True}
    if _current_preview_failure(receipt) and receipt.get("pending_review") and (
        edit_pages is None or any(str(i) not in receipt.get("previews", {}) for i in edit_pages)
    ):
        return {**preview_material(engine, state), "reused_saved_draft": True}
    path.parent.mkdir(parents=True, exist_ok=True)
    engine.release(path)
    previous_hash = digest(path.read_bytes()) if path.is_file() else None
    previous = page_fingerprints(path) if path.is_file() else []
    if any(entry.get("pending") for entry in state.data.get("editable_pages", {}).values()):
        raise ValueError("原SDK页面提交尚未完成；先只修当前缺项，不切工具覆盖未完成页面")
    if previous and edit_pages is None and receipt.get("file_digest") != previous_hash:
        raise ValueError("工作稿包含脚本之外的编辑；请用edit_pages限定局部修改，保留现有页面，不整稿重建")
    if edit_pages is not None and (not previous or not edit_pages or any(i < 0 or i >= len(previous) for i in edit_pages)):
        raise ValueError("edit_pages必须指向工作稿已有页面（从0开始）")
    stage = path.parent / ".material-build" / uuid.uuid4().hex[:12]
    stage.mkdir(parents=True)
    if previous_hash:
        shutil.copyfile(path, stage/"previous.pptx")
    source = stage/"previous.pptx" if edit_pages is not None else None
    generated = (_worker(script, stage, source, edit_pages=edit_pages)
                 if script.suffix == ".json" and edit_pages is not None else _worker(script, stage, source))
    candidate = stage/"candidate.pptx"
    next_pages = page_fingerprints(candidate)
    if not next_pages or expected_pages is not None and len(next_pages) != expected_pages:
        raise ValueError(f"生成页数{len(next_pages)}与要求{expected_pages}不符；原稿未覆盖，只修页面安排")
    changed = [i for i, value in enumerate(next_pages) if i >= len(previous) or value != previous[i]]
    if edit_pages is not None and (len(previous) != len(next_pages) or set(changed)-set(edit_pages)):
        raise ValueError("局部脚本改动了声明范围外的页面或页数；原稿未覆盖，只修指定页面")
    # SDK/user edits made since the last reviewed build also require review,
    # even when this script only touches another page.
    review_baseline = receipt.get("page_fingerprints", previous)
    changed = [i for i, value in enumerate(next_pages) if i >= len(review_baseline) or value != review_baseline[i]]
    required = generated.get("metadata", {}).get("required_text", [])
    references = generated.get("metadata", {}).get("reference_images", [])
    if references and (not isinstance(references, list) or len(references) != len(next_pages)
                       or any(not isinstance(p, str) or p and not Path(p).is_file() for p in references)):
        raise ValueError("reference_images须与页数对应，填写原始截图实际路径；纯创作页可填空字符串")
    if not isinstance(required, list) or any(not isinstance(t, str) for t in required):
        raise ValueError("build返回的required_text必须为原文字符串数组")
    xmls = NativePptState(candidate)._page_xml()
    actual = "\n".join("".join(n.text or "" for n in ET.fromstring(xml).iter(A+"t")) for xml in xmls)
    if missing := [text for text, count in Counter(required).items() if text and actual.count(text) < count]:
        raise ValueError(f"生成结果缺少要求保留的文字{missing[:5]}；原稿未覆盖，只修缺项")
    if path.is_file() != (previous_hash is not None) or path.is_file() and digest(path.read_bytes()) != previous_hash:
        raise ValueError("生成期间工作稿已变化；候选稿已保留，不覆盖最新修改")
    try:
        candidate.replace(path)
    except PermissionError as exc:
        raise PermissionError(f"工作稿被占用或无写入权限，原稿未覆盖，候选稿保留在{candidate}。"
                              "请释放该工作稿后重试同一路径，不改名另建或重新识别材料。") from exc
    state.data.pop("final_path", None)
    # Keep older SDK page ownership receipts. Unchanged pages can rebind after
    # reopening; changed ones must refuse stale overwrite rather than append.
    if not previous:
        state.created(purpose=state.data.get("purpose", purpose))
    state.edited(saved=False)
    state.edited(saved=True)
    pending = sorted(set(changed) | {i for i in receipt.get("pending_review", []) if i < len(next_pages)})
    state.data["material_build"] = {"file_digest": digest(path.read_bytes()), "page_fingerprints": next_pages,
                                    "source_fingerprint": source_fingerprint, "require_visual_review": True,
                                    "require_read_evidence": True,
                                    "script": str(script), "pending_review": pending,
                                    "changed_pages": changed,
                                    "reference_images": references,
                                    "reviewed_images": receipt.get("reviewed_images", {}),
                                    "revision": stage.name, "previous": str(stage/"previous.pptx") if previous_hash else None}
    state.data["material_build"]["previews"] = {
        str(i): image for i in pending if i not in changed
        if (image := receipt.get("previews", {}).get(str(i)))
    }
    state.data["material_build"]["comparison_previews"] = {
        str(i): image for i in changed
        if (image := receipt.get("previews", {}).get(str(i)))
    }
    state._save()
    result = preview_material(engine, state)
    logger.info("[ppt-material] pages=%d changed=%s ok=%s seconds=%.3f",
                len(next_pages), changed, result["ok"], time.monotonic()-started)
    return result


def preview_material(engine: TencentPptRuntime, state: NativePptState) -> dict:
    """Retry only missing SDK previews; never re-run the generator or OCR."""
    receipt = state.data.get("material_build")
    if not receipt:
        raise ValueError("当前文件不是材料脚本工作稿，不使用此预览操作")
    file_hash = digest(state.path.read_bytes())
    if receipt["file_digest"] != file_hash:
        # Saved SDK edits stay incremental: register the new changed pages and
        # invalidate only their images, instead of demanding a Python rebuild.
        current = page_fingerprints(state.path)
        baseline = receipt["page_fingerprints"]
        changed = [i for i, value in enumerate(current) if i >= len(baseline) or value != baseline[i]]
        pending = sorted(set(changed) | {i for i in receipt["pending_review"] if i < len(current)})
        previews = {str(i): image for i in pending if i not in changed
                    if (image := receipt.get("previews", {}).get(str(i)))}
        comparisons = {str(i): image for i in changed
                       if (image := receipt.get("previews", {}).get(str(i)))}
        receipt.update(file_digest=file_hash, page_fingerprints=current, revision=uuid.uuid4().hex[:12],
                       changed_pages=changed, pending_review=pending, previews=previews, comparison_previews=comparisons)
        receipt.pop("preview_failure", None)
        state._save()
    path = state.path
    stage = path.parent / ".material-build" / receipt["revision"]
    stage.mkdir(parents=True, exist_ok=True)
    pending = receipt["pending_review"]
    diagnostics = state.check_saved_layout(indices=set(pending))
    previews = []
    preview_indices = []
    failure = _current_preview_failure(receipt)
    attempts = failure.get("attempts", 0)
    preview_error = failure.get("error") if attempts >= _PREVIEW_ATTEMPTS_PER_TURN else None
    index = pending[0] if pending else None
    if not diagnostics:
        try:
            opened = False
            for index in pending[:4]:
                old_preview = receipt.get("previews", {}).get(str(index))
                if old_preview and Path(old_preview).is_file():
                    previews.append(Path(old_preview))
                    preview_indices.append(index)
                    continue
                if preview_error:
                    continue
                if not opened:
                    engine.release(path)
                    engine.open(path)
                    opened = True
                image = stage/f"page-{index+1:02}.png"
                engine.cli(["screenshot", str(path), "--page-index", str(index), "--out", str(image)], path.parent)
                if not image.is_file():
                    raise RuntimeError("截图工具没有生成图片")
                previews.append(image)
                preview_indices.append(index)
        except (OSError, RuntimeError, ValueError, TimeoutError, httpx.HTTPError) as exc:
            preview_error = safe_text(str(exc).strip() or type(exc).__name__)
            attempts += 1
            receipt["preview_failure"] = {"turn_id": get_log_context_fields()["turn_id"],
                                          "attempts": attempts, "error": preview_error}
            emit("material_preview_failed", file=file_ref(str(path)), page_index=index,
                 attempt=attempts, error=preview_error)
    if not preview_error and not diagnostics:
        receipt.pop("preview_failure", None)
    contacts = []
    same_render = []
    # SDK save may rewrite shared theme/layout XML. Keep that invalidation
    # conservative, but reuse a prior visual review only when the new render
    # is byte-for-byte identical to an image that was explicitly reviewed.
    reviewed_images = receipt.get("reviewed_images", {})
    for index, image in zip(preview_indices, previews, strict=True):
        if reviewed_images.get(str(index)) == digest(image.read_bytes()):
            same_render.append(index)
    pending = sorted(set(pending)-set(same_render))
    receipt["pending_review"] = pending
    review_pairs = [(i, image) for i, image in zip(preview_indices, previews, strict=True) if i in pending]
    # At most eight pages per overview keeps dense text from shrinking without bound.
    for offset in range(0, len(review_pairs), 8):
        target = stage/f"overview-{offset//8+1}.png"
        subset = review_pairs[offset:offset+8]
        _contact_sheet([image for _, image in subset], target, [i for i, _ in subset])
        contacts.append(str(target))
    state.data["material_build"]["previews"] = {str(i): str(image) for i, image in zip(preview_indices, previews, strict=True)}
    state._save()
    with zipfile.ZipFile(path) as archive:
        size = ET.fromstring(archive.read("ppt/presentation.xml")).find(P+"sldSz")
    width_pt, height_pt = int(size.attrib["cx"])/12700, int(size.attrib["cy"])/12700
    image_details = []
    for index, image in zip(preview_indices, previews, strict=True):
        with Image.open(image) as view:
            image_details.append({"page_index": index, "path": str(image), "width_px": view.width, "height_px": view.height,
                                  "pixels_per_pt_x": view.width/width_pt, "pixels_per_pt_y": view.height/height_pt})
    logger.info("[ppt-material-preview] pending=%s diagnostics=%d preview_ok=%s", pending, len(diagnostics), not preview_error)
    can_retry = bool(preview_error) and attempts < _PREVIEW_ATTEMPTS_PER_TURN
    next_step = (
        "宿主提供待核对页预览，每批只检查一次。用现有视觉工具看previews后，review-material提交结果；有真实问题只修相关页，完成后finalize。"
        if pending else "当前版本没有待视觉核对的页面，直接finalize。"
    )
    if diagnostics:
        next_step = "只修复结构诊断列出的页面，再检查，不重建整稿。"
    elif preview_error:
        next_step = "工作稿已保存但检查预览未生成；仅重试preview-material，不重新构建或交付未核对稿。"
    return {"ok": not diagnostics and not preview_error, "changed_pages": receipt["changed_pages"], "pending_review": pending, "diagnostics": diagnostics,
            "material_script": receipt.get("script"),
            "preview_error": preview_error, "overviews": contacts, "previews": [str(p) for p in previews],
            "preview_details": image_details,
            "review_version": receipt["revision"], "check_kind": "script_structure",
            "same_render_reused_pages": same_render,
            "retry_action": "preview-material" if can_retry else None,
            "preview_blocked": bool(preview_error) and not can_retry,
            "next": next_step}


def review_preview_batch(state: NativePptState, pages: list[int] | None = None) -> tuple[dict, tuple[dict, ...]]:
    """Send one batch of full previews or the changed region of each edited page."""
    receipt = state.data.get("material_build")
    if not receipt or receipt["file_digest"] != digest(state.path.read_bytes()):
        raise ValueError("预览与当前稿件不符，请调用preview-material更新改动页的预览")
    pending = receipt["pending_review"]
    pages = pending[:4] if pages is None else pages
    if not 1 <= len(pages) <= 4 or len(set(pages)) != len(pages) or set(pages) - set(pending):
        raise ValueError("review-preview只接受本版本待核对的1至4页")
    batch = []
    images = []
    for index in pages:
        key = str(index)
        preview = Path(receipt.get("previews", {}).get(key, ""))
        if not preview.is_file():
            raise ValueError(f"第{index+1}页缺少预览，请调用preview-material")
        with Image.open(preview) as source:
            image = source.convert("RGB")
        region = None
        old_preview = Path(receipt.get("comparison_previews", {}).get(key, ""))
        if old_preview.is_file():
            with Image.open(old_preview) as previous:
                if image.size == previous.size:
                    region = ImageChops.difference(image, previous.convert("RGB")).getbbox()
        if region:
            left, top, right, bottom = region
            # Include neighboring text and connectors so the change has context.
            region = (max(0, left-48), max(0, top-48), min(image.width, right+48), min(image.height, bottom+48))
            image = image.crop(region)
        references = receipt.get("reference_images", [])
        reference = references[index] if index < len(references) else ""
        if reference:
            # Keep the source at its own resolution and compare against the
            # actual saved render, not the model's earlier transcription.
            with Image.open(reference) as original:
                original = original.convert("RGB")
            with Image.open(preview) as rendered:
                rendered = rendered.convert("RGB")
                rendered = rendered.resize((original.width, round(rendered.height*original.width/rendered.width)), Image.Resampling.LANCZOS)
            image = Image.new("RGB", (original.width, original.height+rendered.height+48), "white")
            image.paste(original, (0, 20))
            image.paste(rendered, (0, original.height+48))
            draw = ImageDraw.Draw(image)
            draw.text((5, 3), "SOURCE", fill="black")
            draw.text((5, original.height+28), "SAVED PPT", fill="black")
            region = None
        review_file = preview.parent / f"review-{receipt['revision']}-{index+1}.png"
        image.save(review_file)
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        images.append({"type": "image", "data": base64.b64encode(buffer.getvalue()).decode("ascii"), "mimeType": "image/png"})
        batch.append({"page_index": index, "changed_region_px": region, "review_image": str(review_file), "reference_image": reference})
    receipt.setdefault("review_images", {}).update({str(item["page_index"]): item["review_image"] for item in batch})
    contact=None
    if len(batch)>1 and not any(item['reference_image'] for item in batch):
        from .ppt_contact_sheet import create
        target=Path(batch[0]['review_image']).parent/f"contact-{receipt['revision']}-{'-'.join(str(i) for i in pages)}.png"
        contact=create([(f'Page {item["page_index"]+1}',Path(item['review_image'])) for item in batch],target)
        receipt.setdefault('review_contacts',{})[contact]={'sha256':digest(target.read_bytes()),
            'pages':{str(item['page_index']):digest(Path(item['review_image']).read_bytes()) for item in batch}}
    state._save()
    return {
        "ok": True, "review_version": receipt["revision"], "review_batch": batch,
        "contact_sheet":contact,
        "next": "图片依次对应review_batch。对照原材料或本次修复的问题，只检查文字、遮挡与连接等实际缺陷。"
                "普通主题有contact_sheet时可一次读取整批逐页核对；图像重建仍逐页对比原图与成品。"
                "下一次调用必须用review-material一次提交本批每页的结果：通过页填reviewed_pages，"
                "确认有问题的页填review_issues（页下标到位置和具体问题），无法确认的页填unconfirmed_pages及原因。",
    }, tuple(images)


def confirm_review(state: NativePptState, revision: str, pages: list[int], *,
                   issues: dict[int, str] | None = None, unconfirmed: dict[int, str] | None = None) -> None:
    """Record explicit model visual review of exactly this saved content version."""
    receipt = state.data.get("material_build")
    if not receipt or receipt["revision"] != revision or receipt["file_digest"] != digest(state.path.read_bytes()):
        raise ValueError("预览核对版本与当前工作稿不符；只核对最新改动页，不沿用旧版确认")
    pending = set(receipt.get("pending_review", []))
    issues, unconfirmed = issues or {}, unconfirmed or {}
    reported = set(pages) | set(issues) | set(unconfirmed)
    if (set(pages) & set(issues) or set(pages) & set(unconfirmed) or set(issues) & set(unconfirmed)
            or any(not str(reason).strip() for reason in [*issues.values(), *unconfirmed.values()])):
        raise ValueError("同一页只能提交一种核对结论；问题和无法确认的页必须说明具体原因")
    if reported-pending:
        raise ValueError(f"本版本待核对页面为{sorted(pending)}，请仅确认其中已核对的页")
    hashes = state.pages()
    cache = state.data.get("layout_checks", {})
    if any(cache.get(hashes[i]) != CHECK_VERSION for i in pages):
        raise ValueError("改动页结构检查未通过；不能用视觉确认覆盖具体诊断")
    missing = [i+1 for i in pages if not Path(receipt.get("previews", {}).get(str(i), "")).is_file()]
    if missing:
        raise ValueError(f"第{missing}页缺少视觉核对截图，工作稿已保存；用preview-material恢复预览，不重建")
    from .ppt_visual_evidence import require_reads
    require_reads(receipt, pages)
    receipt.update(pending_review=sorted(pending-set(pages)), review_kind="model_visual")
    for key, incoming in (("review_issues", issues), ("unconfirmed_pages", unconfirmed)):
        saved = receipt.setdefault(key, {})
        for index in reported:
            saved.pop(str(index), None)
        saved.update({str(index): reason for index, reason in incoming.items()})
    approved = receipt.setdefault("reviewed_images", {})
    for index in pages:
        approved[str(index)] = digest(Path(receipt["previews"][str(index)]).read_bytes())
    state._save()
