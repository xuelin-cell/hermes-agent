---
name: uniai-docx
description: "读取、创建和编辑需要专业排版的 Word 文档."
version: "1.0.0"
author: "UniWork"
license: Complete terms in LICENSE.txt
platforms: [linux, macos, windows]
tags: [Word, DOCX, 文档]
metadata:
  OpenAgent: "📝"
  runtime: '{"os":["linux","darwin","win32"],"bins":[]}'
---

# DOCX 文档

用 `python-docx` 做结构化创建与编辑，用 `scripts/docx_helpers.py` 保证排版，
用 `scripts/check_docx.py` 自检，用 `scripts/render_docx.py` 做**视觉复检**——
版式类文档“看起来对”才算对，抽文字对不够。

安装：`uv pip install python-docx pdf2image || python -m pip install python-docx pdf2image`
（渲染另需 LibreOffice + Poppler；缺了不影响生成，只影响复检——见下“复检”）

## Layer 1 · 生成前必读（每次都要过）

> 本层是高频规则的精简版，对照本层检查通过后再开始写代码。本层所有规则均为 ERROR 级，违反任一条 = 交付失败，必须修复。

### 1. 必须用 docx_helpers，禁止裸写 python-docx

裸写四个必然翻车的坑已封装进 helper，详见 Layer 2。

### 2. 标题必须用 Heading 样式，禁止加粗冒充

`doc.add_heading('一、总体情况', level=1)` 是唯一正确写法。
"手动加粗 + 放大普通文字" = `FAKE_HEADING` ERROR。

### 3. 中文字体定义在样式上，不在 run 上

`apply_theme()` 一次配好全文字体。逐 run 设格式必然漏 `w:eastAsia`。

### 4. 生成脚本字符规范

- 中文引号用 `""` `''`，不用 ASCII `"` `'` → SyntaxError
- 正文长文本用三引号块或列表，不用字符串拼接
- 写完先 `python -m py_compile` 再跑（见工作流示例）

### 5. 表格宽度必须调 fit_table_to_page

Word 默认 autofit 会无视你的 `cell.width`。
`style_table` 默认已调；自己加的 `widths=` 参数要删干净。

### 6. 标签行用 `label=True`，数据行用 `label=False`（或省略）

| 首行性质 | 调用方式 | checker 行为 |
|---|---|---|
| **标签型首行**（项目名称、部门负责人意见、审批意见等） | `style_table(..., label=True)` | 验证首行有底色+加粗；无样式→**ERROR** |
| **纯数据型首行**（明细账、清单，第一行就是数据） | 省略 `label` 或 `label=False` | **不报**BARE_HEADER |

**`label=True` 时 `header` 自动为 True**（标签行必须有样式）；单独 `header=False` 仅控制样式，checker 按 `label` 语义验证。

### 7. 数字列必须右对齐

序号、金额、比例列：`style_table(..., align_right_cols=(0, 1, 2))`。
左对齐 = `NUM_ALIGN` ERROR。

### 8. 转换类任务：禁止改写原文

Excel→Word、台账等任务，"排得好看"不是删内容的理由。
用 `verify_source.py` 双向比对，退出码 0 才算过。

### 9. WARN 的意义是提示，不是交付拦截

| 级别 | 例子 | 含义 |
|---|---|---|
| **ERROR** | `BARE_HEADER`、`FAKE_HEADING`、`PLACEHOLDER` | 交付前必须修复 |
| **WARN** | `NUM_ALIGN`、`RUN_EASTASIA`、`NO_REPEAT_HEADER` | 建议修复；0 ERROR 时可带着交付 |
| **INFO** | `TABLE_TOO_WIDE`、`PAGE_ESTIMATE`、`EMPTY_LINES` | 几何估算或提示，渲染确认即可 |

### 10. 交付停止条件

**唯一停止条件：存在 ERROR。**

- 0 ERROR + 渲染可接受 = **直接交付**，不追求清零 WARN
- 有 ERROR = 必须修复，修复后重新跑 checker
- WARN 和 INFO 仅供人工复核参考，不拦截交付

