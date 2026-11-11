---
name: docx
description: "Create, format and edit Word documents with verification."
platforms: [windows]
---

# Word documents

Choose the route from the user’s requested operation. The host provides tested layout, pagination and precise-edit functions. Do not reimplement these helpers or run layout/schema experiments for the supported cases.

## Prerequisites

The local Office worker and LibreOffice are managed by the host. Use `WorkBuddyOffice` with the CLI arguments shown below, or invoke the supplied Python and CLI with quoted paths. Do not install dependencies or connect to a running WorkBuddy editor. Call `status` only to diagnose a failed operation.

## How to run

### A. Reformat an existing Word without rewriting its content

For formatting without rewriting content, call this route FIRST, including multi-section layouts, notes/comments and reference templates. It keeps source paragraphs, table values, images and charts, creates separate cover/TOC/body sections, computes real TOC page numbers and checks the rendered body numbering. No HTML, extractor, design tokens, agent role files or engine schemas are needed for this operation.

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" docx restyle --input "/absolute/source.docx" --output "/absolute/output/report.docx" --cover --toc
```

Include `--cover` and `--toc` only when requested. Optional `--accent 234E70`, `--font "Microsoft YaHei"`, `--body-size 11` change typography; they do not change the source text. The receipt already contains content/table preservation, image/chart checks, PDF page evidence, clickable TOC count and a preview PDF. A successful receipt completes the task. Do not export, remeasure, reread schemas or inspect footer crops again. Present the requested Word file once.

This route also preserves existing portrait/landscape sections, different headers/footers, footnotes, endnotes and comment anchors. For a document with an existing TOC, pass `--toc` to update that index; do not pass `--cover` or build a second index. Existing section geometry and front matter stay intact. New covers require an existing Title paragraph.

For a separate visual Word template/reference, add `--reference "/absolute/reference.docx"`. This copies its standard text/heading styles, margins and header/footer identification (including images), without copying body placeholders. Keep the source body and table data. Do not explore SDK styles or rebuild the reference by hand.

If an unsupported structure is rejected, use the stated reason to choose a specific editing route once; do not repeatedly change flags or test alternate layouts.

### B. A few text or table-cell changes, all other formatting unchanged

Use `WorkBuddyOffice` for one `docx read --structure` call. Its indexed tables identify the target row/cell directly; do not inspect Python libraries, parse ZIPs yourself or query engine schemas. Then call `edit-exact --edits` with the small JSON array as one string argument. No intermediate changes file is needed. This bypasses editor round-trips: only the requested Word text nodes change; all other package parts remain byte-identical. The helper checks unique matches, preserves split-run formatting and returns every applied change. Do not first try SDK replace/save or write a custom XML editing script.

```json
[
  {"old":"11 月 5 日","new":"11 月 8 日"},
  {"table":0,"row":2,"column":2,"old":"5","new":"4"}
]
```

All table indexes are zero-based, including the header row. `paragraph_contains` may disambiguate an old string using words in the same paragraph. If the old string matches several paragraphs, specify the selector rather than replace every match.

```json
{"arguments":["docx","read","--input","/absolute/source.docx","--structure"]}
{"arguments":["docx","edit-exact","--input","/absolute/source.docx","--output","/absolute/output/revised.docx","--edits","[{\"old\":\"11 月 5 日\",\"new\":\"11 月 8 日\"},{\"table\":0,\"row\":2,\"column\":2,\"old\":\"5\",\"new\":\"4\"}]"]}
```

After success, compare the receipt's `applied_changes` with the user's request and deliver directly. Do not reread the whole document, render unchanged layouts or inspect all styles/ZIP parts again; the helper already verified them. `--changes /absolute/changes.json` remains available for longer edit lists.

### C. Notices, internal plans and reports from supplied facts

For a short or medium report with ordinary headings, paragraphs and tables (including summaries of supplied files), draft content once into JSON. Read the supplied materials once and cite their facts; do not use the full role-file workflow merely because the input is long. A long input requiring only reformatting uses route A without rewriting. Use route D for genuinely custom structures. Use the exact force of every supplied rule: “可释放” stays optional; do not add cancellation cutoffs, approvals, mandatory actions, contacts, dates or other rules absent from the request. Copy normative rules verbatim into the relevant section; use prose to explain roles and steps without inventing conditions. Before calling the tool, compare the draft against the original user’s numbers and permissions once.

Keep each time limit attached to its original action. A rule that permits a response after a time threshold does not create a mandatory completion deadline or an eligibility condition for the user. In responsibility tables, refer to the original conditional rule instead of turning it into a new deadline. Preserve reasonable operational detail and role preparation duties.

```json
{
  "title":"文档标题",
  "summary":"简短摘要",
  "max_pages":4,
  "sections":[
    {"heading":"一、适用范围","paragraphs":["原始要求中的范围和规则，保持原意。"]},
    {"heading":"二、责任分工","table":{"headers":["角色","职责"],"rows":[["管理员","用户给定或由流程直接确定的职责。"]]}}
  ]
}
```

```json
{"arguments":["docx","compose","--content","/absolute/work/content.json","--output","/absolute/output/plan.docx"]}
```

Set max_pages only when the user gives an upper page limit; the host makes at most one spacing repair without reducing the font or deleting content.

Call this through `WorkBuddyOffice`, not `terminal`: the host independently reviews the draft against the actual user request once and applies uniquely targeted corrections before conversion. A terminal CLI invocation cannot perform this semantic review. This is one short review, not a new planning loop. The receipt records any corrections and the review duration. If the review fails, do not bypass it and claim the source rules were checked.

Conversion uses the original WorkBuddy HTML-to-Word converter with tested typography, native text/tables and body page numbering from 1. The host checks that conversion preserved the reviewed draft and verifies actual page footers. The receipt is the combined check; no hand-written CSS or additional export is needed. If desired, view the preview once. Do not make a series of spacing/border/footer prototypes.

### D. Long authoring, reference styles and structural edits

For longer writing use the original `tdoc-orchestrator` resources at `$UNICLAW_OFFICE_ASSETS_DIR/docx/skills/tdoc-orchestrator/` and relevant roles in `$UNICLAW_OFFICE_ASSETS_DIR/docx/agents/`. Read only the selected genre’s resources together. Preserve stage artifacts. Use the original `html-review/scripts/review_html.py`, then:

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" docx convert --html "/absolute/stage2/formatted.html" --output "/absolute/output/report.docx" --page-size A4 --require-page-furniture --require-toc
```

