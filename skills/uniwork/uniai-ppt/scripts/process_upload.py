# -*- coding: utf-8 -*-
"""process_upload.py —— 用户上传素材的**本地**解析（不依赖任何云端 MCP）。

设计目标
    1. 文字、表格、图片的提取**全部在本地完成**，不调 MCP。
    2. 只有"看图才能懂"的那几张才交给视觉 MCP —— 脚本把它们单独挑出来放进
       ``manifest.json`` 的 ``needs_vision``，其余一律不打扰 MCP。
    3. 抽图前先去重 + 过滤装饰件。一份 30 页的 PDF，页眉 logo 会被抽出 30 份，
       全送识图既慢又白花钱；实测这是识图请求量的主要来源。

依赖（都是"没有也能跑"，不会因为缺包整个失败）
    PyMuPDF(fitz)   解析 PDF 用。**延迟导入**，没装会尝试自动 pip 安装一次
                    （默认源失败则换清华镜像）；仍装不上就跳过 PDF、继续处理其它素材。
                    Lite 的安装器只装干净的 Python 3.12、不带任何第三方包，所以这条很关键。
    python-docx     .docx；openpyxl 解析 .xlsx。缺了只跳过对应类型。
    `--no-install`  离线环境用，禁止脚本自己 pip。

用法
    python <技能根>/scripts/process_upload.py --input <素材目录> --output <产物目录>

产物（全部落在 --output 下，绝不写技能目录）
    <名>.md              提取出的正文（含表格 markdown、图片占位）
    image/<名>/*.png     去重过滤后的图片
    image_<名>.json      图片描述清单（补完描述后给后续流程用）
    manifest.json        总清单 + **needs_vision**（唯一需要调视觉 MCP 的列表）
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional

# —— PyMuPDF 是**延迟导入**的，不在模块顶层。
# 原因：Lite 的安装器只装一个干净的 Python 3.12，不 pip 装任何第三方包
# （PyMuPDF 只存在于 Pro 的 Docker/VM 镜像里）。写在顶层的话，一台新装的 Lite
# 上连"只有 docx 的素材目录"都会因为 import fitz 直接崩掉——而那份素材压根用不到它。
_FITZ: Any = None
_FITZ_TRIED = False


def _get_fitz(auto_install: bool = True) -> Any:
    """按需拿到 fitz；没装就尝试自动装一次，装不上返回 None（调用方要能降级）。"""
    global _FITZ, _FITZ_TRIED
    if _FITZ is not None:
        return _FITZ
    try:
        import fitz  # type: ignore  # noqa: PLC0415
        _FITZ = fitz
        return _FITZ
    except ImportError:
        pass
    if not auto_install or _FITZ_TRIED:
        return None
    _FITZ_TRIED = True
    print("  [Parser] 未检测到 PyMuPDF，正在自动安装（解析 PDF 需要它）...", flush=True)
    # 先走默认源；国内网络常连不上 pypi.org，失败再换清华镜像重试一次
    for extra in ([], ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]):
        try:
            r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pymupdf"] + extra,
                               capture_output=True, text=True, timeout=300)
            if r.returncode == 0:
                try:
                    import fitz  # type: ignore  # noqa: PLC0415
                    _FITZ = fitz
                    print("  [Parser] PyMuPDF 安装成功 ✅", flush=True)
                    return _FITZ
                except ImportError:
                    pass
        except Exception:  # noqa: BLE001
            pass
    print("  [Parser] ⚠ PyMuPDF 装不上（多半是没网）。PDF 会被跳过，其它类型的素材照常处理。\n"
          "           手动装：pip install pymupdf   装完重跑本脚本即可。", flush=True)
    return None

# —— 抽图过滤阈值。目的是把"装饰件"挡掉，只留下真正承载信息的图。
MIN_EDGE_PX = 80          # 任一边小于它 → 图标/间隔条
MIN_PAGE_AREA_RATIO = 0.005   # 占页面面积不足 0.5% → 装饰
MAX_ASPECT = 20.0         # 长宽比超过它 → 分隔线/色条
MAX_IMAGES_PER_DOC = 30   # 单文档保留上限，超出按面积从大到小截断
SCAN_TEXT_THRESHOLD = 20  # 一页可提取文字少于这么多字 → 疑似扫描件
SCAN_RENDER_DPI = 150

PLACEHOLDER_DESC = "待补描述（用视觉 MCP 看图后回填）"


def _sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


class UserSourceFileParser:
    """把一个目录里的用户素材解析成 markdown + 图片 + 清单。"""

    def __init__(self, auto_install: bool = True) -> None:
        self.needs_vision: List[Dict[str, Any]] = []
        self.file_reports: List[Dict[str, Any]] = []
        self.auto_install = auto_install

    # ------------------------------------------------------------------ 入口

    def parse(self, input_dir: str, target_dir: str) -> str:
        input_dir = os.path.abspath(input_dir)
        target_dir = os.path.abspath(target_dir)
        if not os.path.exists(input_dir):
            return f"失败：输入目录不存在 {input_dir}"
        os.makedirs(target_dir, exist_ok=True)
        image_root = os.path.join(target_dir, "image")
        os.makedirs(image_root, exist_ok=True)

        resource_list: List[str] = []
        user_uploaded_images: List[str] = []

        # 递归扫，用户常常把素材放在子目录里
        files: List[str] = []
        for root, _dirs, names in os.walk(input_dir):
            for n in sorted(names):
                files.append(os.path.join(root, n))

        for file_path in files:
            filename = os.path.basename(file_path)
            ext = os.path.splitext(filename)[1].lower()
            base_name = os.path.splitext(filename)[0]
            print(f"  [Parser] 📂 {filename} ...", end="", flush=True)

            if ext == ".pdf":
                ok = self._parse_pdf(file_path, target_dir, image_root)
                print(" DONE ✅" if ok else "")   # 失败/跳过时 _parse_pdf 已打印过原因
                if ok:
                    resource_list.extend([f"{base_name}.md", f"image_{base_name}.json"])
            elif ext in (".txt", ".md", ".csv", ".json"):
                shutil.copy2(file_path, os.path.join(target_dir, filename))
                resource_list.append(filename)
                self.file_reports.append({"name": filename, "type": ext.lstrip("."), "copied": True})
                print(" DONE ✅")
            elif ext == ".docx":
                ok = self._parse_docx(file_path, target_dir)
                print(" DONE ✅" if ok else " SKIP（缺 python-docx）⚠")
                if ok:
                    resource_list.append(f"{base_name}.md")
            elif ext in (".xlsx", ".xls"):
                ok = self._parse_xlsx(file_path, target_dir)
                print(" DONE ✅" if ok else " SKIP（缺 openpyxl）⚠")
                if ok:
                    resource_list.append(f"{base_name}.md")
            elif ext in (".jpg", ".jpeg", ".png", ".svg", ".webp", ".bmp"):
                user_uploaded_images.append(file_path)
                print(" QUEUED 📥")
            else:
                print(" 跳过（不支持的类型）")

        if user_uploaded_images:
            print(f"  [Parser] 🖼️ 归档用户上传的 {len(user_uploaded_images)} 张图 ...", end="", flush=True)
            if self._handle_user_images(user_uploaded_images, target_dir, image_root):
                resource_list.append("image_user_upload.json")
                print(" DONE ✅")
            else:
                print(" FAILED ❌")

        self._write_manifest(target_dir)
        resource_list.append("manifest.json")

        skipped = [r["name"] for r in self.file_reports if r.get("skipped")]
        n_vision = len(self.needs_vision)
        if skipped:
            return (
                f"部分完成：{len(skipped)} 个 PDF 因缺 PyMuPDF 未解析（{', '.join(skipped[:3])}）。\n"
                f"先装依赖再重跑：pip install pymupdf\n"
                f"目标文件夹: {target_dir}\n"
                f"其余素材已处理，清单: {', '.join(resource_list)}"
            )
        return (
            f"成功：本地解析完成（全程未调用 MCP）。\n"
            f"目标文件夹: {target_dir}\n"
            f"清单: {', '.join(resource_list)}\n"
            f"需要视觉 MCP 看的图: {n_vision} 张 —— 见 manifest.json 的 needs_vision；"
            f"{'其余图片已按去重/装饰过滤剔除，不必送识图。' if n_vision else '本次无需调用识图。'}"
        )

    # -------------------------------------------------------------------- PDF

    def _parse_pdf(self, file_path: str, target_dir: str, image_root: str) -> bool:
        base_name = os.path.splitext(os.path.basename(file_path))[0]
        pdf_img_dir = os.path.join(image_root, base_name)
        os.makedirs(pdf_img_dir, exist_ok=True)

        md_parts: List[str] = []
        kept: List[Dict[str, Any]] = []
        seen_hashes: Dict[str, str] = {}      # 图片内容 hash -> 已保存的相对路径
        dropped = {"dup": 0, "small": 0, "thin": 0, "over_cap": 0}
        scanned_pages: List[int] = []
        total_chars = 0
        n_tables = 0

        fitz = _get_fitz(self.auto_install)
        if fitz is None:
            self.file_reports.append({"name": os.path.basename(file_path), "type": "pdf",
                                      "skipped": "缺 PyMuPDF，未解析"})
            print(" SKIPPED（缺 PyMuPDF，PDF 未解析）⚠")
            return False
        try:
            doc = fitz.open(file_path)
        except Exception as exc:  # noqa: BLE001
            print(f" FAILED ❌ PDF 打开失败: {exc}")
            return False

        try:
            for pno in range(len(doc)):
                page = doc.load_page(pno)
                text = page.get_text().strip()
                total_chars += len(text)
                md_parts.append(f"\n\n<!-- page {pno + 1} -->\n")
                if text:
                    md_parts.append(text)

                # 表格：本地就能抽成 markdown，别浪费识图去"看"表格
                try:
                    tabs = page.find_tables()
                    for t in tabs.tables:
                        # find_tables 会把"大字标题 + 副标题"这种对齐排版误判成 1×2 的表，
                        # 抽出来是一行重复正文的垃圾。真表格至少 2 行 2 列。
                        if getattr(t, "row_count", 0) < 2 or getattr(t, "col_count", 0) < 2:
                            continue
                        if not self._looks_like_table(t):
                            continue
                        md = t.to_markdown()
                        if md and md.strip():
                            md_parts.append("\n\n" + md.strip() + "\n")
                            n_tables += 1
                except Exception:  # noqa: BLE001, S110
                    pass  # 老版本 PyMuPDF 没有 find_tables，跳过即可

                page_area = abs(page.rect.width * page.rect.height) or 1.0
                page_is_scan = len(text) < SCAN_TEXT_THRESHOLD and bool(page.get_images())
                for img in page.get_images(full=True):
                    xref = img[0]
                    # 判"大不大"必须看**版面上的摆放尺寸**，不能看像素尺寸——
                    # 一张 120×120 的 logo 和一张 120×120 的缩略图在页面上可以差十倍大小。
                    # 早期版本拿像素面积去比页面点面积，量纲根本不对，结果把 logo 全当装饰扔了。
                    rects = []
                    try:
                        rects = page.get_image_rects(xref)
                    except Exception:  # noqa: BLE001, S110
                        pass
                    if rects:
                        rw = max(r.width for r in rects)
                        rh = max(r.height for r in rects)
                    else:
                        rw = rh = 0.0

                    if rw and rh:
                        if (rw * rh) / page_area < MIN_PAGE_AREA_RATIO:
                            dropped["small"] += 1
                            continue
                        if max(rw, rh) / max(1e-6, min(rw, rh)) > MAX_ASPECT:
                            dropped["thin"] += 1      # 分隔线 / 装饰色条
                            continue

                    info = self._extract_image(fitz, doc, xref)
                    if info is None:
                        continue
                    data, w, h = info
                    if w < MIN_EDGE_PX or h < MIN_EDGE_PX:
                        dropped["small"] += 1         # 原图太糊，放进 PPT 也是马赛克
                        continue

                    digest = _sha1(data)
                    if digest in seen_hashes:
                        dropped["dup"] += 1        # 页眉 logo 这类重复件，只留第一份
                        continue
                    if page_is_scan:
                        # 整页就是一张扫描图：下面会把**整页**渲染出来送识图，
                        # 这里再留一份内嵌图就是同一个东西送两次。
                        dropped["scan_page"] = dropped.get("scan_page", 0) + 1
                        seen_hashes[digest] = ""
                        continue

                    fname = f"p{pno + 1}_i{len(kept) + 1}.png"
                    save_path = os.path.join(pdf_img_dir, fname)
                    with open(save_path, "wb") as fh:
                        fh.write(data)
                    rel = f"image/{base_name}/{fname}"
                    seen_hashes[digest] = rel
                    kept.append({"rel_path": rel, "page": pno + 1, "w": w, "h": h,
                                 "area": w * h, "md_index": len(md_parts)})
                    md_parts.append(f"\n![{PLACEHOLDER_DESC}]({rel})\n")

                # 扫描件：整页没字 → 本地读不出内容，这才是该动用识图的场合
                if len(text) < SCAN_TEXT_THRESHOLD and page.get_images():
                    scanned_pages.append(pno + 1)
                    scan_name = f"page-{pno + 1:03d}-scan.png"
                    scan_path = os.path.join(pdf_img_dir, scan_name)
                    try:
                        page.get_pixmap(dpi=SCAN_RENDER_DPI).save(scan_path)
                        self.needs_vision.append({
                            "path": f"image/{base_name}/{scan_name}",
                            "reason": "该页提取不到文字（扫描件/纯图排版），需要识图读出内容",
                            "source": f"{base_name}.pdf p{pno + 1}",
                            "priority": "high",
                        })
                    except Exception:  # noqa: BLE001, S110
                        pass

            # 超过上限的按面积保留最大的那些
            if len(kept) > MAX_IMAGES_PER_DOC:
                kept.sort(key=lambda k: -k["area"])
                dropped["over_cap"] = len(kept) - MAX_IMAGES_PER_DOC
                for extra in kept[MAX_IMAGES_PER_DOC:]:
                    try:
                        os.remove(os.path.join(target_dir, extra["rel_path"].replace("/", os.sep)))
                    except OSError:
                        pass
                kept = kept[:MAX_IMAGES_PER_DOC]

            for k in kept:
                self.needs_vision.append({
                    "path": k["rel_path"],
                    "reason": "内容图（图表/照片/示意图），需要一句话描述才能用进 PPT",
                    "source": f"{base_name}.pdf p{k['page']}",
                    "priority": "normal",
                })

            with open(os.path.join(target_dir, f"{base_name}.md"), "w", encoding="utf-8") as fh:
                fh.write("".join(md_parts).strip() + "\n")
            with open(os.path.join(target_dir, f"image_{base_name}.json"), "w", encoding="utf-8") as fh:
                json.dump([{"local_rel_path": k["rel_path"], "description": PLACEHOLDER_DESC} for k in kept],
                          fh, ensure_ascii=False, indent=2)

            self.file_reports.append({
                "name": os.path.basename(file_path), "type": "pdf", "pages": len(doc),
                "text_chars": total_chars, "tables": n_tables,
                "images_kept": len(kept), "images_dropped": dropped,
                "scanned_pages": scanned_pages,
            })
            return True
        except Exception as exc:  # noqa: BLE001
            print(f" FAILED ❌ PDF 解析出错: {exc}")
            return False
        finally:
            doc.close()

    @staticmethod
    def _looks_like_table(t: Any) -> bool:
        """挡掉 find_tables 的误报。

        它会把**柱状图的数值标签**按坐标凑成一张网格（实测抽出过一张 9×9、
        六成格子是空的"表"，里面是 120/85/62/45 这些柱子的值）。这种假表混进
        正文，agent 会当成真数据引用到 PPT 里，比没抽到更糟。
        真表格的特征：格子大多是填的，且表头不是 PyMuPDF 自动编的 ColN。
        """
        try:
            grid = t.extract()
        except Exception:  # noqa: BLE001
            return True                       # 取不到就别拦，交给后面的人判断
        if not grid or len(grid) < 2:
            return False
        cells = [c for row in grid for c in row]
        if not cells:
            return False
        filled = sum(1 for c in cells if c is not None and str(c).strip())
        if filled / len(cells) < 0.5:         # 一半以上是空格子 → 不是表
            return False
        header = [str(c or "").strip() for c in grid[0]]
        auto = sum(1 for h in header if h.lower().startswith("col") and h[3:].isdigit())
        if auto >= max(1, len(header) // 2):  # 表头过半是自动编号 → 原本就没有表头
            return False
        return True

    @staticmethod
    def _extract_image(fitz: Any, doc: Any, xref: int) -> Optional[tuple]:
        """取出一张图的 PNG 字节 + 宽高。

        CMYK 和带 alpha 的图直接 ``pix.save()`` 会抛异常（"unsupported colorspace
        for png"），必须先转成 RGB —— 这是 PyMuPDF 抽图最常见的翻车点，老版本
        脚本没处理，遇到印刷品 PDF 会整份失败。
        """
        try:
            pix = fitz.Pixmap(doc, xref)
            if pix.n - pix.alpha >= 4:            # CMYK / Separation
                pix = fitz.Pixmap(fitz.csRGB, pix)
            if pix.alpha:                          # 带透明通道，压平成 RGB
                pix = fitz.Pixmap(fitz.csRGB, pix)
            return pix.tobytes("png"), pix.width, pix.height
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------ docx / xlsx

    def _parse_docx(self, file_path: str, target_dir: str) -> bool:
        try:
            import docx  # type: ignore
        except ImportError:
            return False
        base = os.path.splitext(os.path.basename(file_path))[0]
        d = docx.Document(file_path)
        lines: List[str] = []
        for p in d.paragraphs:
            t = p.text.strip()
            if not t:
                continue
            style = (p.style.name or "").lower()
            if style.startswith("heading"):
                lvl = "".join(ch for ch in style if ch.isdigit()) or "1"
                lines.append("#" * min(6, int(lvl)) + " " + t)
            else:
                lines.append(t)
        for tb in d.tables:
            rows = [[c.text.strip().replace("\n", " ") for c in r.cells] for r in tb.rows]
            if not rows:
                continue
            lines.append("")
            lines.append("| " + " | ".join(rows[0]) + " |")
            lines.append("|" + "---|" * len(rows[0]))
            for r in rows[1:]:
                lines.append("| " + " | ".join(r) + " |")
            lines.append("")
        with open(os.path.join(target_dir, f"{base}.md"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        self.file_reports.append({"name": os.path.basename(file_path), "type": "docx",
                                  "paragraphs": len(d.paragraphs), "tables": len(d.tables)})
        return True

    def _parse_xlsx(self, file_path: str, target_dir: str) -> bool:
        try:
            import openpyxl  # type: ignore
        except ImportError:
            return False
        base = os.path.splitext(os.path.basename(file_path))[0]
        wb = openpyxl.load_workbook(file_path, data_only=True)
        lines: List[str] = []
        for ws in wb.worksheets:
            lines.append(f"\n## 工作表：{ws.title}\n")
            rows = list(ws.iter_rows(values_only=True))
            if not rows:
                continue
            head = ["" if v is None else str(v) for v in rows[0]]
            lines.append("| " + " | ".join(head) + " |")
            lines.append("|" + "---|" * len(head))
            for r in rows[1:]:
                lines.append("| " + " | ".join("" if v is None else str(v) for v in r) + " |")
        with open(os.path.join(target_dir, f"{base}.md"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        self.file_reports.append({"name": os.path.basename(file_path), "type": "xlsx",
                                  "sheets": len(wb.worksheets)})
        return True

    # ------------------------------------------------------------ 用户上传的图

    def _handle_user_images(self, image_paths: List[str], target_dir: str, image_root: str) -> bool:
        meta: List[Dict[str, Any]] = []
        seen: Dict[str, str] = {}
        try:
            for path in image_paths:
                with open(path, "rb") as fh:
                    digest = _sha1(fh.read())
                if digest in seen:
                    continue                       # 同一张图上传了多次
                name = os.path.basename(path)
                dest = os.path.join(image_root, name)
                shutil.copy2(path, dest)
                rel = f"image/{name}"
                seen[digest] = rel
                meta.append({"name": name, "description": PLACEHOLDER_DESC, "local_rel_path": rel})
                self.needs_vision.append({
                    "path": rel,
                    "reason": "用户直接上传的图，需要描述才知道能用在哪一页",
                    "source": name,
                    "priority": "high",
                })
            with open(os.path.join(target_dir, "image_user_upload.json"), "w", encoding="utf-8") as fh:
                json.dump(meta, fh, ensure_ascii=False, indent=2)
            self.file_reports.append({"name": "(用户上传图片)", "type": "images",
                                      "kept": len(meta), "dup_dropped": len(image_paths) - len(meta)})
            return True
        except Exception as exc:  # noqa: BLE001
            print(f" 图片归档出错: {exc}", end="")
            return False

    # ---------------------------------------------------------------- manifest

    def _write_manifest(self, target_dir: str) -> None:
        manifest = {
            "generated_by": "process_upload.py（纯本地解析，未调用任何 MCP）",
            "files": self.file_reports,
            "needs_vision": self.needs_vision,
            "how_to_use": [
                "1. 正文/表格已经在各 .md 里，直接读，不需要识图。",
                "2. 只把 needs_vision 里的图交给视觉 MCP，优先处理 priority=high 的。",
                "3. 拿到描述后回填 image_*.json 的 description 字段。",
                "4. 严禁用 Read 工具读图片。",
            ],
        }
        with open(os.path.join(target_dir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="用户上传素材的本地解析（不依赖 MCP）")
    ap.add_argument("--input", required=True, help="用户素材目录")
    ap.add_argument("--output", required=True, help="产物目录（绝不要指到技能目录）")
    ap.add_argument("--no-install", action="store_true",
                    help="缺 PyMuPDF 时不要自动 pip 安装（离线环境用）")
    args = ap.parse_args()
    print(UserSourceFileParser(auto_install=not args.no_install).parse(args.input, args.output))