---

## Layer 2 · 详细参考

### 三条硬规则

1. **必须用 `docx_helpers.py`，不要裸写 python-docx 的字体和表格。**
   裸写会踩四个必然的坑：默认页面是 US Letter 不是 A4；设字体时主题属性
   （`w:asciiTheme`/`w:eastAsiaTheme`）没清掉会覆盖你设的字体；新建 run 的 `rPr` 是 `None`，
   直接 `run._element.rPr.rFonts` 会抛异常；默认模板里唯一带边框的表样式是全黑网格的 Table Grid。
   这四条每一条都会让文档“看起来不对”，helper 已全部封装。
   **需要操作 XML 元素时**，从 `docx_helpers` 导入 `el` 函数：
   ```python
   from docx_helpers import el   # 不要自己写 _el 或 OxmlElement 片段
   cell._tc.append(el("w:tcH", val=str(int(3.0 * 567)), hRule="atLeast"))
   ```
   `_el` 是内部实现，`el` 是公开 API。
2. **标题必须用 Word 的 Heading 样式**：`doc.add_heading('标题', level=1)`（或 `p.style='Heading 1'`）。
   **不要用“手动加粗放大一段普通文字”冒充标题**——只有真 Heading 样式才有结构、能生成目录。
3. **格式定义在样式上，不在 run 上。** `apply_theme()` 一次定义 Normal / Heading 1-3 / Caption，
   全文生效且不会漏掉中文字体；**只有“破例”的文字才用 `set_font()` 单独调**（封面标题、图注、页码）。
   逐个 run 手工设格式 = 改一处要改几百处，且必漏 `w:eastAsia`。

## 工作流

```python
import sys; sys.path.insert(0, '<skill_dir>/scripts')
from docx_helpers import *

doc = new_document(theme='navy', preset='business')          # A4 竖版 + 样式 + 中文字体
# 内容是「看」不是「读」时：new_document(orientation='landscape', columns=2)
add_cover(doc, '2026 年上半年经营分析报告', '市场与运营中心',
          ['编制单位：XX 公司', '2026 年 8 月'])
start_body_section(doc, page_number=True, header_text='2026 年上半年经营分析报告')
add_toc(doc)                                                  # 长文（>5 节）才加

doc.add_heading('一、总体情况', level=1)
doc.add_paragraph('正文……')                                   # Normal 样式已配好，直接写

t = doc.add_table(rows=len(data), cols=4)
...填数据...
style_table(t, doc=doc, align_right_cols=(1, 2, 3))           # 细灰框 + 着色表头 + 斑马纹
add_figure(doc, 'tmp/chart.png', '核心业务贡献 54% 收入', source='公司财报')
doc.save('report.docx')
```

然后**必须**跑这两步：

```bash
python scripts/check_docx.py report.docx          # 规则自检，有 ERROR 就是返工
python scripts/render_docx.py report.docx --output_dir tmp/pages   # 渲染成图，眼睛看
```

`check_docx.py` 查的是“抽文字看不出、渲染出来一眼就丑”的问题：缺东亚字体、假标题、
空行排版、裸表头、黑网格、多强调色、行长失控、占位符残留、数字列左对齐、
直引号与乱码字符、表格/图片超出版心、页数粗估。**它不能替代看图**：真实分页、留白平衡、字体回退只有渲染页能暴露。

中间产物放 `tmp/`，成品写入 workspace，文件名语义化，收尾清理临时文件。

## 生成脚本别被字符卡死（最常见的返工，且发生在跑起来之前）

中文进 Python 源码有三个必踩的坑，**脚本还没碰到 python-docx 就 SyntaxError**：

