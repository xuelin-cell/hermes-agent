---
name: uniai-pdf
description: "读取、创建、编辑、转换和识别 PDF 文档."
version: "1.0.0"
author: "UniWork"
license: Proprietary. LICENSE.txt has complete terms
platforms: [linux, macos, windows]
tags: [PDF, 文档, OCR]
metadata:
  OpenAgent: "📄"
  runtime: '{"os":["linux","darwin","win32"],"bins":[]}'
---

# PDF Processing Guide

对 PDF 做真实的读写处理（本技能会**实际执行代码生成文件**，不只是给参考）。基础库为纯 Python（`pypdf` / `pdfplumber` / `reportlab`），跨 Linux(Pro) 与 Windows(Lite) 均可运行；命令行工具（poppler / qpdf / pdftk / tesseract）在 Linux 沙箱通常可用，在 Windows host 可能缺失——**缺失时一律走纯 Python 路径**。

安装依赖（优先 uv）：
```bash
uv pip install pypdf pdfplumber reportlab || python -m pip install pypdf pdfplumber reportlab
```

进阶用法（pypdfium2、JS 的 pdf-lib、排障）见 `reference.md`；**填写 PDF 表单先读 `forms.md` 并按其步骤执行**。

## ⚠️ 中文 PDF 必读：注册 CJK 字体

reportlab 内置字体**不含中文字形**，直接写中文会变成空白/黑框。生成含中文的 PDF 前，先注册一个 CJK 字体：

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))   # reportlab 自带的中文 CID 字体，无需外部文件
# 之后在样式里用 fontName='STSong-Light'
```
若要更好看的字重/字形，注册系统 TTF：`pdfmetrics.registerFont(TTFont('YaHei', 'C:/Windows/Fonts/msyh.ttc'))`（Windows）或 Noto Sans SC（Linux）。表格/Paragraph 样式都要显式指定该 `fontName`。**同样别用 Unicode 上下标字符**（₀₁₂/⁰¹²）——内置字体缺这些字形会渲染成黑块，改用 `<sub>`/`<super>` 标签。

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")
text = "".join(page.extract_text() for page in reader.pages)
```

## Python 库

### pypdf — 基础操作

**合并**
```python
from pypdf import PdfWriter, PdfReader
writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    for page in PdfReader(pdf_file).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as f:
    writer.write(f)
```

**拆分**
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter(); writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

**元数据 / 旋转 / 加密**
```python
meta = PdfReader("document.pdf").metadata           # meta.title / meta.author ...
page.rotate(90)                                      # 顺时针 90°
writer.encrypt("userpassword", "ownerpassword")      # 加密
```

### pdfplumber — 抽取文字与表格

```python
import pdfplumber, pandas as pd
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        for j, table in enumerate(page.extract_tables()):
            df = pd.DataFrame(table[1:], columns=table[0])
            df.to_excel(f"table_p{i+1}_{j+1}.xlsx", index=False)
```

### reportlab — 创建 PDF（精简模板，直接复制运行）

```python
# -*- coding: utf-8 -*-
# 模板：直接复制运行，内容替换即可
import os
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

# 字体注册
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
FONT = 'STSong-Light'

# 样式初始化
styles = getSampleStyleSheet()
for s in styles.byName.values():
    s.fontName = FONT

# 常用样式
title_s  = ParagraphStyle('T',  parent=styles['Title'],   fontSize=26, leading=32, alignment=TA_CENTER)
h1_s     = ParagraphStyle('H1', parent=styles['Heading1'], fontSize=18, leading=24, spaceBefore=18, spaceAfter=8)
body_s   = ParagraphStyle('B',  parent=styles['Normal'],  fontSize=11, leading=16)
bullet_s = ParagraphStyle('BL', parent=styles['Normal'],  fontSize=11, leading=16, leftIndent=20, firstLineIndent=-10)

# 表格函数
def tbl(data, widths=None):
    ts = TableStyle([
        ('FONTNAME', (0,0), (-1,-1), FONT), ('FONTSIZE', (0,0), (-1,-1), 10),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'), ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('GRID', (0,0), (-1,-1), 0.5, colors.grey),
    ])
    return Table(data, colWidths=widths, style=ts, repeatRows=1)

# 构建文档
doc = SimpleDocTemplate("report.pdf", pagesize=A4, leftMargin=72, rightMargin=72, topMargin=72, bottomMargin=72)
story = [
    # 封面
    Paragraph("报告标题", title_s), Spacer(1, 24),
    Paragraph("副标题", body_s), PageBreak(),

    # 正文
    KeepTogether([Paragraph("一、第一章标题", h1_s), Paragraph("正文内容", body_s)]),
    Paragraph("• 列表项", bullet_s),
    tbl([["列1","列2"],["a","b"]], widths=[100, 200]),
]

# ===== 自检：发现错误立即终止，不要生成损坏的 PDF =====
assert 'TA_RIGHT' in dir(), "❌ TA_RIGHT 未导入"
assert 'TA_CENTER' in dir(), "❌ TA_CENTER 未导入"
# 检查 story 中是否有 None（常见遗漏）
for i, item in enumerate(story):
    if item is None:
        raise ValueError(f"❌ story[{i}] 是 None，请检查表格或段落是否正确返回")
# 检查表格数据是否非空
for i, item in enumerate(story):
    if isinstance(item, Table):
        if not item._cellvalues:
            raise ValueError(f"❌ story[{i}] 表格数据为空")
print(f"📄 共 {len(story)} 个元素")

doc.build(story)
print(f"✅ report.pdf ({os.path.getsize('report.pdf')} bytes)")
```

