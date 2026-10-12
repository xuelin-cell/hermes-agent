"""openpyxl 报表助手：把 SKILL.md 的硬规则变成可调用的函数。

    import sys; sys.path.insert(0, '<skill_dir>/scripts')
    from xlsx_helpers import *

    wb = Workbook(); ws = wb.active
    write_table(ws, header=['业务线','收入（万元）','占比'], rows=data, start_row=3)
    add_total_row(ws, first_row=4, last_row=9, cols='BC', label_col='A')
    style_table(ws, header_row=3, first_row=4, last_row=10, theme='navy',
                money_cols='B', percent_cols='C')
    autofit_columns(ws)

为什么要用这些函数：SKILL.md 里那段"数字右对齐"的片段有个隐蔽 bug——
`isinstance(cell.value, (int, float))` 对公式单元格是**假**（公式的值是字符串 '=SUM(...)'），
所以合计行永远不会被右对齐，而技能自己写着"数字列左对齐 = 不合格"。
这里的 `style_table` 按**列**判定，不按单个单元格的 Python 类型判定。
"""

from __future__ import annotations

import re

from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter, column_index_from_string

__all__ = [
    "THEMES", "INK", "MUTED", "LINE", "ZEBRA", "FMT",
    "write_table", "add_total_row", "style_table", "autofit_columns",
    "style_header", "set_number_format", "add_title", "sec_title", "mark_input",
    "mark_formula", "mark_link", "add_source_note", "col_letters", "font_",
    "Font", "PatternFill", "Alignment", "Border", "Side", "Comment",
    "get_column_letter", "column_index_from_string",
]

# 与 uniai-docx 同一套主题色，两个技能出的文档放在一起才像一家人
THEMES = {
    "navy":   {"accent": "1F4E79", "tint": "EAF1F8", "name": "藏青·通用首选"},
    "green":  {"accent": "1E5C40", "tint": "E8F2EC", "name": "墨绿·金融审计"},
    "teal":   {"accent": "0F766E", "tint": "E5F2F0", "name": "青碧·科技数据"},
    "ochre":  {"accent": "9A3412", "tint": "FAEEE7", "name": "赭石·消费文教"},
    "gray":   {"accent": "404040", "tint": "F2F2F2", "name": "深灰·极简中性"},
}
INK = "1F2937"       # 正文墨色，别用纯黑
MUTED = "595959"     # 副题、注释
LINE = "D9D9D9"      # 细边框
ZEBRA = "F7F8FA"     # 隔行底色

FMT = {
    "money": "#,##0",
    "money2": "#,##0.00",
    "money_neg": "#,##0;(#,##0);-",     # 负数括号、零显示为 -
    "percent": "0.0%",
    "percent0": "0%",
    "int": "#,##0",
    "date": "yyyy-mm-dd",
    "text": "@",
}

CJK = re.compile(r"[㐀-鿿豈-﫿　-〿＀-￯]")
DEFAULT_FONT = "微软雅黑"


def col_letters(cols):
    """'BC' / ['B','C'] / [2,3] 统一成 ['B','C']。"""
    if isinstance(cols, str):
        return list(cols)
    return [c if isinstance(c, str) else get_column_letter(c) for c in cols]


def font_(size=10.5, bold=False, color=INK, name=DEFAULT_FONT):
    """字体工厂——推荐用于 xlsx_helpers 体系外的字体设置。"""
    return Font(name=name, size=size, bold=bold, color=color)


_font = font_  # 内部兼容，别在生成脚本中调用


# --- 写入 -------------------------------------------------------------------
def add_title(ws, title, subtitle=None, row=1, span=6, theme="navy"):
    """报表标题区：标题 14-16pt 加粗 + 副题灰字，与数据区空一行。"""
    t = THEMES[theme] if isinstance(theme, str) else theme
    ws.cell(row=row, column=1, value=title).font = font_(15, True, t["accent"])
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=max(2, span))
    ws.cell(row=row, column=1).alignment = Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[row].height = 26
    if subtitle:
        ws.cell(row=row + 1, column=1, value=subtitle).font = font_(9, False, MUTED)
        ws.merge_cells(start_row=row + 1, start_column=1,
                       end_row=row + 1, end_column=max(2, span))
        ws.row_dimensions[row + 1].height = 16
    return ws


def sec_title(ws, row, text, first_col=1, last_col=None, theme="navy"):
    """数据区副标题（不加合并单元格，只加粗+浅底色），避免触发 MERGED_IN_DATA。

    用法示例：
        sec_title(ws, 14, "📊 支出预算", first_col=1, last_col=7, theme='navy')
    """
    t = THEMES[theme] if isinstance(theme, str) else theme
    last_col = last_col or ws.max_column
    cell = ws.cell(row=row, column=first_col, value=text)
    cell.font = font_(10.5, bold=True)
    cell.fill = PatternFill("solid", fgColor=t["tint"])
    cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=False)
    ws.row_dimensions[row].height = 18
    # 右侧同列填底色保持视觉一致
    for c in range(first_col + 1, last_col + 1):
        ws.cell(row=row, column=c).fill = PatternFill("solid", fgColor=t["tint"])
    return ws