1. **中文里的引号只用 “ ” 或 「 」，不要用 ASCII `"`。**
   写 `"随着国家"数据要素×"行动计划的深入推进"` 时，内层的 `"` 会把字符串提前闭合，
   Python 接着把后面的中文当标识符，报出来的却是
   `SyntaxError: invalid character '×' (U+00D7)` 或 `'、' (U+3001)`——
   **报错指的那个字符几乎从来不是真凶，真凶是它前面那对直引号。**
   中文里的单引号同理，用 ‘ ’ 不用 `'`。
2. **长中文正文写成三引号块或列表，不要一行行拼字符串。**
   `PARAS = ["……", "……"]`、整段用 `"""……"""`；正文越长，里面出现引号的概率越高，
   三引号块能兜住绝大多数情况。正文文本量大时，干脆写成独立的 `.txt` / `.json` 再读进来。
3. **写完先编译再跑**：`python -m py_compile tmp/gen_xxx.py`。一秒钟的事，
   能把这一类错误一次性挑干净，不用“改一行跑一次”。

```python
# 崩：内层直引号提前闭合字符串
doc.add_paragraph("随着国家"数据要素×"行动计划的深入推进，……")
# 对：中文引号用全角，正文本身也更规范
doc.add_paragraph("随着国家“数据要素×”行动计划的深入推进，……")
PARAS = [
    """第一段……""",
    """第二段，里面有“引号”也不怕。""",
]
```

编码一律显式 UTF-8（Windows 默认是 GBK，这些都是实打实会崩的）：

- `open(path, "w", encoding="utf-8")`——不写就是乱码或 `UnicodeDecodeError`；
- **别往 stdout 打 ✓ ✗ ⏎ 和 emoji**：GBK 编不出这些字，Windows 控制台上直接
  `UnicodeEncodeError` 中断脚本。要打勾用 √ ×（GBK 里有）或 `[OK]` `[X]`；
- 读 subprocess 输出时带 `encoding="utf-8", errors="replace"`。

**成品正文里的字符同样有规矩**：引号用 “ ”‘ ’，逗号顿号分号用全角，破折号用 ——，
省略号用 ……；不要用 ASCII `"`、`,`、`--`、`...`。完整对照表见
`references/design-taste.md` 第七节。`check_docx.py` 会报
`STRAIGHT_QUOTE`（直引号）、`HALF_PUNCT`（中文里的半角标点）、`MOJIBAKE`（乱码，ERROR）。
**转换类任务例外：原文什么样就什么样，不要顺手把源文件里的直引号“修”成全角**——
保真优先于排版，这三条报警在这类任务里确认过就行。

## 页面方向：竖版还是横版

**由内容性质决定，动笔前就定，不要中途翻转。**

| 内容是拿来… | 方向 | 典型 |
|---|---|---|
| **读**——连续文字为主 | 竖版（默认） | 公文、合同、报告、说明书、论文、方案 |
| **看**——并排比较、一屏概览 | 横版 | 汇报看板、多期间宽表、流程图/架构图/甘特图、投屏材料、图册 |

- **“表太宽”不是改横版的理由**。先改表：**转置**（指标做行、期间做列，中文表通常这样更顺）→
  合并或删列 → 拆成两张 → 表格字号降一档。都不行且必须保留全部列时，才让**这一张表**
  单独走横版节：`add_landscape_section(doc)` … `add_portrait_section(doc)` 切回。
- **横版正文必须分栏**：横版 A4 版心 24cm，12pt 一行 57 个字，没法读。
  `new_document(orientation='landscape', columns=2)`，单栏约 28 字。只放表和图的横版节不用分栏。
- 混排时页眉页脚会延续，页码不会重编——`check_docx.py` 会提示确认横版节之后切回了竖版。

## 表格宽度：Word 默认会忽略你设的列宽

**这是实测里最容易翻车的一条。** Word 表格默认 autofit，会**无视** `cell.width` 按内容
自行收缩——声明的列宽看起来完全正确，渲染出来表格只占半页宽、右边一大片空白。

所以填完数据后**必须**调 `fit_table_to_page(t, doc=doc)`（`style_table` 默认已经帮你调了）：
它会同时写 `w:tblLayout=fixed` + `w:tblW=100%` + `tblGrid` + 每个单元格宽度，四样缺一都会被 Word 改掉。