**要点：**
- `SPAN` 格式：`SPAN(起始行, 起始列, 结束行, 结束列)`，两端 inclusive
  - 3行合并：起始=0, 结束=2 → `SPAN(0, 0, 2, 0)`，不是 `(0, 0, 3, 0)`
- `bullets` 用 `*` 展开：`story.extend([Paragraph(...) for ...])` 或 `*list`

**禁止事项：**
- ❌ 修改 import 语句（TA_RIGHT 等已包含，直接复制不要改）
- ❌ `ParagraphStyle('X', fontName='Helvetica', ...)`  // 遗漏中文字体
- ❌ `TableStyle([...])` 不传 FONTNAME            // 表格中文变乱码
- ❌ 在 `pdfmetrics.registerFont()` 之前创建样式      // 字体未注册
- ❌ `fontName` 既在父样式又在子样式重复传入          // 继承冲突
- ❌ 生成内容时代码有语法错误（如 tuple/list 混用、括号不匹配）

## ⚠️ 样式继承的正确写法

当父样式（如 `Normal`）已经设置 `fontName` 后，子样式继承时应**避免重复传入** `fontName`，否则可能导致渲染异常：

```python
# === 正确做法：先修改基础样式，再继承 ===

# Step 1: 先把 getSampleStyleSheet() 的所有基础样式全部设置为中文字体
styles = getSampleStyleSheet()
for s in styles.byName.values():
    s.fontName = FONT

# Step 2: 子样式直接继承，不再重复传 fontName
title_style = ParagraphStyle('MyTitle', parent=styles['Title'], fontSize=22, leading=26)
#              ↑ parent 已有 fontName，不需再传

heading_style = ParagraphStyle('MyHeading', parent=styles['Heading1'], fontSize=16, leading=20)
body_style = ParagraphStyle('MyBody', parent=styles['Normal'], fontSize=11, leading=16)
```

```python
# === 错误做法：父样式有 fontName，子样式又重复传 ===
title_style = ParagraphStyle('MyTitle', parent=styles['Title'], fontName=FONT, fontSize=22)
#              fontName 在 parent 和 self 同时出现 → 继承冲突
```

## ⚠️ Table Span 语法（极易出错）

**`SPAN` 的坐标是 inclusive（包含两端）的**，end index 不能超出范围。

```python
# === 正确的 SPAN 写法 ===
# 格式：Span(起始行, 起始列, 结束行, 结束列)  ← 全部 inclusive！
# 12行表格分4组（每组3行）：
#   第1组: 第0-2行 → Span(0, 0, 2, 0)
#   第2组: 第3-5行 → Span(3, 0, 5, 0)
#   第3组: 第6-8行 → Span(6, 0, 8, 0)
#   第4组: 第9-11行 → Span(9, 0, 11, 0)

table_data = [
    ['层级', '描述', '示例'],          # 行0
    ['基础层', 'Embedding', 'Text-embedding'],  # 行1
    ['基础层', 'Vector DB', 'Chroma'],  # 行2  ← 与行0-1合并
    ['模型层', 'LLM', 'GPT-4'],        # 行3
    ['模型层', '多模态', 'GPT-4V'],    # 行4
    ['模型层', 'Embedding', 'Text-embedding'],  # 行5  ← 与行3-4合并
    # ...
]
row_spans = [
    (0, 0, 2, 0),   # 第0-2行合并（3行）
    (3, 0, 5, 0),   # 第3-5行合并（3行）
    (6, 0, 8, 0),   # 第6-8行合并（3行）
    (9, 0, 11, 0),  # 第9-11行合并（3行）
]
ts = TableStyle([
    ('FONTNAME', (0, 0), (-1, -1), FONT),
    ('SPAN', *row_spans[0]),   # ← 注意是拆包 (0, 0, 2, 0)
    ('SPAN', *row_spans[1]),   # ← 而不是 SPAN(row_spans[0])
    # ...
])
```

