"""Hermes bridge to the supplied native PPT engine and material worker."""
from __future__ import annotations
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import time
import zipfile
from typing import Any, Literal
from xml.etree import ElementTree as ET

import httpx

from pydantic import BaseModel, Field
from . import native_ppt_runtime
from .tencent_ppt_state import NativePptState
from .native_ppt_events import context, emit

logger = logging.getLogger(__name__)
SKILL_DIR = Path(__file__).with_name("native_ppt_skill")
SKILL_NAME = "pptx--pptx"

class TencentPptInput(BaseModel):
    """Original CLI operations and a scoped MCP editing bridge."""

    action: Literal["prepare", "prepare-material", "fetch-assets", "material-info", "build-material", "preview-material", "review-preview", "review-material", "create", "write-page", "write-pages", "write-editable-page", "upsert-dsl", "lint", "validate", "inspect", "schema", "mcp", "finalize"]
    file_path: str = Field(default="", description="当前 outputs 内的 PPTX 路径。建稿后原样使用 create 返回的 working_file。")
    dsl_file: str = Field(default="", description="write-page/upsert-dsl/lint/validate：当前 outputs 内已写好的 .slide。优先使用 Write 返回的绝对路径。")
    dsl_files: list[str] = Field(default_factory=list, description="write-pages：仅明确批量请求/对照实验，1至4个独立.slide；串行写入并检查，失败即停。默认用write-page。")
    source_files: list[str] = Field(default_factory=list, description="prepare-material：本次上传材料的实际本地路径，提取原文与原图，不做OCR。")
    images: list[dict[str, str]] = Field(default_factory=list, description="fetch-assets：1至8条已搜到的原图，每项url、source_page、title。")
    crops: list[dict[str, Any]] = Field(default_factory=list, description="prepare-material：局部疑点放大，source为源文件下标，box为原图像素[left,top,right,bottom]。")
    page_file: str = Field(default="", description="build-material：精确材料重建/带编辑数据图表的自由pages JSON，格式由material-info返回，不限固定模板。write-editable-page沿用原SDK JSON。坐标pt。")
    script_file: str = Field(default="", description="build-material：outputs内的Python脚本，定义build(prs)，已内置python-pptx与辅助函数。")
    expected_pages: int | None = Field(default=None, ge=1, description="build-material：用户要求的总页数，保存前核验。")
    edit_pages: list[int] | None = Field(default=None, description="build-material：局部修改的从0开始页号，打开现有稿并拒绝改其它页；新建不传。")
    review_version: str = Field(default="", description="review-material/finalize：实际核对过的材料稿预览版本。")
    review_pages: list[int] | None = Field(default=None, description="review-preview：宿主指定的本批页下标，最多4页。")
    reviewed_pages: list[int] = Field(default_factory=list, description="review-material/finalize：本版本已看预览并确认的页号，从0开始。")
    review_issues: dict[int, str] = Field(default_factory=dict, description="review-material：确认有缺陷的页下标及具体位置和问题。")
    unconfirmed_pages: dict[int, str] = Field(default_factory=dict, description="review-material：无法确认的页下标及原因，结束本轮核对。")
    purpose: Literal["deliverable", "internal"] = Field(default="deliverable", description="create/build-material：用户工作稿或内部试验稿；内部稿不展示、不允许最终交付。")
    out: str = Field(default="", description="inspect：outputs 内的新 Markdown 文件或空目录路径。")
    page_index: int | None = Field(default=None, ge=0, description="从0开始。追加新页不传；替换和lint传当前页下标。")
    tool_name: str = Field(default="", description="schema/mcp：原生 slide_* 工具名；mcp 也支持 save_file。")
    arguments: dict[str, Any] = Field(default_factory=dict, description="mcp原生参数；fetch-assets传images:[{url,source_page,title}]，并行下载已搜到的原图。prepare-material可传crops。")


def installed(home):
    from . import store

    entry = store.load_index(home).get("plugins", {}).get("pptx", {})
    return "-native." in str(entry.get("version", ""))


def enabled():
    from hermes_constants import get_hermes_home
    from . import store

    entry = store.load_index(get_hermes_home()).get("plugins", {}).get("pptx", {})
    return installed(get_hermes_home()) and entry.get("enabled", True) and native_ppt_runtime.available()


