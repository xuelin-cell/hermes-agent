"""DOCX → 逐页 PNG，用于视觉复检。会自动挑选当前机器上可用的后端。

    python scripts/render_docx.py out/report.docx --output_dir tmp/pages
    python scripts/render_docx.py out/report.docx --backend quicklook   # 指定后端

后端优先级（保真度从高到低）：

  word       本机 Microsoft Word 自动化（macOS AppleScript / Windows COM）。最高保真，
             需要装 Word。
  soffice    LibreOffice --convert-to pdf。跨三平台、有真实分页，装一次就好：
             macOS `brew install --cask libreoffice`；Debian `apt-get install libreoffice`。
  quicklook  macOS 自带 QuickLook（`qlmanage`），**零安装**。字体、配色、表格样式都真实，
             但**不分页**——整篇连成一张长图，看不了分页、页码、跨页表头。

PDF → PNG 优先用 PyMuPDF（`pip install pymupdf`，纯 wheel，无系统依赖），
没有再用 pdf2image + Poppler。所以只要装了 PyMuPDF，Poppler 不是必需品。

一个后端都没有时退出码 2，按 SKILL.md 的兜底路径走（check_docx.py + 文本核对 + 明确告知用户）。
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from glob import glob
from os import makedirs, remove, replace
from os.path import abspath, basename, dirname, exists, expanduser, join, splitext
from pathlib import Path
from shutil import which
from zipfile import ZipFile

# Windows 控制台默认 GBK，编不出的字符会让 print 抛 UnicodeEncodeError 中断脚本。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")

TWIPS_PER_INCH = 1440

SOFFICE_CANDIDATES = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice", "/usr/bin/soffice",
    "/snap/bin/libreoffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]
PDFTOPPM_CANDIDATES = [
    "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm", "/usr/bin/pdftoppm",
    r"C:\Program Files\poppler\bin\pdftoppm.exe",
    r"C:\Program Files\poppler\Library\bin\pdftoppm.exe",
]
WORD_MAC = "/Applications/Microsoft Word.app"

INSTALL_HINT = """\
装其中任意一个即可获得**带分页**的渲染：
  LibreOffice  macOS: brew install --cask libreoffice
               Debian: sudo apt-get install -y libreoffice
               Windows: winget install TheDocumentFoundation.LibreOffice
  PyMuPDF      pip install pymupdf     （PDF→PNG，纯 pip，可替代 Poppler）
