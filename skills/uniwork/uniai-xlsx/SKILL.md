---
name: uniai-xlsx
description: "创建、读取、编辑和修复 Excel、CSV 电子表格."
version: "1.0.0"
author: "UniWork"
license: Proprietary. LICENSE.txt has complete terms
platforms: [linux, macos, windows]
tags: [Excel, CSV, 表格]
metadata:
  OpenAgent: "📊"
  runtime: '{"os":["linux","darwin","win32"],"bins":[]}'
---

# Excel / 电子表格

**一句话选型：分析/重塑/CSV 用 pandas；要保留公式/样式/多表/合并单元格/模板保真用 openpyxl。**

安装：uv pip install openpyxl pandas || python -m pip install openpyxl pandas

---

## ⚠ 必然返工检查线（写代码前必过）

违反以下任一条，check_xlsx 必有 ERROR，交付前必须全部通过。

| # | 规则 | 错例 |
|---|------|------|
| A1 | 编辑文件用 `load_workbook` 时**禁止** `data_only=True`（会清空公式） | `load_workbook(f, data_only=True)` |
| A2 | `write_table → 写派生公式 → style_table → mark_input → **不许再动字体**` | 在 style_table 之后又调了 style_header |
| A3 | 合计/占比/差额等派生值写**公式字符串**，不写 Python 算好的数字 | `ws['B10'] = sum(data)` ❌ |
| A4 | 数字列（money / percent）必须**右对齐 + 设数字格式** | 左对齐或无格式 → NUM_ALIGN |
| A5 | 含中文的格用 `font_()`；禁止调用 `_font()` | 串码 → CJK_FONT；`_font` 未在 `__all__` 中导出，`from xlsx_helpers import *` 不会带入，调用会 NameError |
| A6 | `style_table` 调用前必须有 `# 列映射确认：`注释，标明每列对齐方式 | 无注释 → 代码不合格 |
| A7 | 一个 sheet 只用一个 theme（navy/teal/green/ochre/gray），禁止混用；**所有函数都要显式传 theme=**，省略默认 navy，等于混用 | 混用 → MULTI_ACCENT（ERROR）|
| A8 | 数据区**尽量避免** merge_cells（用 `sec_title()` 代替） | 合并 → MERGED_IN_DATA（WARN）|
| A9 | `check_xlsx.py` 必须 0 ERROR；`recalc.py` 返回 `errors_found` 必须修，`no_soffice` 可接受（告知用户用 Excel/WPS 打开会自动重算） | 有 ERROR → 返工 |
| A10 | 公式里引用 `add_total_row` / `add_title` / `write_table` 返回的合计行时，**建议用变量代入**（`=$C$9` 绝对引用是合法的，不强制） | `=C{exp_total}/$C${income_total}` ✅（推荐）；`=$C$9` ✅（可接受） |
| A11 | 注释里的行号描述（如 `# 支出合计第19行`）要与实际行号一致；优先用返回变量而非硬编码数字 | 注释写的是第9行，实际在第11行 → 行号偏移错误 |

---

## Layer 1 · 生成前必读（每次都要过）

> 本层是高频规则的精简版，对照本层检查通过后再开始写代码。
> **ERROR** = 必须修复；**WARN** = 建议修复；**INFO** = 正常提示。

### 0. 明确工作模式

| 需求 | 用什么 |
|---|---|
| 读值、做分析、CSV 互转 | pandas |
| 保公式/样式/多表/模板保真 | openpyxl |
| 编辑既有文件 | load_workbook → 改 → save，禁止 data_only=True（会毁公式） |

### 0.5 生成前检查清单（写代码前必过）

> ⚠️ **飞行员起飞前清单**：写代码前先逐项确认，**不要生成完再修**。
>
> 开始写代码前，在对话里回复以下确认（只需回复字母），才算正式启动：
>
> **派生值专项**（最容易出错的地方）
> - 你要写的表中，有**合计/占比/配置比例/增速**这些列吗？有的说"有"，没有的说"无"。
> - 如果有，**占比列写的是公式字符串**（`='=<金额列>/<$金额列>$<合计行>'`）还是 Python 数字（`0.3`）？确认写的是公式。
>
> **数字列专项**
> - 所有金额/百分比列都传进了 `money_cols` / `percent_cols` 吗？确认传了。
>
> **回答完以上问题后，才开始写代码。** 没有确认就下笔，100% 会触发 HARDCODED_DERIVED / NUM_ALIGN 返工。