class NativePresentation:
    def __init__(self, output: Path, runtime, publish=None):
        self.output = output.resolve()
        self.engine = runtime
        self.publish = publish or publish_local

    def execute(self, args):
        params = TencentPptInput.model_validate(args)
        started = time.monotonic()
        try:
            return self._execute(params)
        finally:
            emit("operation", action=params.action, seconds=round(time.monotonic()-started, 3))

    def _resolve_candidate(self, path: Path, suffix: str | None) -> Path:
        path = path.resolve()
        # New root-level PPT names use a same-named project; existing files keep their paths.
        if suffix == ".pptx" and path.parent == self.output and not path.exists():
            return (path.parent / path.stem / path.name).resolve()
        return path

    def _path(self, value: str, *, field: str, suffix: str | None = None) -> Path:
        # Git Bash represents Windows drive paths as /c/..., while Python expects C:/....
        if self.output.drive and re.match(r"^/[a-zA-Z]/", value):
            value = f"{value[1]}:{value[2:]}"
        reference = Path(value)
        path = self._resolve_candidate(self.output / reference, suffix)
        # A leading outputs prefix may be task-relative or part of a legacy project path.
        if (
            not reference.anchor
            and len(reference.parts) > 1
            and reference.parts[0].casefold() == self.output.name.casefold()
            and path.is_relative_to(self.output)
        ):
            task_path = self._resolve_candidate(self.output.joinpath(*reference.parts[1:]), suffix)
            if not path.exists():
                path = task_path
            elif task_path != path and task_path.is_relative_to(self.output) and task_path.exists():
                raise ValueError(f"{field} 路径有歧义，同时匹配 {task_path} 和 {path}；请使用工具返回的绝对路径")
        if not path.is_relative_to(self.output) or path == self.output:
            raise ValueError(f"{field} 必须位于当前任务 outputs 内；请使用工作稿或页面源文件的实际路径")
        if suffix and path.suffix.lower() != suffix:
            raise ValueError(f"{field} 的文件后缀必须为 {suffix}")
        return path

    def _working_path(self, value: str, *, existing: bool = True) -> Path:
        path = self._path(value, field="file_path", suffix=".pptx")
        if existing and not path.is_file():
            raise FileNotFoundError(f"file_path 对应的 PPT尚未创建：{path}；已建稿时请用 create 返回的 working_file 继续原稿")
        return path

    def _execute(self, params: TencentPptInput) -> dict[str, Any]:
        self.output.mkdir(parents=True, exist_ok=True)
        if params.action == "prepare-material":
            from .ppt_source import prepare_sources
            return prepare_sources(self.output, params.source_files, params.crops or params.arguments.get("crops", []))
        if params.action == "fetch-assets":
            from .ppt_fetch_assets import fetch_assets
            return fetch_assets(self.output, params.images or params.arguments.get("images", []))
        if params.action == "write-pages":
            from .ppt_write_batch import write_pages
            return write_pages(self, params)
        if params.action == "material-info":
            # An interface lookup must not start/provision a Python environment.
            # The actual build imports the required library in its managed worker.
            guide = Path(__file__).parent / "native_ppt_support/material-generation.md"
            public = self.output / ".ppt-material/ppt_material_helpers.py"
            public.parent.mkdir(exist_ok=True)
            packaged_source = Path(__file__).parent / "native_ppt_support/ppt_material_helpers.py"
            source = packaged_source if packaged_source.is_file() else Path(__file__).parent / "ppt_material_helpers.py"
            public.write_bytes(source.read_bytes())
            pages_guide = Path(__file__).parent / "native_ppt_support/page-data.md"
            return {"ok": True, "output_dir": str(self.output), "python_pptx_requirement": "==1.0.2",
                    "dependency_verification": "Actual import is performed by build-material, not by this interface lookup.",
                    "helper_reference": str(public),
                    "guide": pages_guide.read_text(encoding="utf-8"),
                    "script_guide": str(guide),
                    "next": "精确重建或带编辑数据图表可写自由pages JSON；对象无法表达时才读script_guide用build(prs)脚本。普通主题/报告提炼返回DSL逐页write-page，不因页数多改走材料路线。"
                            "脚本仍自由设计每页构图，不限模板，最终仍须结构检查和实际预览核对。"
                            "辅助模块由build-material子进程注入，系统Python中找不到它不表示能力缺失；"
                            "无需查环境、找源码、create空稿、pip安装或SDK对齐查询。参考源码已在helper_reference，确有需要才读取。"}
        if params.action == "schema":
            if params.tool_name == "write-editable-page":
                return {"units": "pt（不是px），页面默认960×540，沿用实际页面大小", "page_file": "项目/slides/01.page.json",
                        "example": {
                            "shapes": [{"x": 80, "y": 120, "w": 180, "h": 70, "shape_type": "roundRect", "fill_color": "E8F2FA"}],
                            "texts": [{"x": 100, "y": 140, "w": 140, "h": 30, "text": "真实身份注册",
                                       "font_size": 18, "font_name": "Microsoft YaHei"}],
                            "lines": [{"x1": 260, "y1": 155, "x2": 350, "y2": 155, "line_type": "arrow", "color": "145A8C"}],
                        }, "flow": "Write页面JSON→write-editable-page→下一页；修复同一源文件，重复提交复用原页",
                        "limits": "原生形状/文字/直线箭头；折线用连续线段且仅末段带箭头，不是单个可编辑折线路径，也不自动吸附节点。"
                                  "返回的是SDK结构检查，不是DSL lint或视觉检查。"}
            tools = json.loads((SKILL_DIR / "tool-definitions.slide.json").read_text(encoding="utf-8"))["tools"]
            if not params.tool_name:
                return {"tools": [t["name"] for t in tools]}
            match = next((t for t in tools if t["name"] == params.tool_name), None)
            if match is None:
                raise ValueError(f"未知PPT工具：{params.tool_name}")
            return match
        if params.action == "prepare":
            self.engine.start()
            return {"ok": True, "output_dir": str(self.output), "skill_dir": str(SKILL_DIR),
                    "flow": "普通主题/报告提炼沿用WorkBuddy v20261013的DSL逐页write-page，读完本页诊断并修复后制作下一页，最后finalize；材料重建先prepare-material→material-info→build-material→实际预览核对；已有稿少量修改用SDK。"}
        if params.action == "review-preview":
            from .ppt_material import review_preview_batch

            path = self._working_path(params.file_path)
            state = NativePptState(path)
            result, _ = review_preview_batch(state, params.review_pages)
            return {**result, "previews": [item["review_image"] for item in result["review_batch"]]}
        if params.action == "write-page":
            written = self._execute(params.model_copy(update={"action": "upsert-dsl"}))
            if not written.get("ok"):
                return {**written, "failed_phase": written.get("failed_phase", "write")}
            index = params.page_index if params.page_index is not None else written["presentation"]["written_pages"] - 1
            try:
                checked = self._execute(params.model_copy(update={
                    "action": "lint", "file_path": written["working_file"], "dsl_file": written["dsl_file"], "page_index": index,
                }))
            except (OSError, RuntimeError, ValueError, TimeoutError, httpx.HTTPError, zipfile.BadZipFile, ET.ParseError) as exc:
                raise RuntimeError(f"第{index + 1}页已写入，但检查未完成；重试时使用page_index={index}，不要追加新页。{exc}") from exc
            return {**checked, "page_index": index, "write_ok": True,
                    "failed_phase": None if checked.get("ok") else "check"}
        path = self._working_path(params.file_path, existing=params.action not in {"create", "build-material"})
        snapshot = path.is_relative_to(self.output / "deliveries")
        read_only = params.action in {"inspect", "lint", "validate"} or (
            params.action == "mcp" and params.tool_name.startswith(("slide_get_", "slide_list_"))
        )
        if snapshot and not read_only:
            raise ValueError("最终交付版本不覆盖；请修改工作稿后重新finalize")
        state = NativePptState(path)
        working = {"working_file": str(path), "project_dir": str(path.parent),
                   "assets_dir": str(path.parent / "assets"), "slides_dir": str(path.parent / "slides")}
        if params.action == "build-material":
            from .ppt_material import build_material
            if bool(params.page_file) == bool(params.script_file):
                raise ValueError("build-material传page_file或script_file其中一个，不同时传")
            source = self._path(params.page_file, field="page_file", suffix=".json") if params.page_file else self._path(params.script_file, field="script_file", suffix=".py")
            result = build_material(self.engine, path, source, state,
                                          expected_pages=params.expected_pages, edit_pages=params.edit_pages, purpose=params.purpose)
            if result.get("diagnostics") or state.summary().get("purpose") == "internal":
                return {**result, **working, "presentation": state.summary()}
            review = None
            if result.get("pending_review") and not result.get("preview_error"):
                from .ppt_material import review_preview_batch
                review, _ = review_preview_batch(state)
            if state.data.get("material_build", {}).get("require_visual_review") and result.get("pending_review"):
                return {**result, **working, "review_batch": review, "presentation": state.summary(),
                        "review_previews": [item["review_image"] for item in review["review_batch"]] if review else [],
                        "review_contact_sheet": review.get('contact_sheet') if review else None,
                        "next": "工作稿已保存，尚未最终交付。用现有视觉工具核对返回previews与原材料；"
                                "review-material提交本批结果。只修具体缺陷的页，确认完后finalize。"
                                "预览失败只重试preview-material，不重新识别或构建。"}
            final = self._execute(params.model_copy(update={"action": "finalize", "file_path": str(path)}))
            return {**result, **final, **working, "review_batch": review,
                    "visual_notice": "预览已生成，尚未逐页视觉确认" if result.get("pending_review") else None}
        if params.action == "review-material":
            from .ppt_material import confirm_review

            confirm_review(state, params.review_version, params.reviewed_pages,
                           issues=params.review_issues, unconfirmed=params.unconfirmed_pages)
            material = state.data["material_build"]
            if (not material["pending_review"] and not material.get("review_issues")
                    and not material.get("unconfirmed_pages") and state.summary()["purpose"] != "internal"):
                final = self._execute(params.model_copy(update={"action": "finalize", "review_version": "", "reviewed_pages": []}))
                return {**final, **working, "auto_finalized": True,
                        "next": "全部页面已核对且最终交付成功；向用户简要说明结果，不再重复发布附件。"}
            return {"ok": True, **working, "presentation": state.summary(),
                    "next": "有具体问题只修对应页；剩余未看页用preview-material；全部确认后finalize。不要重复检查未改页。"}
        if params.action == "preview-material":
            from .ppt_material import preview_material, review_preview_batch

            result = preview_material(self.engine, state)
            if result.get("pending_review") and not result.get("diagnostics") and not result.get("preview_error"):
                review, _ = review_preview_batch(state)
                return {**result, **working, "presentation": state.summary(), "review_batch": review,
                        "review_previews": [item["review_image"] for item in review["review_batch"]],
                        "review_contact_sheet": review.get("contact_sheet"),
                        "next": "读取review_previews核对本版本（有原图时为SOURCE/SAVED对照）；review-material提交本批结论，最后一批通过后自动交付。"}
            return {**result, **working, "presentation": state.summary()}
        if params.action == "write-editable-page":
            from .tencent_ppt_editable_page import write_editable_page

            source = self._path(params.page_file, field="page_file", suffix=".json")
            result = write_editable_page(self.engine, path, source, state, params.page_index)
            return {**result, **working, "presentation": state.summary()}
        if params.action == "create" and path.is_file() and state.receipt.exists():
            return {"ok": True, "reused": True, **working, "presentation": state.summary()}
        if params.action == "finalize":
            if state.summary()["status"] == "final":
                return {"ok": True, "already_published": True, "presentation": state.summary()}
            if params.review_version:
                from .ppt_material import confirm_review
                confirm_review(state, params.review_version, params.reviewed_pages)
            presentation = state.finalize(self.output)
            # Hermes persists this tool result and its local file through its own gateway.
            delivery = self.publish(presentation)
            state.published()
            return {"ok": True, "presentation": presentation, "delivery": delivery}
        if params.action == "mcp":
            if not params.tool_name.startswith("slide_") and params.tool_name != "save_file":
                raise ValueError("mcp仅提供当前PPT的slide_*和save_file；打开和file_id由宿主管理")
            arguments = {**params.arguments, "file_id": self.engine.open(path)}
            if params.tool_name == "save_file":
                arguments["file_path"] = str(path)
            elif not params.tool_name.startswith(("slide_get_", "slide_list_")):
                state.begin_edit()
            result = self.engine.rpc(params.tool_name, arguments)
            if params.tool_name == "save_file":
                state.edited(saved=True)
            elif not params.tool_name.startswith(("slide_get_", "slide_list_")):
                state.edited(saved=False)
            return result if snapshot else {**result, "presentation": state.summary()}
        if params.action == "create":
            if path.exists():
                raise ValueError("文件已存在；请使用现有文件继续写页，或为新稿指定新路径")
            path.parent.mkdir(parents=True, exist_ok=True)
        args = [params.action, str(path)]
        if params.action == "inspect":
            if not params.out:
                raise ValueError("inspect需要指定新的out路径")
            args += ["--out", str(self._path(params.out, field="out"))]
        if params.action in {"upsert-dsl", "lint", "validate"}:
            dsl = self._path(params.dsl_file, field="dsl_file", suffix=".slide")
            if not dsl.is_file():
                raise FileNotFoundError(f"dsl_file 对应的页面源文件不存在：{dsl}；请使用 Write 实际保存的路径")
            working["dsl_file"] = str(dsl)
            args += ["--dsl-file", str(dsl)]
            if params.page_index is not None:
                args += ["--page-index", str(params.page_index)]
            if params.action == "lint" and params.page_index is None:
                raise ValueError("lint需要已写入PPT的page_index")
            if params.action in {"upsert-dsl", "lint"} and params.page_index is not None:
                if params.page_index >= len(state.pages()):
                    raise ValueError("page_index超出当前页数；替换必须使用已有页号，追加新页请不传page_index")
        if params.action in {"upsert-dsl", "lint", "inspect"}:
            self.engine.open(path)
        result = self.engine.cli(args, path.parent)
        if snapshot:
            return result
        if result.get("ok"):
            if params.action == "create":
                state.created(purpose=params.purpose)
            elif params.action == "upsert-dsl":
                state.wrote(dsl, params.page_index)
                if result.get("failures"):
                    # Native upsert can save a page while failing to load its images.
                    return {**result, "ok": False, "write_ok": True, "failed_phase": "resources",
                            "page_index": params.page_index if params.page_index is not None else len(state.pages()) - 1,
                            **working, "presentation": state.summary(),
                            "next": "页面已写入但资源失败；修复failures对应素材后替换同一page_index，不追加新页。"}
            elif params.action == "lint":
                state.checked(dsl, params.page_index, True)
        elif params.action == "lint":
            state.checked(dsl, params.page_index, False)
        return {**result, **working, "presentation": state.summary()}


