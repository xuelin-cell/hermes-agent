---
name: pdf
description: "Read, extract text/tables, inspect and render PDFs using the managed WorkBuddy PDF CLI with Chinese-path adaptation. Export Word reports to PDF with LibreOffice; use compatible local libraries for merge/split/OCR where needed. 中文：PDF、提取文字表格、页面预览、扫描件、合并拆分、导出。"
compatibility: Windows local
---

# PDF documents

Start PDF reading and rendering with the managed WorkBuddy adapter below. Run the operation directly without probing other Python libraries or inspecting the installation. The adapter stages an unchanged input copy under an ASCII name and returns UTF-8 results to the requested path.

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" pdf extract --input "/absolute/部门预算.pdf" --output "/absolute/work/content.md" --format md
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" pdf extract --input "/absolute/部门预算.pdf" --output "/absolute/work/structure.json" --format structure
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" pdf extract --input "/absolute/部门预算.pdf" --output "/absolute/work/tables" --format table
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" pdf render --input "/absolute/部门预算.pdf" --output "/absolute/work/pages"
```

Inspect extracted content and rendered pages for the user's task. Table output may be a directory; use the returned file list. Do not present Markdown as the PDF deliverable when a PDF was requested.

For a PDF reading task, follow the WorkBuddy selection: use `md` for ordinary questions and summaries, `txt` for text only, `md-plain` for layout-aware text, `structure` for document structure, `table` for cells, and render the pages when visual evidence matters. When a PDF is supplied as source material for another Office workflow, pass it to that workflow instead of pre-extracting it through the PDF reading route.

## Scanned pages

If native extraction reports missing OCR or yields no text on a scanned page, run the bundled local fallback once for the requested pages. The page numbers are one-based, and `--page` can be repeated.

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" pdf ocr --input "/absolute/scan.pdf" --output "/absolute/work/ocr.json" --page 1
```

Read the JSON once. Use block positions to associate table values with rows. If a requested field is missing, ambiguous, or conflicts with the image, make one visual check of the affected page or crop. Report any remaining unreadable fields as uncertain and deliver the result. Do not install OCR packages at run time, upload document images for OCR, or repeat OCR and cropping at multiple scales. Identify the local RapidOCR fallback when used.

## Create or export PDF

WorkBuddy's PDF component is a reader/converter, not a PDF authoring engine. For a newly authored report, use the docx skill to prepare the Word document, then export it with the integrated LibreOffice path:

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" pdf export --input "/absolute/work/report.docx" --output "/absolute/output/部门预算.pdf"
```

The adapter normalizes DOCX packaging in a temporary copy. It does not rewrite the source Word document. Read back the resulting PDF and render it before declaring layout-sensitive work complete.

## Other PDF operations

For merge/split, rotation, forms and encryption, use appropriate local Python libraries and the preserved `references/legacy-SKILL.md` resources. PyMuPDF is available through `"$UNICLAW_OFFICE_PYTHON"`. If the managed OCR command is unavailable, state that limit rather than returning empty text as a successful reading.

Native reading/rendering errors are reported as failures. A fallback using PyMuPDF can be used for a genuinely unsupported PDF, with its use identified in the result. Deliver completed files using the application's existing file presentation tool.