- [ ] **数字列**：所有金额/百分比列都传进了 `money_cols` / `percent_cols`
- [ ] **派生值**：合计/差额/占比/配置比例/增速写的是 `=SUM(...)` 公式，不是 Python 算好的数字
  - ❌ `ws['<占比列>'] = 0.30`（硬编码比例）
  - ✅ `ws['<占比列>'] = '=<金额列>/<$金额列>$<合计行>'`（公式，引用合计格）
  - ❌ `ws['<占比列>'] = 0.25`（硬编码）
  - ✅ `ws['<占比列>'] = '=<金额列>/<$金额列>$<合计行>'`（以此类推）
- [ ] **副标题**：数据区分组标题用 `sec_title()`，不用 `merge_cells`
- [ ] **字体**：用 `font_()` 公开函数，不用 `_font()` 内部函数
- [ ] **列映射**：`style_table()` 调用前有列映射注释
- [ ] **theme**：`add_title / sec_title / style_table / style_header` 全部显式传同一个 `theme=`值（这些函数默认 `theme='navy'`，省略参数等于引入 navy）
  - ❌ `add_title(ws, '标题', span=7)` + `style_table(..., theme='teal')` → navy+teal 混用 → MULTI_ACCENT ERROR
  - ✅ `add_title(ws, '标题', span=7, theme='teal')` + `style_table(..., theme='teal')` → 纯 teal
- [ ] **IDE 操作**：禁止用「全局替换 / Rename Symbol / Refactor」功能修改从 `xlsx_helpers` 导入的名称（如把 `Font` 改成 `MyFont`），这会悄悄破坏 `from xlsx_helpers import *` 的导入链

---

### 1. 执行顺序（违反必埋错）

write_table → 立即写派生值公式 → style_table → mark_input（输入格标蓝）→ 绝对不再调任何覆盖字体的函数

**mark_input 必须紧跟在 style_table 之后调用**，因为 style_table 会把字体统一设成黑色，mark_input 的蓝色必须最后覆盖。

style_table 之后**尽量避免** merge_cells（MERGED_IN_DATA 现为 WARN，不强制）；如需副标题，用 `sec_title()` 代替。

> ⚠️ **禁止在 style_table 之后再调用任何会覆盖 `cell.font` 的函数**（如再次 style_table、style_header 等），否则 mark_input 的蓝色会被覆盖丢失。

---

### 2. 派生值——公式字符串，不是数字

| 场景 | 写法 |
|---|---|
| 合计 / 累计 | `ws['<$金额列>$<合计行>'] = '=SUM(<金额列>首:<金额列>尾)'` |
| 差额 | `ws['<差数列>'] = '=<被减数列>-<减数列>'` |
| 比例 / 占比 | `ws['<占比列>'] = '=IF(<金额列>=0,"",<金额列>/<$金额列>$<合计行>)'` |
| 配置比例（各仓位/合计） | `ws['<占比列>'] = '=<金额列>/<$金额列>$<合计行>'`，**禁止写死 0.30** |
| 增速 / 涨幅 | `ws['<增速列>'] = '=IF(<上期列>=0,"",(<本期列>-<上期列>)/<上期列>)'` |
| 独立假设格（用户可改） | `ws['<输入格>'] = 0.30` + `mark_input(ws['<输入格>'])` + `ws['<占比列>'] = '=<$输入格>$'` |

**常见错误：资产配置表/权重表里写了 `0.30`、`0.25` 等硬编码比例**——这类值必须写成 `=<金额列>/<$金额列>$<合计行>` 公式。

禁止：`ws['<占比列>'] = 0.30`（硬编码比例）、`ws['<合计格>'] = sum(data)`（Python 硬算好再写 int/float 进单元格）。

表头触发词替用：增长率→涨幅/增速/增幅；占比→比例/份额；毛利→毛额/收益额。

> ⚠️ 派生列的用户输入（如独立假设格 0.30）必须用 `mark_input(cell)` 标记蓝色，check_xlsx 会跳过蓝字格，不报 HARDCODED。
**自动推断**：style_table 会自动扫描数据区的公式单元格——有公式的列默认右对齐+数字格式，漏传 `money_cols` 也不再报 NUM_ALIGN。
---