环境变量可直接指定：SOFFICE_BIN=/path/to/soffice  POPPLER_PATH=/path/to/poppler/bin"""


class MissingTool(RuntimeError):
    pass


# --- 后端探测 ---------------------------------------------------------------
def find_soffice():
    override = os.environ.get("SOFFICE_BIN")
    if override:
        return expanduser(override) if exists(expanduser(override)) else None
    return which("soffice") or which("soffice.exe") or next(
        (c for c in SOFFICE_CANDIDATES if exists(c)), None)


def find_word():
    if platform.system() == "Darwin":
        return WORD_MAC if exists(WORD_MAC) else None
    if platform.system() == "Windows":
        try:
            import winreg
            winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "Word.Application")
            return "Word.Application"
        except Exception:
            return None
    return None


def find_quicklook():
    return which("qlmanage") if platform.system() == "Darwin" else None


def available_backends():
    return {"word": find_word(), "soffice": find_soffice(), "quicklook": find_quicklook()}


def find_poppler_dir():
    if os.environ.get("POPPLER_PATH"):
        return expanduser(os.environ["POPPLER_PATH"])
    if which("pdftoppm") or which("pdftoppm.exe"):
        return None
    hit = next((c for c in PDFTOPPM_CANDIDATES if exists(c)), None)
    return dirname(hit) if hit else False        # False = 没有 Poppler


# --- PDF → PNG ---------------------------------------------------------------
def pdf_to_png(pdf_path, out_dir, max_w, max_h, dpi=None):
    """优先 PyMuPDF（无系统依赖），退回 pdf2image + Poppler。"""
    try:
        import fitz                                          # PyMuPDF
    except ImportError:
        fitz = None

    if fitz is not None:
        doc = fitz.open(pdf_path)
        pages = []
        for i, page in enumerate(doc, 1):
            rect = page.rect
            zoom = (dpi / 72.0 if dpi else
                    min(max_w / rect.width, max_h / rect.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            dst = join(out_dir, f"page-{i}.png")
            pix.save(dst)
            pages.append(dst)
        doc.close()
        return pages

    poppler = find_poppler_dir()
    if poppler is False:
        raise MissingTool(
            "PDF 已生成但转不成图片：既没有 PyMuPDF 也没有 Poppler。\n"
            "  pip install pymupdf   ← 推荐，纯 pip 无系统依赖")
    try:
        from pdf2image import convert_from_path
    except ImportError as exc:
        raise MissingTool("缺少 pdf2image：pip install pdf2image") from exc

    if dpi is None:
        from pdf2image import pdfinfo_from_path
        info = pdfinfo_from_path(pdf_path, poppler_path=poppler)
        m = re.search(r"([\d.]+)\s*x\s*([\d.]+)\s*pts", info.get("Page size", ""))
        dpi = round(min(max_w / (float(m.group(1)) / 72),
                        max_h / (float(m.group(2)) / 72))) if m else 150
    raw = convert_from_path(pdf_path, dpi=dpi, fmt="png", thread_count=4,
                            output_folder=out_dir, paths_only=True,
                            output_file="page", poppler_path=poppler)
    pages = []
    for src in raw:
        num = int(splitext(basename(src))[0].split("-")[-1])
        dst = join(out_dir, f"page-{num}.png")
        replace(src, dst)
        pages.append((num, dst))
    return [p for _, p in sorted(pages)]


# --- 各后端的 DOCX → PDF -----------------------------------------------------
def docx_to_pdf_soffice(soffice, doc_path, out_dir):
    def run(args):
        with tempfile.TemporaryDirectory(prefix="soffice_profile_") as prof:
            # Path.as_uri() 才是合法 file URL：Windows 上 "file://" + r"C:\..." 是无效的
            cmd = [soffice, f"-env:UserInstallation={Path(prof).absolute().as_uri()}",
                   "--invisible", "--headless", "--norestore"] + args
            subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, env=os.environ.copy(), timeout=300)

    stem = splitext(basename(doc_path))[0]
    pdf = join(out_dir, f"{stem}.pdf")
    run(["--convert-to", "pdf", "--outdir", out_dir, doc_path])
    if exists(pdf):
        return pdf
    run(["--convert-to", "odt", "--outdir", out_dir, doc_path])   # 兜底：先转 ODT
    odt = join(out_dir, f"{stem}.odt")
    if exists(odt):
        run(["--convert-to", "pdf", "--outdir", out_dir, odt])
    return pdf if exists(pdf) else ""


def docx_to_pdf_word(doc_path, out_dir):
    """用本机 Word 导出 PDF——保真度最高，因为排版就是 Word 自己算的。"""
    pdf = join(out_dir, splitext(basename(doc_path))[0] + ".pdf")
    if platform.system() == "Darwin":
        script = f'''
        set inFile to POSIX file "{doc_path}"
        set outFile to POSIX file "{pdf}"
        tell application "Microsoft Word"
            set wasRunning to running
            open inFile
            set activeDoc to active document
            save as activeDoc file name (outFile as string) file format format PDF
            close activeDoc saving no
            if not wasRunning then quit
        end tell'''
        subprocess.run(["osascript", "-e", script], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
    elif platform.system() == "Windows":
        ps = (f"$w=New-Object -ComObject Word.Application; $w.Visible=$false; "
              f"$d=$w.Documents.Open('{doc_path}'); "
              f"$d.SaveAs([ref]'{pdf}',[ref]17); $d.Close(); $w.Quit()")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
    return pdf if exists(pdf) else ""


def docx_via_quicklook(doc_path, out_dir, size=1600):
    """macOS QuickLook：零安装，但只出一张连续长图，没有分页。"""
    subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", out_dir, doc_path],
                   check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=120)
    src = join(out_dir, basename(doc_path) + ".png")
    if not exists(src):
        return []
    dst = join(out_dir, "preview-quicklook.png")
    replace(src, dst)
    return [dst]


# --- DPI 计算（给 soffice/word 路径用） --------------------------------------
def page_size_inches(docx_path):
    with ZipFile(docx_path) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    pg = root.find(".//w:sectPr/w:pgSz", ns)
    if pg is None:
        return None
    q = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    w, h = pg.get(q + "w"), pg.get(q + "h")
    return (int(w) / TWIPS_PER_INCH, int(h) / TWIPS_PER_INCH) if w and h else None


def clean_stale(out_dir):
    stale = glob(join(out_dir, "page-*.png")) + glob(join(out_dir, "preview-*.png"))
    for f in stale:
        remove(f)
    return len(stale)


def render(doc_path, out_dir, backend="auto", max_w=1600, max_h=2000, dpi=None):
    makedirs(out_dir, exist_ok=True)
    removed = clean_stale(out_dir)
    if removed:
        print(f"清理上一轮渲染的 {removed} 张图")

    avail = available_backends()
    order = [backend] if backend != "auto" else [b for b in ("word", "soffice", "quicklook")
                                                 if avail.get(b)]
    if not order:
        raise MissingTool("这台机器上没有任何可用的渲染后端。\n" + INSTALL_HINT)

    for name in order:
        target = avail.get(name)
        if not target:
            raise MissingTool(f"指定的后端 {name} 在这台机器上不可用。\n" + INSTALL_HINT)
        if name == "quicklook":
            pages = docx_via_quicklook(doc_path, out_dir, max_w)
            if pages:
                return name, pages
            continue
        with tempfile.TemporaryDirectory(prefix="docx_pdf_") as tmp:
            pdf = (docx_to_pdf_word(doc_path, tmp) if name == "word"
                   else docx_to_pdf_soffice(target, doc_path, tmp))
            if not pdf:
                print(f"后端 {name} 转 PDF 失败，尝试下一个……", file=sys.stderr)
                continue
            if dpi is None:
                sz = page_size_inches(doc_path)
                use_dpi = round(min(max_w / sz[0], max_h / sz[1])) if sz else None
            else:
                use_dpi = dpi
            return name, pdf_to_png(pdf, out_dir, max_w, max_h, use_dpi)
    raise MissingTool("所有可用后端都失败了。\n" + INSTALL_HINT)


def main():
    ap = argparse.ArgumentParser(description="把 DOCX 渲染成图片以做视觉复检")
    ap.add_argument("input_path", nargs="?")
    ap.add_argument("--output_dir", default=None)
    ap.add_argument("--backend", default="auto",
                    choices=["auto", "word", "soffice", "quicklook"])
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=2000)
    ap.add_argument("--dpi", type=int, default=None)
    ap.add_argument("--list-backends", action="store_true", help="只打印可用后端")
    args = ap.parse_args()

    if args.list_backends:
        for k, v in available_backends().items():
            print(f"{k:<10} {v or '-'}")
        try:
            import fitz  # noqa: F401
            print("pdf→png   PyMuPDF")
        except ImportError:
            p = find_poppler_dir()
            print(f"pdf→png   {'Poppler ' + (p or '(PATH)') if p is not False else '-（pip install pymupdf）'}")
        return

    if not args.input_path:
        ap.error("需要指定 DOCX 路径（或用 --list-backends 只看可用后端）")
    input_path = abspath(expanduser(args.input_path))
    if not exists(input_path):
        print(f"错误：文件不存在 {input_path}", file=sys.stderr)
        raise SystemExit(2)
    out_dir = (abspath(expanduser(args.output_dir)) if args.output_dir
               else splitext(input_path)[0])

    try:
        backend, pages = render(input_path, out_dir, args.backend,
                                args.width, args.height, args.dpi)
    except MissingTool as exc:
        print(f"错误：{exc}", file=sys.stderr)
        print("\n拿不到渲染页时：仍然要跑 check_docx.py（只依赖 python-docx），"
              "用文本抽取兜底核对，并**明确告知用户版式未经渲染验证**。不要假装看过。",
              file=sys.stderr)
        raise SystemExit(2)
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)

    print(f"后端 {backend}：渲染 {len(pages)} 张 → {out_dir}")
    for p in pages:
        print("  " + p)
    if backend == "quicklook":
        print("\n注意：QuickLook 不分页，这是整篇连续预览。字体、配色、表格样式可信，"
              "\n分页、页码、跨页表头、封面独占一页都**看不到**——这些要装 LibreOffice 才能验。")
    print("\n接下来：逐张看图（版式、留白、对齐、溢出），再跑 check_docx.py。")


if __name__ == "__main__":
    main()