列宽默认**按各列内容量自动分配**（`auto_column_widths`，用 volume^0.65 压一下并保底最小宽），
不要平均分：实测里“工作进展”列装了全表 72% 的文字却只分到 25% 的宽度，
该列疯狂折行，把行高撑到占了三分之一页。`check_docx.py` 会报 `TABLE_AUTOFIT`、
`COLUMN_BALANCE`、`TABLE_UNDERFILL` 三条来兜住这类问题。

## Excel → Word 表格

```python
import openpyxl
ws = openpyxl.load_workbook(xlsx, data_only=True)['Sheet1']
g = lambda r, c: ('' if ws.cell(r, c).value is None else str(ws.cell(r, c).value).strip())
```

**照抄结构，不要“整理”结构**——这是实测里翻车最多的地方：

- **合并单元格要用 Word 的合并复现**，不是拍平。`openpyxl` 只在合并区左上角给值，
  其余是 `None`；对应到 Word 用 `t.cell(a,b).merge(t.cell(c,d))`。
  **先合并再写字**（先写后合会把两格文字拼在一起）。
  把“大类 + 子项”两列合成一列（`技术层面·整体`）**属于改结构**，不允许。
- **表头文字逐字照抄**。实测里把“需要协调解决问题”写成“需协调解决问题”——少一个字也是改内容。
- **标题原样搬**。把“XX周报（20260803-20260809）”拆成标题 + “报告周期：…”也是改写。
- **单元格内的换行是原文的一部分**，直接 `cell.text = 值` 即可（python-docx 会转成 `w:br`），
  **不要替换成空格**——联系人那种“姓名⏎电话”换成空格后就变了样。
- **不要照搬 Excel 的列宽**：Excel 列宽单位与 Word 无关，按内容量重新分配（见上一节）。
- 空 sheet、纯空列可以剔掉；有值的空单元格要保留（原表就是空的）。

### 交付前必须跑保真比对

```bash
python scripts/verify_source.py 源.xlsx 成品.docx --sheet Sheet1 --allow-extra
```

双向全量比对（表头、标题、页眉页脚、单元格内换行都算），退出码 0 才算过：

- **源里有、成品里找不到** → 漏内容或被改写（会提示“疑似被并入某格”，方便定位拍平结构）
- **只差空白/换行** → 单独列出，别当成一致
- **成品里有、源里没有** → 页码这类合法补充用 `--allow-extra` 放行，其余都要解释清楚

**别自己写个只比两列的脚本就宣布“全部一致”**——本技能就是这么栽的：
自查说 2359 字一字不改，实际表头少字、标题被拆、两级任务列被拍平、换行被吃掉，
四处改动全部漏检。

## 内容保真：转换类任务一个字都不能改

**硬规则**：Excel→Word、台账、周报、合同、公文这类**转换/整理**任务，
**禁止改写、缩写、删减、合并原文**。哪怕是为了“排得好看”或“压进一页”也不行——
用户要的是同一份内容换个载体，不是你的摘要版。

只有用户明确说“摘要 / 简报 / 提炼要点”时才做压缩，且要说清哪些内容被压了。

交付前用 `scripts/verify_source.py` 做**双向全量比对**（见下一节），
把“内容一致”当成和“无 ERROR”同级的检查项。

### 放不下怎么办：只调版面，按这个顺序

1. **方向**：内容宽 → 横版
2. **边距**：横版速览页可以收到 1.2–1.5cm（比正文文档紧）
3. **列宽按内容量分配**（`fit_table_to_page`）——最见效的一步，常常一步就够
4. **字号**：10.5 → 9.5 → 9 → 8.5，**下限 8pt，不许再小**
5. **行距**：1.2 → 1.15 → 1.1，单元格内边距同步收

实测参考：一份 2359 字的周报，横版 A4、边距 1.2cm、列宽按内容分配后，
8pt 占 0.69 页、9pt 占 0.87 页——**9pt 就能进一页**，不需要缩到 8pt。
先把列宽和边距调对，往往就不必动字号。