### 3. 数字列——显式右对齐

数字列（含公式格 '=' 字符串）必须：number_format + alignment = Alignment(horizontal='right')。

推荐用 style_table(ws, ..., money_cols='AB', percent_cols='CDE')，它按列判定而非按单元格类型。

禁止：左对齐、默认对齐（默认是左对齐）。

---

### 4. 字体——含中文的格用 font_(size, bold, color, name) 公开函数

```python
# ✅ 正确：直接写中文单元格时，用 font_() 工厂函数
from xlsx_helpers import font_
ws['A1'] = '建议配置'
ws['A1'].font = font_(bold=True)              # 默认：微软雅黑、10.5pt、墨色
ws['A1'].font = font_(15, True, accent)      # 标题用：更大更粗

# ❌ 禁用：直接用 Font() 需重复写 name='微软雅黑'
ws['A1'].font = Font(name='微软雅黑', size=10.5, bold=True)  # 冗长

# ❌ 禁用：_font 是内部别名，未在 __all__ 中导出，from xlsx_helpers import * 不会带入
ws['A1'].font = _font(bold=True)   # NameError！
# ✅ 正确：
ws['A1'].font = font_(bold=True)
```
> `style_table` / `style_header` 等高层函数内部已统一使用微软雅黑，开发者只需对不在这些函数覆盖范围内的单元格（如标题区副标题）自行设置字体。

---

### 5. 列映射注释——style_table 调用前必须有

```python
# 列映射确认：
# A=序号(数字右对齐) B=金额(右对齐) C/D=比例(右对齐) E=差额(右对齐)
# F/G=文本(左对齐)
style_table(ws, ..., money_cols='ABCDE', percent_cols='CD', text_cols='FG')
#                                      ↑ 有没有遗漏的数字列 ↑
```
标准格式：`# 列映射：A=序号(右对齐) B=名称(左对齐) C=金额(右对齐)`

没有这行注释 = style_table 调用不完整 = 代码不合格。

---

### 6. theme——一个 sheet = 一个 accent color

五选一（政企/金融/科技/消费/极简）：navy / teal / green / ochre / gray

禁止：同一 sheet 按数据区混用两种 theme（报 MULTI_ACCENT）。

---

### 7. 数据区——零 merge_cells

merge_cells 只在标题行（第一行）。副标题用 `sec_title()` 或直接写值不合并。

```python
# ✅ 推荐：sec_title() 不触发 MERGED_IN_DATA
sec_title(ws, 14, "📊 支出预算", first_col=1, last_col=7, theme='navy')

# ❌ 禁止：数据区 merge_cells（触发 MERGED_IN_DATA）
ws.merge_cells('A14:G14')
```add_title('') 禁止。

---

### 8. 交付前双闸门

```bash
python scripts/check_xlsx.py  out/report.xlsx   # 0 ERROR 才能交付
python scripts/check_xlsx.py  out/report.xlsx --fast   # 只查 ERROR（快速模式，开发迭代时用）
python scripts/recalc.py      out/report.xlsx   # status ≠ success → 按下表处理
```

| recalc status | 动作 |
|---|---|
| success | 交付 |
| errors_found | 按 locations 修复，重算 |
| not_recalculated | 别当零错误，走兜底（见 Layer 2） |
| no_soffice | 告知用户用 Excel/WPS 打开会自动重算 |

check_xlsx 查：派生值硬编码 / 数字列左对齐 / 数据区合并 / CJK 字体 / 强调色混用 / 裸表头 / 列宽裁字。

---

### 9. Windows 路径陷阱

C:\Users 的 \U 是 unicode escape，写进 python -c 会 SyntaxError。

```bash
# ❌ python -c "wb = load_workbook('C:\Users\<username>\file.xlsx')"
# ✅ python -c "wb = load_workbook(r'C:\Users\<username>\file.xlsx')"
# ✅ python -c "wb = load_workbook('C:/Users/13535/file.xlsx')"
```

---

## Layer 2 · 详细参考（按需查阅）

### 核心代码模式

