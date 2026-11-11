"""Batch the existing native write/check contract, retaining per-page receipts."""
from pathlib import Path

from .tencent_ppt_state import NativePptState, digest


def write_pages(presentation, params):
    if not params.dsl_files or len(params.dsl_files) > 4 or len(set(params.dsl_files)) != len(params.dsl_files):
        raise ValueError("write-pages一次传1至4个不同dsl_files，按展示顺序；每页仍写入并lint")
    path = presentation._working_path(params.file_path)
    files = [presentation._path(value, field="dsl_files", suffix=".slide") for value in params.dsl_files]
    for source in files:
        if not source.is_file():
            raise FileNotFoundError(f"页面源文件不存在：{source}")
    completed = []
    for source in files:
        state = NativePptState(path)
        entry = next(((int(i), p) for i, p in state.data["pages"].items() if p["dsl"] == str(source)), None)
        index = entry[0] if entry else None
        pages = state.pages()
        if index is not None and index >= len(pages):
            return {"ok": False, "completed": completed, "failed_source": str(source), "page_index": index,
                    "next": "原页号已不存在；核对当前稿件页序后恢复该页，不能将替换静默改成追加。"}
        if entry and entry[1]["checked"] and entry[1]["digest"] == digest(source.read_bytes()) and entry[1]["xml"] == pages[index]:
            completed.append({"dsl_file": str(source), "page_index": index, "reused": True})
            continue
        result = presentation._execute(params.model_copy(update={"action": "write-page", "dsl_file": str(source), "page_index": index}))
        if not result.get("ok"):
            return {**result, "completed": completed, "failed_source": str(source),
                    "next": "只改失败页源文件后重试本批；已通过且未改动的页自动复用，不重复追加。"}
        completed.append({"dsl_file": str(source), "page_index": result["page_index"], "checked": True})
    return {"ok": True, "working_file": str(path), "completed": completed,
            "presentation": NativePptState(path).summary(), "next": "继续下一批已准备的页面；计划页数完成后finalize。"}
