"""Isolated script entry point using the app's matched python-pptx dependency."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import runpy
import sys

from pptx import Presentation
from pptx.util import Pt

import ppt_material_helpers


def main(argv: list[str] | None = None) -> int:
    """Execute build(prs) in this child process, then save only its candidate file."""
    parser = argparse.ArgumentParser()
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--script", type=Path)
    inputs.add_argument("--pages", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--edit-pages", help="Comma-separated page indices to replace in an existing JSON deck")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args(argv)
    sys.modules["ppt_material_helpers"] = ppt_material_helpers
    prs = Presentation(str(args.input)) if args.input else Presentation()
    if not args.input:
        prs.slide_width, prs.slide_height = Pt(960), Pt(540)
    if args.pages:
        from ppt_material_pages import build_pages
        edits = [int(i) for i in args.edit_pages.split(",")] if args.edit_pages is not None else None
        if edits is not None and not args.input:
            raise ValueError("局部JSON修改需要已有工作稿")
        metadata = build_pages(prs, args.pages, edit_pages=edits)
    else:
        module = runpy.run_path(str(args.script), run_name="material_build")
        if not callable(module.get("build")):
            raise ValueError("脚本必须定义build(prs)，不用自行保存、安装依赖或运行预览")
        metadata = module["build"](prs) or {}
    if not isinstance(metadata, dict):
        raise ValueError("build(prs)应返回dict或None")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(args.output))
    args.result.write_text(json.dumps({"pages": len(prs.slides), "metadata": metadata}, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