def publish_local(receipt):
    from . import store
    from hermes_constants import get_hermes_home

    path = Path(receipt["file_path"])
    if receipt.get("purpose") == "internal" or receipt.get("written_pages", 0) <= 0 or not path.is_file():
        raise ValueError("交付文件尚不可用")
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("交付文件损坏")
    # Durable output receipt precedes the successful tool result. Failure propagates.
    target = store.imported_root(get_hermes_home()) / ".native-ppt/deliveries" / (receipt["version"] + ".json")
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps({**receipt, **context.get()}, ensure_ascii=False), encoding="utf-8")
    temp.replace(target)
    emit("delivery_confirmed", version=receipt["version"], file=str(path))
    return "MEDIA:" + str(path)


def handle(args, task_id="", session_id="", turn_id="", **_):
    from agent.runtime_cwd import scoped_session_cwd
    from hermes_constants import get_hermes_home
    from tools.terminal_tool import _get_env_config, get_session_cwd
    from . import turns

    started = time.monotonic()
    turn_id = turn_id or turns.current(session_id).turn_id
    token = context.set({"session_id": session_id, "turn_id": turn_id})
    try:
        if not enabled():
            raise ValueError("此档案未启用原生PPT，或应用运行时尚未部署")
        config = _get_env_config()
        if config.get("env_type") != "local":
            raise ValueError("此原生PPT运行时只支持本地执行")
        cwd = scoped_session_cwd() or get_session_cwd(task_id)
        if cwd:
            output = Path(cwd) / "outputs"
        else:
            if not session_id:
                raise ValueError("缺少会话工作目录，先初始化本会话terminal")
            output = get_hermes_home() / "native-ppt/workspaces" / re.sub(r"[^A-Za-z0-9_-]", "_", session_id) / "outputs"
        runtime = native_ppt_runtime.engine()
        if args.get("action") in {"prepare-material", "fetch-assets"}:
            # File extraction and HTTP downloads never touch the editor SDK.
            result = NativePresentation(output, runtime).execute(args)
        else:
            with runtime.lock:
                result = NativePresentation(output, runtime).execute(args)
        return json.dumps(result, ensure_ascii=False)
    except (OSError, RuntimeError, ValueError, TimeoutError, subprocess.SubprocessError, zipfile.BadZipFile, ET.ParseError, native_ppt_runtime.httpx.HTTPError) as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    finally:
        context.reset(token)
        logger.info("[native-ppt] action=%s seconds=%.3f", args.get("action"), time.monotonic() - started)


SCHEMA = {
    "name": "TencentPpt",
    "description": "PPT套件工具。先skill_view(pptx--pptx)。普通主题/报告提炼默认使用原生DSL逐页write-page；write-pages仅用于明确批量请求或对照实验；材料重建或带编辑数据的图表使用material-info/build-material并核对预览，上传材料先prepare-material。fetch-assets批量取原图及核对总览，局部修改用SDK。沿用返回路径，不重做已完成步骤。",
    "parameters": TencentPptInput.model_json_schema(),
}


def register(ctx):
    ctx.register_tool("TencentPpt", "uniwork_native_ppt", SCHEMA, handle,
                      check_fn=enabled, description="原生PPT制作", emoji="📊")