从零建表（推荐路径）：
> **合计行样式两种方式（不要混用）**：
> - **方式 B（推荐）**：`add_total_row(cols, theme 不传)` + `style_table(total_row=...)` — 样式统一由 style_table 管控
> - **方式 A**：`add_total_row(cols, theme='navy')` + `style_table(total_row=None)` — 合计行样式由 add_total_row 自己管
>
```python
import sys; sys.path.insert(0, '<skill_dir>/scripts')
from openpyxl import Workbook          # Workbook 是 openpyxl 内置类，直接导入
from xlsx_helpers import *

wb = Workbook(); ws = wb.active
add_title(ws, '标题', '副标题', span=4)           # 标题行合并（4列）
h, f, l = write_table(ws, ['序号','名称','金额','占比'], rows, start_row=3)
# write_table 会自动识别第一列为序号列（表头含"序号"），自动设 center + 整数格式
# ... 此时只写数据值，不写派生值公式 ...
# ① 先写派生值公式（<> 内为占位符，替换为实际列名）
ws['<$C>$<合计行>'] = '=SUM(<C>首:<C>尾)'          # 合计（金额列）
ws['<D>'] = '=IF(<C>=0,"",<C>/<$C>$<合计行>)'    # 占比（金额/合计）
# ② add_total_row（在 style_table 之前创建合计行，不传 theme）
income_total = add_total_row(ws, first_row=f, last_row=l,
                             cols='<C>', label_col='A',
                             label='收入合计')
# ③ style_table（total_row=income_total 由 style_table 统一刷样式）
# 列映射：A=序号(居中) B=名称(左对齐) C=金额(右对齐) D=占比(右对齐)
style_table(ws, header_row=h, first_row=f, last_row=l,
            money_cols='<C>', percent_cols='<D>', theme='navy',
            total_row=income_total)
# ④ 用户输入格标蓝（必须在 style_table 之后，style_table 会覆盖字体）
mark_input(ws['K4'])   # 独立假设格（如配置比例 0.30）
mark_input(ws['B5'])
autofit_columns(ws)
wb.save('output.xlsx')
```

编辑既有文件：
```python
wb = load_workbook('existing.xlsx')
ws = wb['Sheet1']
ws.insert_rows(2)
# 不要用 data_only=True 保存（会毁公式）
wb.save('modified.xlsx')
```

pandas 读取：
```python
import pandas as pd
df = pd.read_excel('file.xlsx', dtype={'id': str}, usecols=[0,1,2])
```

---

### 财务模型配色惯例

| 颜色 | 含义 |
|---|---|
| 蓝字 0000FF | 硬编码输入 / 用户改的情景假设 |
| 黑字 | 所有公式与计算 |
| 绿字 008000 | 同簿跨表引用 |
| 红字 FF0000 | 外部文件引用 |
| 黄底 FFFF00 | 关键假设，关注栏 |

配套函数：mark_input(cell, note='来源：年报') / mark_formula(cell) / mark_link(cell, external=True)。

---

### 美观默认（模板未约定时）

- 强调色五选一：藏青 1F4E79 / 墨绿 1E5C40 / 青碧 0F766E / 赭石 9A3412 / 深灰 404040；配套浅底 EAF1F8 / E8F2EC / E5F2F0 / FAEEE7 / F2F2F2
- 字号：正文 10-11pt / 表头 11pt 加粗 / 标题 14-16pt
- 边框：表头下框线 + 隔行浅灰底 F2F2F2；禁全黑粗网格
- 对齐：文本左 / 数字右 / 表头居中
- 列宽：中文字符约 2 倍宽估算，不裁字；长文本 wrap_text=True
- 冻结：freeze_panes = 'A2'
- 数字格式：金额 #,##0 / 百分比 0.0% / 零显示 -：'#,##0;(#,##0);-'

---

### check_xlsx 问题等级对照表

