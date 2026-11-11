"""Submit one page through existing SDK batch tools, without changing the engine."""

from __future__ import annotations

import json
import logging
import math
import time
from collections import Counter
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import httpx

from .native_ppt_runtime import NativeRuntime as TencentPptRuntime
from .tencent_ppt_state import A, P, NativePptState, digest

BATCHES = {"shapes": "slide_add_shapes", "texts": "slide_add_texts", "lines": "slide_add_line_shapes"}
SCHEMAS = Path(__file__).parent.parent / "tencent_ppt_skill/tool-definitions.slide.json"
logger = logging.getLogger(__name__)


def load_page(source: Path) -> dict[str, list[dict[str, Any]]]:
    """Validate the small page envelope against the shipped native item schemas."""
    page = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(page, dict) or set(page) - BATCHES.keys():
        raise ValueError("页面JSON只接受shapes、texts、lines；字段和坐标沿用SDK，单位为pt")
    schemas = {tool["name"]: tool["inputSchema"] for tool in json.loads(SCHEMAS.read_text(encoding="utf-8"))["tools"]}
    for group, tool in BATCHES.items():
        items = page.get(group, [])
        if not isinstance(items, list):
            raise ValueError(f"{group}必须为数组")
        schema = schemas[tool]["properties"][group]["items"]
        for item in items:
            if (not isinstance(item, dict) or set(item) - schema["properties"].keys()
                    or set(schema["required"]) - item.keys()):
                raise ValueError(f"{group}对象字段不符合{tool}原生参数；请只修当前页面JSON")
            for name, value in item.items():
                kind = schema["properties"][name]["type"]
                valid = (isinstance(value, str) if kind == "string" else
                         isinstance(value, int) and not isinstance(value, bool) if kind == "integer" else
                         isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))
                if not valid:
                    raise ValueError(f"{group}.{name}类型应为{kind}，数字必须有限")
            if group != "lines" and (item["w"] <= 0 or item["h"] <= 0):
                raise ValueError(f"{group}的w/h必须大于0")
            if group == "lines" and item.get("line_type", "line") not in {"line", "arrow", "doubleArrow"}:
                raise ValueError("line_type只接受line、arrow、doubleArrow")
    if not any(page.values()):
        raise ValueError("页面不能全空")
    return page


def _signature(info: dict[str, Any]) -> str:
    # SDK version is document-wide, so another page's edit must not invalidate this page.
    return digest(json.dumps({"page_id": info["page_id"], "shapes": info["shapes"]}, sort_keys=True).encode())


def _check_bounds(page: dict[str, Any], width: float, height: float) -> None:
    for group, items in page.items():
        for item in items:
            points = [(item["x1"], item["y1"]), (item["x2"], item["y2"])] if group == "lines" else [
                (item["x"], item["y"]), (item["x"]+item["w"], item["y"]+item["h"]),
            ]
            if any(x < 0 or y < 0 or x > width or y > height for x, y in points):
                raise ValueError(f"{group}坐标超出当前页{width}×{height}pt；尚未修改页面")


