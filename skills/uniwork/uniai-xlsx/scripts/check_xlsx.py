"""XLSX 交付前自检：把 SKILL.md 的硬规则跑成一道闸门。

    python scripts/check_xlsx.py out/report.xlsx
    python scripts/check_xlsx.py out/report.xlsx --json --strict

有 ERROR 就是返工（退出码 1）。它查的是"打开看一眼像那么回事、细看全是问题"的那些：
派生值被硬编码成数字、公式错误、裸表头、数字列左对齐、没设数字格式、没冻结、
中文用西文字体、列宽裁字、数据区滥用合并单元格、强调色不止一个。

它**不能**替代 `recalc.py`：公式算不算得出来、有没有 #REF!，要靠 LibreOffice 真算一遍。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

CJK = re.compile(r"[㐀-鿿豈-﫿　-〿＀-￯]")
ERRORS = ("#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A")
# 这些表头/行标一出现，该列或该行的值就应该是公式而不是常数
DERIVED_WORDS = ("合计", "总计", "小计", "累计", "平均", "占比", "比例", "增速",
                 "同比", "环比", "增长率", "毛利", "利润率", "差额", "total", "sum",
                 "average", "growth", "margin", "%")
NEUTRAL = {"000000", "FFFFFF", "1F2937", "595959", "D9D9D9", "F7F8FA", "F2F2F2",
           "E7E6E6", "808080", "404040", "BFBFBF", "auto", None}
WESTERN_ONLY = {"Arial", "Calibri", "Times New Roman", "Helvetica", "Verdana", "Tahoma"}


class Report:
    def __init__(self):
        self.items = []

    def add(self, level, code, msg, where=""):
        self.items.append({"level": level, "code": code, "msg": msg, "where": where})

    error = lambda self, c, m, w="": self.add("ERROR", c, m, w)
    warn = lambda self, c, m, w="": self.add("WARN", c, m, w)
    info = lambda self, c, m, w="": self.add("INFO", c, m, w)


def rgb_of(color):
    """openpyxl 的颜色可能是 str、RGB 对象或主题色，统一成 6 位十六进制或 None。"""
    if color is None:
        return None
    rgb = getattr(color, "rgb", None)
    if rgb is None or not isinstance(rgb, str):   # RGB 对象 / 主题色 / indexed
        return None
    return rgb[-6:].upper()


def is_derived_label(text):
    t = str(text or "").strip().lower()
    return any(w.lower() in t for w in DERIVED_WORDS)


def sheet_cells(ws):
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is not None:
                yield cell


def find_header_row(ws, limit=8):
    """表头 = 前几行里非空单元格最多、且基本都是文本的那一行。"""
    best, best_score = None, 0
    for r in range(1, min(ws.max_row, limit) + 1):
        cells = [c for c in ws[r] if c.value is not None]
        if len(cells) < 2:
            continue
        texts = sum(1 for c in cells if isinstance(c.value, str) and not str(c.value).startswith("="))
        if texts == len(cells) and len(cells) > best_score:
            best, best_score = r, len(cells)
    return best


def check_sheet(ws, rep):
    where = ws.title
    header_row = find_header_row(ws)
    if header_row is None:
        rep.info("NO_TABLE", "没识别出表头行，跳过表格类检查（可能是纯说明页）。", where)
        return

    first_data = header_row + 1
    ncols = ws.max_column

    # --- 1. 派生值被硬编码 ------------------------------------------------
    hardcoded = []
    derived_cols = {c for c in range(1, ncols + 1)
                    if is_derived_label(ws.cell(row=header_row, column=c).value)}
    for r in range(first_data, ws.max_row + 1):
        row_label = str(ws.cell(row=r, column=1).value or "")
        row_is_derived = is_derived_label(row_label)
        for c in range(1, ncols + 1):
            cell = ws.cell(row=r, column=c)
            if not isinstance(cell.value, (int, float)) or isinstance(cell.value, bool):
                continue
            if row_is_derived or c in derived_cols:
                hardcoded.append(cell.coordinate)
    if hardcoded:
        # 蓝字单元格（mark_input）属于用户输入，不是派生值，跳过
        # （蓝字 = f.color 为 RGB(0,0,255) 或 '#0000FF'，财务模型惯例：用户输入格）
        filtered = []
        for coord in hardcoded:
            # 解析坐标如 'B4' → (col, row)
            import re
            m = re.match(r'([A-Z]+)(\d+)', coord)
            if m:
                col_letter, row_s = m.group(1), m.group(2)
                from openpyxl.utils import column_index_from_string
                col_idx = column_index_from_string(col_letter)
                row_idx = int(row_s)
                cell = ws.cell(row=row_idx, column=col_idx)
                f = cell.font
                fc = rgb_of(f.color) if f and f.color else None
                # 蓝字 = 用户输入，不报
                if fc in ('0000FF', 'FF0000', '008000'):  # 蓝/红/绿都是语义色
                    continue
            filtered.append(coord)
        if filtered:
            rep.error("HARDCODED_DERIVED",
                      f"{len(filtered)} 个派生值是写死的数字，不是公式："
                      f"{'、'.join(filtered[:8])}{'…' if len(filtered) > 8 else ''}。"
                      "合计/占比/增速这类值必须写成 Excel 公式，源数据一改就得跟着变。", where)

    # --- 2. 缓存里的公式错误 ---------------------------------------------
    errs = Counter()
    for cell in sheet_cells(ws):
        if isinstance(cell.value, str):
            for e in ERRORS:
                if e in cell.value:
                    errs[e] += 1
                    break
    if errs:
        rep.error("FORMULA_ERROR",
                  "存在公式错误：" + "、".join(f"{k}×{v}" for k, v in errs.items())
                  + "。交付前必须清零。", where)

    # --- 2b. 公式引用了 SUM 行但用了硬编码行号（而非变量）-------------------
    # 规则：
    #   (1) 相对列引用了不同列的 SUM 行  → 如 D 列公式用 C19 引用 C 列的 SUM 行
    #   (2) 绝对列引用了不同列的 SUM 行  → 如 C 列公式用 $C$19 引用 C 列的 SUM 行（行号硬编码）
    #   (3) 相对列引用了同一列的非本行列的 SUM 行（如 C25 中 C23/C24）
    # 注意：同列同行引用（如 D10 中 C10/C10）不计入错误，因为是同列 self-ref
    import re
    ref_pattern = re.compile(r'\$?([A-Z]+)\$(\d+)|([A-Z]+)(\d+)')
    # 1. 找出所有 SUM 行（add_total_row 创建的合计行）
    sum_rows = set()
    for r in range(first_data, ws.max_row + 1):
        for c in range(1, ncols + 1):
            v = ws.cell(row=r, column=c).value
            if isinstance(v, str) and v.startswith('=SUM('):
                sum_rows.add(r)
    # 2. 扫描所有公式格
    hardcoded_sum_refs = {}  # {ref_row: {cell.coordinate}}
    for cell in sheet_cells(ws):
        if not isinstance(cell.value, str) or not cell.value.startswith('='):
            continue
        row_idx = cell.row
        col_idx = cell.column
        for m in ref_pattern.finditer(cell.value):
            col_abs, row_abs = m.group(1), m.group(2)   # $C$19
            col_rel, row_rel = m.group(3), m.group(4)   # C19
            col_letter = col_abs if col_abs else col_rel
            ref_row = int(row_abs if row_abs else row_rel)
            if ref_row not in sum_rows:
                continue
            # 解析引用的列字母→列号
            from openpyxl.utils import column_index_from_string
            ref_col = column_index_from_string(col_letter)
            is_rel = not bool(col_abs)  # 相对列（无$）还是绝对列（有$）
            # 规则 (1)(2): 引用了不同列的 SUM 行 → 硬编码行号
            # 规则 (3): 同列但 ref_row≠row_idx（引用了同行不同行的 SUM 行）也视为硬编码
            if ref_col != col_idx or (ref_col == col_idx and ref_row != row_idx):
                if ref_row not in hardcoded_sum_refs:
                    hardcoded_sum_refs[ref_row] = set()
                hardcoded_sum_refs[ref_row].add(cell.coordinate)
    if hardcoded_sum_refs:
        items = [f"C{ref_row}在{', '.join(sorted(coords)[:3])}{'…' if len(coords) > 3 else ''}"
                 for ref_row, coords in sorted(hardcoded_sum_refs.items())]
        rep.warn("FORMULA_HARDCODE_ROW",
                 f"公式引用了 SUM 合计格但用了硬编码行号（{'; '.join(items)}）。"
                 "建议用 add_total_row 返回的变量代入公式，这样表头行数变化时公式仍然正确。"
                 "（=$C$9 这类绝对引用在静态表格中是合法的，只是增加维护成本。）", where)

    # --- 3. 表头 ----------------------------------------------------------
    hdr = [ws.cell(row=header_row, column=c) for c in range(1, ncols + 1)]
    filled = any(rgb_of(c.fill.fgColor) not in (None, "000000", "FFFFFF")
                 for c in hdr if c.fill is not None)
    bold = any(c.font is not None and c.font.bold for c in hdr)
    if not filled and not bold:
        rep.warn("BARE_HEADER", f"第 {header_row} 行是裸表头：既没底色也没加粗，建议加底色或加粗。", where)
    elif not filled:
        rep.info("BARE_HEADER", "表头只加粗没底色，视觉层级偏弱（可接受）。", where)

    if not ws.freeze_panes:
        rep.info("NO_FREEZE", f"没有冻结窗格，滚动时表头会滚出视野（freeze_panes='A{first_data}'）。",
                 where)

    # --- 4. 数字列：格式与对齐 -------------------------------------------
    for c in range(1, ncols + 1):
        letter = get_column_letter(c)
        vals, fmts, aligns = [], set(), set()
        num_vals = []  # 收集数值用于判断是否是序号列
        for r in range(first_data, ws.max_row + 1):
            cell = ws.cell(row=r, column=c)
            if cell.value is None:
                continue
            numeric = isinstance(cell.value, (int, float)) and not isinstance(cell.value, bool)
            formula = isinstance(cell.value, str) and cell.value.startswith("=")
            if numeric or formula:
                vals.append(cell)
                fmts.add(cell.number_format)
                aligns.add(cell.alignment.horizontal if cell.alignment else None)
                if numeric:
                    num_vals.append(cell.value)
        if len(vals) < 2:
            continue
        # 判断是否是序号列：值是连续整数序列（如 1,2,3...）且范围合理
        # 序号列的原始值必须是连续 int，不接受公式（因为 write_table 写的就是 int）
        is_seq_col = False
        if num_vals and len(num_vals) >= 2:
            sorted_vals = sorted(num_vals)
            # 连续整数序列检查：值必须全是 int，依次递增 1，起始值 >= 1，最大值 <= 9999
            if (all(isinstance(v, int) for v in sorted_vals)
                    and sorted_vals == list(range(sorted_vals[0], sorted_vals[0] + len(sorted_vals)))
                    and 1 <= sorted_vals[0] <= 9999):
                is_seq_col = True
        if is_seq_col:
            # 序号列：检查是否居中（write_table 默认 center，style_table 可能会覆盖）
            if aligns and all(a in (None, "left", "general") for a in aligns):
                rep.info("SEQ_ALIGN", f"{letter} 列是序号列却不是居中对齐，write_table 默认居中，如需修复检查 style_table 调用。", where)
            continue  # 序号列本身不报 NUM_ALIGN
        if aligns and all(a in (None, "left", "general") for a in aligns):
            rep.error("NUM_ALIGN", f"{letter} 列是数字列却左对齐，金额/占比/增速列必须右对齐。", where)
        if fmts <= {"General"}:
            rep.warn("NO_NUMBER_FORMAT",
                     f"{letter} 列没设数字格式，金额不带千分位、百分比显示成小数。", where)

    # --- 5. 字体与颜色 ----------------------------------------------------
    accent, cjk_western = set(), []
    for cell in sheet_cells(ws):
        f = cell.font
        if f is not None:
            fc = rgb_of(f.color)
            # 蓝/绿/红是财务模型的语义色（输入/跨表/外部引用），不算"强调色"
            if fc and fc not in NEUTRAL and fc not in ("0000FF", "008000", "FF0000"):
                accent.add(fc)
            if CJK.search(str(cell.value)) and f.name in WESTERN_ONLY:
                cjk_western.append(cell.coordinate)
        if cell.fill is not None:
            bg = rgb_of(cell.fill.fgColor)
            if bg and bg not in NEUTRAL and bg != "000000":
                accent.add(bg)
    if cjk_western:
        rep.error("CJK_FONT",
                  f"{len(cjk_western)} 个含中文的单元格用了西文字体（{cjk_western[:5]}），"
                  "中文会串码或字形难看，改用微软雅黑/宋体。", where)
    if len(accent) > 2:
        rep.error("MULTI_ACCENT",
                 f"出现 {len(accent)} 种非中性色：{sorted(accent)[:6]}。"
                 "全 sheet 只锁一个强调色 + 配套浅底，add_title/sec_title/style_table 请全部显式传同一个 theme=。", where)

    # --- 6. 列宽与合并单元格 ---------------------------------------------
    def is_explanatory_text(v):
        """判断是否为说明性文本（提示/示例等，不应计入列宽需求）。"""
        if v is None:
            return True
        s = str(v)
        # 提示性关键词：说明性、不参与列宽计算的行
        EXPLANATORY_KEYWORDS = (
            '提示', '示例', '说明', '输入', '修改', '填写', '参考',
            '可改', '直接', '蓝色', '黄色', '单元格', '打开自动',
            '年化', '收益', '目标', '配置', '比重', '注：', '备注',
            '自动计算', '仅供参考', '自动生成', '系统', '仅供参考',
        )
        # 说明性文本特征：含长提示词，且不是表格数据（一行内多列有值才是数据行）
        return any(kw in s for kw in EXPLANATORY_KEYWORDS) and len(s) > 15

    for c in range(1, ncols + 1):
        letter = get_column_letter(c)
        need = 0
        for r in range(header_row, ws.max_row + 1):
            v = ws.cell(row=r, column=c).value
            if v is None or (isinstance(v, str) and v.startswith("=")):
                continue
            # 跳过说明性文本（长提示文案等），不参与列宽需求计算
            if is_explanatory_text(v):
                continue
            need = max(need, sum(2 if CJK.search(ch) else 1 for ch in str(v)))
        if not need:                 # 空列（多半是标题合并跨过去的），不参与列宽检查
            continue
        dim = ws.column_dimensions.get(letter)
        width = dim.width if dim is not None and dim.width else None
        if width is None:
            rep.info("NO_COL_WIDTH", f"{letter} 列没设列宽，默认 8.43 常常裁字。", where)
        elif need and width < need * 0.75:
            rep.warn("COL_TOO_NARROW",
                     f"{letter} 列宽 {width:.0f}，内容最宽约 {need} 字符，会被裁掉。", where)

    data_merges = [str(m) for m in ws.merged_cells.ranges if m.min_row >= first_data]
    if data_merges:
        rep.warn("MERGED_IN_DATA",
                 f"数据区有合并单元格（{data_merges[:5]}），会影响排序/筛选/公式引用。"
                 "如确需视觉分组，建议用 sec_title() 加粗底色代替合并。", where)


def main():
    ap = argparse.ArgumentParser(description="XLSX 交付前自检")
    ap.add_argument("path")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true", help="WARN 也算失败")
    ap.add_argument("--fast", action="store_true", help="只查 ERROR，跳过 WARN（快速模式）")
    args = ap.parse_args()

    rep = Report()
    wb = load_workbook(args.path, data_only=False)
    for ws in wb.worksheets:
        if ws.max_row == 1 and ws.max_column == 1 and ws["A1"].value is None:
            continue
        check_sheet(ws, rep)

    # 缓存值视角：公式有没有被算过
    wbc = load_workbook(args.path, data_only=True)
    formulas = sum(1 for ws in wb.worksheets for c in sheet_cells(ws)
                   if isinstance(c.value, str) and c.value.startswith("="))
    if formulas:
        cached = sum(1 for ws in wb.worksheets for c in sheet_cells(ws)
                     if isinstance(c.value, str) and c.value.startswith("=")
                     and wbc[ws.title][c.coordinate].value is not None)
        if cached == 0:
            rep.info("NOT_RECALCULATED",
                     f"{formulas} 个公式都没有缓存值（无 LibreOffice）。"
                     "用 Excel/WPS 打开会自动重算，无需修复。")

    errors = [i for i in rep.items if i["level"] == "ERROR"]
    warns = [i for i in rep.items if i["level"] == "WARN"]

    # --fast 模式：只显示 ERROR，过滤掉 WARN
    if args.fast:
        rep.items = [i for i in rep.items if i["level"] == "ERROR"]
        warns = []

    if args.json:
        print(json.dumps({"path": args.path, "errors": len(errors),
                          "warnings": len(warns), "items": rep.items},
                         ensure_ascii=False, indent=2))
    else:
        icon = {"ERROR": "✗", "WARN": "!", "INFO": "·"}
        for lvl in ("ERROR", "WARN", "INFO"):
            for it in [i for i in rep.items if i["level"] == lvl]:
                loc = f" [{it['where']}]" if it["where"] else ""
                print(f"{icon[lvl]} {lvl:<5} {it['code']}{loc}: {it['msg']}")
        print(f"\n{len(errors)} error(s), {len(warns)} warning(s)", end="")
        if args.fast:
            print(" [fast 模式，已跳过 WARN 提示]", end="")
        print(f" — {len(wb.worksheets)} 个 sheet，{formulas} 个公式")
        if not rep.items:
            print("干净。公式是否算得出来仍要靠 recalc.py 验。")

    sys.exit(1 if errors or (args.strict and warns) else 0)


if __name__ == "__main__":
    main()