**五步都用尽还是放不下，就如实告诉用户**，给出选项：分两页 / 长文本拆到附录 /
由用户点头后删减。**不要自作主张删内容，也不要缩到 8pt 以下**——
实测里 8pt + 行距 1.05 那一版每行 90 个字，已经不能读了。

`check_docx.py` 的 `PAGE_ESTIMATE` 会给出“约几页 / 内容高度 ≈ 几个版心”
（用渲染实测标定过，误差约 ±15%），`PAGE_FILL` 会在内容不足六成页面时提醒。

## 渲染复检：这台机器上有什么就用什么

`render_docx.py` 自动挑后端，`--list-backends` 可以先看有哪些：

| 后端 | 安装成本 | 分页 | 说明 |
|---|---|---|---|
| `word` | 需装 Microsoft Word | ✓ | 保真度最高，排版就是 Word 自己算的（macOS 走 AppleScript / Windows 走 COM） |
| `soffice` | 装一次 LibreOffice | ✓ | 跨三平台，**推荐**：`brew install --cask libreoffice` / `apt-get install libreoffice` |
| `quicklook` | **零安装**（macOS 自带） | ✗ | 字体、配色、表格样式、留白都真实；但整篇连成一张长图，**分页、页码、跨页表头、页面方向、分栏都看不到**（横版节会被按竖版宽度平铺） |

PDF→PNG 优先用 **PyMuPDF**（`pip install pymupdf`，纯 wheel）；**装了它就不需要 Poppler**。

看 QuickLook 图时注意：分节符位置会显示成一个 `□`（QuickLook 的痕迹，不是文档缺陷）；
`NUMPAGES` 之类的域显示的是缓存值（“共 1 页”），Word 打开会更新；
**横版节在 QuickLook 里按竖版宽度平铺**——方向对不对只能靠 `check_docx.py` 或装 LibreOffice 验。

一个后端都没有时（退出码 2）：

1. **仍然要跑 `check_docx.py`**——只依赖 python-docx，任何环境都能跑，
   它的表格/图片超宽检查和页数粗估就是为这种情况准备的；
2. 用文本抽取做兜底核对；
3. **明确告诉用户版式未经渲染验证，建议本机用 Word 打开确认**。不要假装看过。

## 字体：只用两个平台都有的

预设默认 **黑体 + 宋体 + Times New Roman / Arial**——Windows 和 macOS 都有。
微软雅黑、Segoe UI 是 Windows 独有的，macOS 上会静默回退，同一份文档在两台机器上长相不同
（实测：标题会变成衬线体）。明确只在 Windows 交付时，可以传 preset 字典覆盖成雅黑。
公文预设的 `仿宋_GB2312` 是国标要求，本身就以 Windows 交付为准。

## 可选参数：主题与预设

`new_document(theme=..., preset=...)`

| theme | 强调色 | 适用气质 |
|---|---|---|
| `navy` 藏青·稳重 | `1F4E79` | 政企汇报、公文、通用首选 |
| `green` 墨绿·信实 | `1E5C40` | 金融、审计、ESG |
| `teal` 青碧·现代 | `0F766E` | 科技、互联网、数据报告 |
| `ochre` 赭石·人文 | `9A3412` | 文化、教育、消费零售 |
| `claret` 酒红·庄重 | `8A1C2B` | 庆典、年度、品牌发布 |

| preset | 正文 | 字体 | 场景 |
|---|---|---|---|
| `business` | 12pt / 1.5 倍 / 首行缩进 | 黑体标题 + 宋体正文 | 商务报告（默认） |
| `modern` | 10.5pt / 1.45 倍 / 无缩进 | 全文黑体 | 科技、产品文档 |
| `gongwen` | 三号 16pt / 固定 29pt / 每页 22 行 | 黑体标题 + 仿宋正文 | 公文（GB/T 9704） |
| `academic` | 10.5pt / 1.5 倍 / 首行缩进 | 黑体标题 + 宋体正文 | 学术、说明书、合同 |