Omit gates that do not apply. `docx extract --input ... --output ...json` uses the original extractor when available; otherwise it returns ordered text/style/table blocks and `fallback_reason: content_extract_failed`. That fallback cannot preserve complex unsupported elements or imitate a separate style reference. Do not silently discard those elements.

For specific structural formatting, query `docx tools` once, then use `docx apply --input ... --output ... --operations ...json` with actual `doc_*` tool names and parameters. `file_id` is supplied by the adapter. Batch related operations rather than probe one property per model turn. Read the saved content and use one PDF export with `--inspect` when layout changes. On a concrete failure, make one targeted repair and recheck that defect; otherwise report the remaining issue instead of looping.

## Verification and delivery

Source facts and policy permissions require a content check, not just a successful render. Formatting-only tasks preserve source wording, data and emphasis; do not rewrite a heading or add a summary. If an image reader is unavailable, do not keep calling it or claim visual inspection. Check what is available and state any material limit.

The optional commands `pdf export --input ...docx --output ...pdf --inspect` and `pdf render --input ...pdf --output ...directory` are for workflows that do not already return page evidence. Footer text, text previews and internal link targets arrive in one receipt. Do not repeat successful checks. Keep input files intact unless the user explicitly requests in-place changes. Attach the final Word once, after the short result description; omit internal scripts and preview PDFs unless asked.