**常见错误对比：**

| 错误写法 | 正确写法 | 说明 |
|---------|---------|------|
| `SPAN(0, 0, 3, 0)` | `SPAN(0, 0, 2, 0)` | end=起始+行数-1，不是+行数 |
| `SPAN(3, 0, 6, 0)` | `SPAN(3, 0, 5, 0)` | 12行表格最大end=11 |
| `SPAN(*[0,0,2,0])` | `SPAN(0, 0, 2, 0)` | 传入4个int，不是list |

**防御性校验（推荐在生成表格后加入）：**

```python
# SPAN 结束行 = 起始行 + 行数 - 1，例如3行合并：SPAN(0, 0, 2, 0)
```

## 命令行工具（Linux 沙箱通常可用；Windows 缺失就用上面的纯 Python 等价实现）

```bash
pdftotext -layout input.pdf output.txt        # poppler：保留版式抽文字
qpdf --empty --pages a.pdf b.pdf -- merged.pdf # 合并
qpdf input.pdf --pages . 1-5 -- pages.pdf       # 拆分
qpdf --password=pw --decrypt in.pdf out.pdf     # 去密码
pdfimages -j input.pdf prefix                   # 抽取图片
```

## 常见任务

**扫描件 OCR**（需要 tesseract；中文识别装 `chi_sim` 语言包）
```python
# uv pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path
text = ""
for i, img in enumerate(convert_from_path('scanned.pdf')):
    text += f"Page {i+1}:\n" + pytesseract.image_to_string(img, lang='chi_sim+eng') + "\n\n"
```
> Windows(Lite) 若无 tesseract/poppler，可改用 UniAI 工具箱里的 OCR 能力，或提示用户本机识别。

**加水印**
```python
from pypdf import PdfReader, PdfWriter
wm = PdfReader("watermark.pdf").pages[0]
reader, writer = PdfReader("document.pdf"), PdfWriter()
for page in reader.pages:
    page.merge_page(wm); writer.add_page(page)
with open("watermarked.pdf", "wb") as f:
    writer.write(f)
```

## Quick Reference

| 任务 | 首选工具 | 说明 |
|------|---------|------|
| 合并 | pypdf | `writer.add_page(page)` |
| 拆分 | pypdf | 每页一个文件 |
| 抽文字 | pdfplumber | `page.extract_text()` |
| 抽表格 | pdfplumber | `page.extract_tables()` |
| 新建 | reportlab | 含中文先注册 CID 字体 |
| OCR | pytesseract | 先转图片，中文用 `chi_sim` |
| 填表单 | pypdf / pdf-lib | 见 `forms.md` |

## ⚠️ 常见错误与规避（必须阅读）

| 错误 | 原因 | 解决方法 |
|------|------|----------|
| 中文变黑框/空白 | 未注册 CJK 字体 | `pdfmetrics.registerFont()` 放在**所有样式设置之前** |
| 引号嵌套错误 | `"中文"含引号"` 语法错误 | 内容存变量，用 `'''` 或 dict 结构 |
| 上下标变黑块 | Unicode ₀₁₂/⁰¹² 超出字体 | 用 `<sub>`/`<super>` 标签替代 |
| 表格字体乱码 | `TableStyle` 未指定 `FONTNAME` | `TableStyle([('FONTNAME', (0,0), (-1,-1), FONT), ...])` |
| 样式创建在注册前 | 字体未注册就创建样式 | register → FONT → 样式创建，三步顺序 |
| **字体继承冲突** | 父样式和子样式同时传 `fontName` | 模板已处理：基础样式统一设字体，子样式不重复传 |
| **SPAN 越界** | `SPAN(end_row)` 写成 start+行数（应为-1） | 结束行 = 起始行 + 行数 - 1（如3行合并：end_row=2） |
| **`TA_RIGHT` 未导入** | 只导入了 `TA_LEFT` | 模板已包含完整导入，**不要修改 import 语句** |
| **`bullets()` 用 `append`** | 把 list 当作单个元素添加 | 用 `*list` 展开或 `story.extend(list)` |
| **语法错误 `)` 多余** | 括号不匹配 | 用模板的 `tbl()` 函数，不要手动拼字符串 |

## 交付前自检
模板已内置自检，发现错误会立即终止并提示。人工确认：
1. 文件大小非 0（0 字节=失败）
2. 中文/字体正常渲染，无黑框、无缺字
3. 输出写入 workspace，文件名语义化

## Next Steps
- 进阶（pypdfium2、pdf-lib、排障）→ `reference.md`
- 填 PDF 表单 → `forms.md`