def write_table(ws, header, rows, start_row=1, start_col=1):
    """写表头 + 数据。返回 (header_row, first_data_row, last_data_row)。

    自动识别第一列是否为序号列（表头含'序号'/'NO'/'编号'/'No'），
    若是则自动设右对齐+整数格式，无需手动传 money_cols。
    """
    # 检测序号列（表头第一列含这些关键字之一即认为是序号列）
    first_header = str(header[0]).strip() if header else ""
    is_seq = any(kw in first_header.lower() for kw in ["序号", "no.", "no ", "编号", r"no\d"])

    for j, name in enumerate(header):
        cell = ws.cell(row=start_row, column=start_col + j, value=name)
        if is_seq and j == 0:
            cell.alignment = Alignment(horizontal="center", vertical="center")
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            cell = ws.cell(row=start_row + 1 + i, column=start_col + j, value=v)
            # 序号列：居中 + 整数格式
            if is_seq and j == 0 and isinstance(v, (int, float)):
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.number_format = "0"
    return start_row, start_row + 1, start_row + len(rows)


def add_total_row(ws, first_row, last_row, cols, label_col="A", label="合计",
                 row=None, theme=None, percent_cols=()):
    """合计行——**写公式，不写算好的数**。返回合计行行号。

    样式有两种方式（不要混用）：
    - **方式 B（推荐）**：不传 theme，合计行样式由 style_table(total_row=返回值) 统一刷
    - **方式 A**：传入 theme='navy'，add_total_row 自己刷 bold + 浅底（style_table 需传 total_row=None）
    percent_cols: 传入需要计算合计占比的列（如 'C'），合计行自动生成 =SUM(Cfirst)/SUM(Ctotal) 公式，
    用于"合计占总体的百分比"场景（如收入结构表，合计行显示 100%）。
    """
    row = row or last_row + 1
    ws.cell(row=row, column=column_index_from_string(label_col), value=label)
    for c in col_letters(cols):
        ws[f"{c}{row}"] = f"=SUM({c}{first_row}:{c}{last_row})"
    # 合计占比：合计行 / 合计行自身 = 100%，用 IFERROR 避免除零
    for c in col_letters(percent_cols):
        total_ref = f"{c}{row}"
        ws[f"{c}{row}"] = f"=IFERROR({c}{first_row}/{total_ref},\"\")"
    if theme:
        t = THEMES[theme] if isinstance(theme, str) else theme
        last_col = ws.max_column
        for c in range(1, last_col + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = font_(10.5, bold=True)
            cell.fill = PatternFill("solid", fgColor=t["tint"])
        ws.row_dimensions[row].height = 18
    return row


def style_table(ws, header_row, first_row, last_row, theme="navy",
                first_col=1, last_col=None, money_cols=(), percent_cols=(),
                text_cols=(), date_cols=(), total_row=None, zebra=None,
                freeze=True, font_size=10.5, row_height=18,
                seq_col=None,
                **unexpected_kwargs):
    """一次把表做完：表头着色、数字格式、对齐、细边框、斑马纹、冻结、合计行加粗。

    **按列判定对齐**——公式单元格的值是字符串，按单元格类型判会漏掉整个合计行。

    total_row 指定哪一行是合计行（bold + 浅底），可以超出 last_row 范围（如 add_total_row
    创建的新行），样式循环会自动扩展到 max(last_row, total_row)。

    seq_col: 序号列列号（默认=first_col），对齐不覆盖，由 write_table 负责设置 center。
    """
    if unexpected_kwargs:
        import warnings
        unknown = list(unexpected_kwargs.keys())
        warnings.warn(
            f"style_table 未知参数已忽略（静默失效）：{unknown}。"
            f"有效参数：header_row, first_row, last_row, theme, first_col, last_col, "
            f"money_cols, percent_cols, text_cols, date_cols, total_row, zebra, freeze, "
            f"font_size, row_height, seq_col。",
            UserWarning
        )
    t = THEMES[theme] if isinstance(theme, str) else theme
    last_col = last_col or ws.max_column
    if zebra is None:
        zebra = (last_row - first_row + 1) > 7
    seq_col = seq_col if seq_col is not None else first_col  # 默认=first_col（write_table 的序号列）

    style_header(ws, header_row, first_col, last_col, theme)
    set_number_format(ws, money_cols, "money", first_row, total_row or last_row)
    set_number_format(ws, percent_cols, "percent", first_row, total_row or last_row)
    set_number_format(ws, text_cols, "text", first_row, total_row or last_row)
    set_number_format(ws, date_cols, "date", first_row, total_row or last_row)

    # 自动推断：有公式的列 → 右对齐/百分比格式；有纯数字的列 → 右对齐
    # 注意：纯数字列（如"计划月数"）没有公式但仍是数值，必须右对齐
    auto_right = set()
    auto_percent = set()
    for c in range(first_col, last_col + 1):
        letter = get_column_letter(c)
        has_formula = False
        has_numeric = False
        for r in range(first_row, (total_row or last_row) + 1):
            v = ws.cell(row=r, column=c).value
            if v is None:
                continue
            if isinstance(v, str) and v.startswith('='):
                has_formula = True
                # 包含除法/百分号的公式 → 百分比列
                if '/' in v.upper() and '%' not in v:
                    auto_percent.add(letter)
                else:
                    auto_right.add(letter)
                break
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                has_numeric = True
        # 纯数字列（非序号列）也右对齐（如"计划月数"、"数量"等）
        if not has_formula and has_numeric and letter not in {get_column_letter(seq_col)}:
            auto_right.add(letter)
    right = set(col_letters(money_cols)) | set(col_letters(percent_cols)) | auto_right
    percent_auto = set(col_letters(percent_cols)) | auto_percent
    center = set(col_letters(date_cols))
    thin = Side(style="thin", color=LINE)
    # total_row 可能超出 last_row（如 add_total_row 创建的新行），样式循环须覆盖到
    end_row = max(last_row, total_row or 0)

    # 对自动推断的列补充数字格式
    if auto_right:
        set_number_format(ws, list(auto_right), "money", first_row, end_row)
    if auto_percent:
        set_number_format(ws, list(auto_percent), "percent", first_row, end_row)

    for r in range(first_row, end_row + 1):
        ws.row_dimensions[r].height = row_height
        is_total = total_row is not None and r == total_row
        for c in range(first_col, last_col + 1):
            letter = get_column_letter(c)
            cell = ws.cell(row=r, column=c)
            cell.font = font_(font_size, bold=is_total)
            cell.border = Border(bottom=thin)
            # 序号列由 write_table 设 center，style_table 不覆盖它的对齐
            if c == seq_col:
                continue
            if letter in right:
                align = "right"
            elif letter in center:
                align = "center"
            else:
                align = "left"
            cell.alignment = Alignment(horizontal=align, vertical="center",
                                       wrap_text=False)
            if is_total:
                cell.fill = PatternFill("solid", fgColor=t["tint"])
            elif zebra and (r - first_row) % 2 == 1:
                cell.fill = PatternFill("solid", fgColor=ZEBRA)
    if freeze:
        ws.freeze_panes = f"A{header_row + 1}"
    return ws


def set_number_format(ws, cols, fmt, first_row, last_row):
    """整列设数字格式。fmt 用 FMT 里的键或原始格式串。"""
    fmt = FMT.get(fmt, fmt)
    for c in col_letters(cols):
        for r in range(first_row, last_row + 1):
            ws[f"{c}{r}"].number_format = fmt
    return ws


# --- 样式 -------------------------------------------------------------------
def style_header(ws, row, first_col=1, last_col=None, theme="navy", height=22):
    t = THEMES[theme] if isinstance(theme, str) else theme
    last_col = last_col or ws.max_column
    for c in range(first_col, last_col + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = font_(11, True, "FFFFFF")
        cell.fill = PatternFill("solid", fgColor=t["accent"])
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = height
    return ws


def autofit_columns(ws, min_width=8, max_width=48, padding=2.5):
    """按内容估列宽——中文按 2 倍宽算，不裁字也不留大片空白。"""
    # 合并单元格（标题区）不能参与列宽估算，否则一个长标题会把 A 列撑到几十字符宽
    merged = {coord for rng in ws.merged_cells.ranges for coord in rng.coord.split(":")}
    merged |= {c.coordinate for rng in ws.merged_cells.ranges for row in rng.cells
               for c in [ws.cell(row=row[0], column=row[1])]}

    widths = {}
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None or cell.coordinate in merged:
                continue
            text = str(cell.value)
            if text.startswith("="):
                text = "0" * 12          # 公式按结果宽度估，别按公式串长度
            w = sum(2 if CJK.search(ch) else 1 for ch in text)
            letter = get_column_letter(cell.column)
            widths[letter] = max(widths.get(letter, 0), w)
    for letter, w in widths.items():
        ws.column_dimensions[letter].width = max(min_width, min(max_width, w + padding))
    return ws


# --- 财务模型配色（行业惯例） -----------------------------------------------
def mark_input(cell, note=None):
    """蓝字 = 硬编码输入/假设。附来源批注是硬要求。"""
    cell.font = Font(name=DEFAULT_FONT, size=10.5, color="0000FF")
    if note:
        add_source_note(cell, note)
    return cell


def mark_formula(cell):
    cell.font = Font(name=DEFAULT_FONT, size=10.5, color="000000")
    return cell


def mark_link(cell, external=False):
    """绿字 = 同簿跨表引用；红字 = 外部文件引用。"""
    cell.font = Font(name=DEFAULT_FONT, size=10.5,
                     color="FF0000" if external else "008000")
    return cell


def add_source_note(cell, text, author="skill", **kwargs):
    """单元格批注（单细胞）。kwargs 兼容旧版签名（first_col/last_col 等会被忽略）。"""
    if kwargs:
        import warnings
        warnings.warn(f"add_source_note 未知参数已忽略：{list(kwargs.keys())}。", UserWarning)
    cell.comment = Comment(text, author)
    return cell