**用户给了模板或单位公文格式时，精确沿用模板**，以上只是无模板时的默认方案。
中性色全主题通用：正文墨 `1F2937`（别用纯黑）、弱化灰 `595959`、表线 `D9D9D9`、斑马纹 `F7F8FA`。
**60-30-10 纪律**：强调色视觉占比 ≤10%，落在标题、表头底、分隔线上即够；
满页刷主题色是廉价感的最大来源。禁 AI 紫、禁每级标题一色。

## 排版品味

做正式交付、封面、对外汇报，或用户说“要精致好看”时，**读 `references/design-taste.md`**。
那里讲规则管不了的部分：眯眼测试、留白的从属关系、层级只用两把刀、删线而不是加线、
一图一结论、中文标点对照表、廉价感清单、按场景选主题。三条总纲：**克制、一致、呼吸**。

不读也要记住的两条：

- **相邻层级至少差 2pt 且同时换字重；标题段前距 ≈ 段后距 × 2**（helper 已设好，别改坏）。
- 觉得“不够好看”时，先做减法：删颜色、删线、删装饰，再考虑加留白。

## 目录（TOC）的真实情况

`add_toc()` 插入的是 Word **自动目录域**，域里没有页码缓存：

- 在 **Word / WPS 里打开会提示更新**（已设 `w:dirty`），或 Ctrl+A 后按 F9；
- **LibreOffice 转出的 PDF 里不会有真目录**，只会显示 helper 写入的提示文字。
  所以渲染页里看到的不是最终目录——**别据此判断“目录齐了”，也别据此判断页数**。
- 交付时要把这句话告诉用户。需要 PDF 里也有带页码的真目录，只能在 Word 里更新后另存。

## 报告类任务先确认格式

调研/研究/行业/分析/汇报/总结/评估/方案类任务，用户**没点名格式**时默认出 markdown
（含数据走 `data-insight`，图表可交互渲染并可一键转 PDF；该技能不可用时退回 `dataviz` + 本技能）。
**只有用户明确要求 Word 时才用本技能出 docx。**
合同、公文、需要修订/盖章/打印留档的文档，才是 Word 的主场。

确定要出 Word 且含数据时：

- 趋势/对比/构成**必须画成图表**，表格只作数据附录——只给表格 = 交付不完整。
- Word 里图表是位图：优先用 `data-insight` 生成 ECharts 配置渲染成 PNG；
  没有该通道就退 matplotlib（`plt.rcParams['font.sans-serif']=['Microsoft YaHei','PingFang SC']`
  防中文方块，`dpi>=150`，配色用选定的强调色 + 中性灰，别用默认七彩）。
- 用 `add_figure(doc, png, caption, source=...)` 插入：统一宽度 + 灰字图注 + 数据来源。
- 数据必须来自真实文件/调研并标注来源，**禁编造**。

## 关于修订痕迹（能力边界，诚实说明）

Word 的“修订/批注”是 OOXML 的 `w:ins`/`w:del`/`w:comment` 元素，`python-docx` **原生不支持**生成。
若用户明确要“带修订痕迹的改稿”：

- 可通过底层 XML 注入，但脆弱、易坏文档结构——除非明确需要，别轻易上；
- 更稳妥：生成“修改说明清单”（改了什么、为什么）随文档交付，或让用户在 Word 里开修订模式二次编辑；
- **不要谎称已生成修订痕迹。**

## 交付门

以下两步全部通过即可交付，不追求清零所有 WARN：

1. **check_docx.py 无 ERROR**（WARN 逐条确认过，属于"几何估算"且渲染 OK 的接受）
2. **渲染复检可接受**（`render_docx.py` 逐张看过，分页/留白/对齐无明显问题）
   - 只拿到 quicklook 时：告知用户分页/页码未验证，建议 Word 打开确认

转换类任务另需：`verify_source.py` 退出码 0。