def write_editable_page(
    engine: TencentPptRuntime, path: Path, source: Path, state: NativePptState, page_index: int | None,
) -> dict[str, Any]:
    """Save and check one owned page; repeat submissions replace it, never append again.

    Existing/imported pages are not overwritten by this new action. Direct SDK editing
    remains available for those pages. An externally changed page requires an explicit
    edit rather than silently erasing changes made outside this batch.
    """
    page = load_page(source)
    source_hash = digest(json.dumps(page, sort_keys=True).encode())
    file_id = engine.open(path)

    def call(tool: str, **arguments: Any) -> dict[str, Any]:
        start = time.monotonic()
        ok = False
        try:
            result = engine.rpc(tool, {"file_id": file_id, **arguments})
            ok = True
            return result
        finally:
            logger.info("[tencent-ppt-page] tool=%s page_index=%s ok=%s seconds=%.4f",
                        tool, arguments.get("page_index"), ok, time.monotonic()-start)

    info = call("slide_get_info")
    _check_bounds(page, info["w_pt"], info["h_pt"])
    entries = state.data.setdefault("editable_pages", {})
    key = str(source.resolve()).casefold()
    entry = entries.get(key)
    if entry:
        if not entry.get("page_id"):
            raise ValueError("上次新增页面未确认完成；保留工作稿，请只核查对应页，不自动新增重复页")
        # Native IDs may be re-created when the SDK imports the saved PPTX.
        # Rebind only a clean reopened document with the exact saved page content.
        previous_index = entry["page_index"]
        saved = state.pages()
        if (entry.get("file_id") != file_id and not info["is_dirty"]
                and previous_index < len(saved) and entry.get("saved_xml") == saved[previous_index]):
            reopened = call("slide_get_page_info", page_index=previous_index)
            entry.update(page_id=reopened["page_id"], signature=_signature(reopened), file_id=file_id)
            state._save()
        if entry["page_id"] not in info["slide_ids"]:
            raise ValueError("此源文件对应的页面已移走或删除；请明确处理原页面，不自动新增重复页")
        index = info["slide_ids"].index(entry["page_id"])
        if page_index is not None and page_index != index:
            raise ValueError(f"此源文件已对应page_index={index}；修复时请复用该下标")
        current = call("slide_get_page_info", page_index=index)
        if entry.get("signature") != _signature(current):
            raise ValueError(f"第{index+1}页已在本批次之外修改或上次执行被中断；保留现状，请只检查并修复此页，不自动覆盖")
        if entry.get("source_hash") == source_hash and entry.get("saved_xml") == state.pages()[index]:
            return {"ok": True, "reused": True, "page_index": index, "check_kind": "sdk_structure", "diagnostics": []}
    else:
        index = info["slide_count"]
        if page_index is not None and page_index != index:
            raise ValueError(f"此操作只追加或替换自己创建的页面；下一新页page_index={index}，不覆盖既有页面")
        state.begin_edit()
        state.edited(saved=False)
        entry = {"page_id": None, "page_index": index, "pending": True, "file_id": file_id}
        entries[key] = entry
        state._save()
        call("slide_add_slide")
        current = call("slide_get_page_info", page_index=index)
        entry.update(page_id=current["page_id"], signature=_signature(current))
    state.begin_edit()
    state.edited(saved=False)
    entry["signature"] = None  # A process crash must not authorize an uncertain overwrite.
    entry.update(pending=True, page_index=index)
    state._save()
    phase = "write"
    try:
        ids = [shape["id"] for shape in current["shapes"]]
        if ids:
            call("slide_remove_shapes", page_index=index, shape_ids=ids)
        for group, tool in BATCHES.items():
            if items := page.get(group):
                result = call(tool, page_index=index, **{group: items})
                if result.get("count") != len(items):
                    raise RuntimeError(f"{tool}未写齐本页对象")
        current = call("slide_get_page_info", page_index=index)
        phase = "save"
        call("save_file", file_path=str(path))
        state.edited(saved=True)
        phase = "check"
        xml = ET.fromstring(state._page_xml()[index])
        expected = Counter(item.get("text", "").replace("\r", "").replace("\n", "") for item in page.get("texts", []))
        actual = Counter("".join(node.text or "" for node in body.iter(A+"t")).replace("\r", "").replace("\n", "")
                         for body in xml.iter(P+"txBody"))
        arrow_count = sum(item.get("line_type") in {"arrow", "doubleArrow"} for item in page.get("lines", []))
        arrow_count += sum(item.get("line_type") == "doubleArrow" for item in page.get("lines", []))
        arrows = [node for tag in ["headEnd", "tailEnd"] for node in xml.iter(A+tag) if node.get("type") not in {None, "none"}]
        diagnostics = []
        if (any(text and actual[text] < count for text, count in expected.items())
                or xml.find(".//"+P+"pic") is not None or len(arrows) != arrow_count):
            diagnostics.append({"ruleId": "editable-page-content", "severity": "error", "page_index": index,
                                "message": f"第{index+1}页保存后的文字、箭头数不符或出现图片对象；只修本页"})
        else:
            diagnostics = state.check_saved_layout(indices={index})
        ok = not diagnostics
        entry.update(signature=_signature(current), pending=not ok, source_hash=source_hash if ok else None,
                     saved_xml=state.pages()[index] if ok else None)
        state._save()
        return {"ok": ok, "page_index": index, "write_ok": True, "check_kind": "sdk_structure",
                "failed_phase": None if ok else "check", "diagnostics": diagnostics}
    except (OSError, RuntimeError, ValueError, TimeoutError, httpx.HTTPError) as exc:
        if not isinstance(exc, (TimeoutError, httpx.TimeoutException)):
            # A returned SDK error may leave partial objects. Remember their exact
            # state so the next explicit submission can replace this owned page.
            # A timed-out call has unknown completion and must not authorize that.
            try:
                current = call("slide_get_page_info", page_index=index)
                entry["signature"] = _signature(current)
                state._save()
            except (OSError, RuntimeError, ValueError, TimeoutError, httpx.HTTPError):
                pass  # Keep the pending receipt; never turn recovery failure into success.
        raise RuntimeError(f"第{index+1}页{phase}未完成；已保留工作稿，不自动重试或追加新页。请只检查此页。{exc}") from exc