| 代码 | 等级 | 原因 | 修复 |
|---|---|---|---|
| HARDCODED_DERIVED | **ERROR** | 合计/比例等写了 int，没写公式 | ws['X'] = '=SUM(...)' 替换 ws['X'] = int |
| NUM_ALIGN | **ERROR** | 数字列/公式格默认左对齐 | style_table 自动推断，一般不需手动修 |
| MERGED_IN_DATA | WARN | 数据区有合并单元格 | 推荐用 `sec_title()` 代替，不强制 |
| NOT_RECALCULATED | INFO | 无 LibreOffice，公式未缓存 | 用 Excel/WPS 打开自动计算，正常 |
| NO_COL_WIDTH | INFO | 列宽未设置 | 不影响公式计算，可忽略 |
| COL_TOO_NARROW | **WARN** | 列宽过窄，内容被裁掉 | `autofit_columns(ws)` 或手动加宽 |
| NO_FREEZE | INFO | 未冻结窗格 | 不影响公式计算，可忽略 |
| SEQ_ALIGN | INFO | 序号列不是居中对齐 | write_table 自动设 center，如需修复检查 style_table 调用 |
| CJK_FONT | 含中文格用了 Arial/Calibri | Font(name='微软雅黑') 替换 |
| BARE_HEADER | **WARN** | 表头无底色也无加粗 | 加底色或加粗；不影响公式正确性 |
| FORMULA_ERROR | 公式含 #VALUE! 等 | 查公式逻辑，特别是 IF 嵌套和除零 |
| FORMULA_HARDCODE_ROW | **WARN** | 公式引用了 SUM 行但用了硬编码行号 | 建议用 add_total_row 变量代入；`=$C$9` 绝对引用合法 |
| MULTI_ACCENT | **ERROR** | 超过 2 种非中性强调色（说明不同 theme 混用了） | 全 sheet 锁死一个 theme，add_title/sec_title/style_table 全部显式传同一个 theme= |

---

### recalc 兜底（无 LibreOffice 时）

recalc.py 有两种失败模式，处置方式不同：

| status | 含义 | 处置 |
|---|---|---|
| `no_soffice` | LibreOffice 未安装 | 告知用户用 Excel/WPS 打开会自动重算 |
| `not_recalculated` | soffice 跑了但公式未缓存（失败） | **不要当零错误**——检查公式是否有 #VALUE! 等错误，或切方案（交付静态快照） |

二选一：① 交付文件并告知用 Excel/WPS 打开会自动重算 ② 在 Python 侧算好写成静态值（HARDCODED_DERIVED 允许），并注明是静态快照。

禁止：假装重算成功了。

---

### 关键坑提醒

1. 公式格是字符串：isinstance(cell.value, (int,float)) 对公式格为假。style_table 按列判断（money_cols / percent_cols），不要按单元格类型判。
2. data_only=True 保存会毁公式：用于读取可以，保存时禁止。
3. 中文弯引号和 Python 单双引号混用：统一外层单引号 ws['A1'] = '产品："稳健型"'。
4. 列宽裁字：中文字符宽约等于 2 个 ASCII，用 `autofit_columns(ws)` 或手动按 content 估。**必须在最后调用**（style_table 之后），且不能替代所有手动调整。
5. 日期是序列号：设好 number_format 才显示为日期，否则是数字。
6. add_source_note 只接受单细胞：`add_source_note(ws['A1'], '说明')`，不是多行文本。
7. check_xlsx 不能覆盖的问题：列宽是否合理（COL_TOO_NARROW 是估算）、文字是否通顺、表格逻辑是否正确。

---

### DERIVED_WORDS 替用对照

| 触发词 | 替用 |
|---|---|
| 增长率 | 涨幅、增速、增幅 |
| 占比 | 比例、份额、比重 |
| 毛利 | 毛额、收益额 |
| 合计/总计/小计/累计/平均 | 替用词如汇总、合计额 |

---

### Layer 2 目录

- scripts/xlsx_helpers.py — 完整 API：
  - **表格构建**：write_table / style_table / add_title / sec_title / add_total_row / style_header / set_number_format / autofit_columns
  - **标记**：mark_input / mark_formula / mark_link / add_source_note(cell, text)
  - **字体/颜色**：font_ / Font / THEMES / FMT / INK / MUTED / LINE / ZEBRA
  - **工具**：col_letters / get_column_letter / column_index_from_string
  - **openpyxl 重导出**：PatternFill / Alignment / Border / Side / Comment
  - write_table：自动识别序号列并设 center + 整数格式
  - add_total_row：percent_cols 参数自动生成合计占比公式
  - **不要直接调用 `_font`**（内部别名，用 `font_` 代替）
- scripts/check_xlsx.py — 交付前自检（ERROR = 返工）
- scripts/recalc.py — LibreOffice 重算 + 错误扫描
- scripts/selftest.py — 不依赖 LibreOffice 的自检
- CHANGELOG.md — 版本记录
