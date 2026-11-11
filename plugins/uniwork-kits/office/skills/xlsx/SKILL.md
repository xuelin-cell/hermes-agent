---
name: xlsx
description: "Create, read, edit and analyze Excel (.xlsx/.xlsm), CSV and TSV files using WorkBuddy spreadsheet generation principles, openpyxl and verified formula recalculation. Includes charts, formatting, budgets and data cleaning. 中文：Excel、电子表格、公式、预算、图表、数据分析。"
compatibility: Windows local
---

# Spreadsheets

Use WorkBuddy's Python/openpyxl generation approach. The host supplies its original design references and recalculation scripts at `$UNICLAW_OFFICE_ASSETS_DIR/sheet/skills/workbuddy-sheet-generation/`.

## Required workflow

1. Before generating a workbook, read `references/schema_principle.md` under that directory. Read the relevant `references/design_patterns/` material for the requested workbook.
2. Execute your Python generation/analysis script with `"$UNICLAW_OFFICE_PYTHON" script.py`, so the managed openpyxl dependency is used. Do not pip-install dependencies from an agent script.
3. Use openpyxl for workbook creation, styles, conditional formatting and charts. Write formulas as strings starting with `=`. Use cell references and formulas for calculated fields, guard division by zero, and clearly distinguish inputs from calculated results.
4. Save to the requested output directory and recalculate:

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" xlsx recalc --input "/absolute/output/budget.xlsx" --timeout 60
```

5. Reopen with `data_only=False` to inspect formulas and with `data_only=True` to verify numeric cached results. Check totals independently and confirm charts/formatting remain. A successful save alone does not prove recalculation succeeded.

For a newly created workbook, set the print area to include its data and charts and fit the sheet to one page wide (`fitToWidth=1`, `fitToHeight=0`), using landscape orientation for a wide dashboard. This prevents charts from being cut into separate vertical strips on PDF export. Do not change an existing workbook's print settings during a targeted edit unless requested.

Recalculation also returns `layout_warnings`. For newly created workbooks repair `chart_outside_print_area` using `required_bottom_right`, and align category rows with value rows when `category_value_range_misaligned` appears (exclude header cells from both). These are concrete defects, not optional styling. Success of formula recalculation does not clear those warnings. Preserve existing chart/print settings for a narrow input-cell edit.

## Existing workbooks

For a known sheet/cell and an exact numeric replacement, call `WorkBuddyOffice` with `xlsx edit-exact` once. It supports guarded in-place save, original formatting and real formula recalculation without a model subtask:

```json
{"arguments":["xlsx","edit-exact","--input","/absolute/source.xlsx","--output","/absolute/source.xlsx","--edits","[{\"sheet\":\"明细\",\"cell\":\"D5\",\"old\":12,\"value\":15}]","--inspect","明细!F5","--inspect","汇总!B9"]}
```

Use `--inspect` for result cells explicitly requested by the user. Report those returned values; do not delegate or recalculate the same edit again. This route rejects formula targets, nonnumeric edits, changed old values and concurrent writes. Discovery, aggregation, cross-sheet design and analysis still use the complete original SheetAgent.

Apply the original WorkBuddy routing distinction. A small, deterministic change with a known target (for example, set a named cell) goes through the local SDK. For an existing XLSX that requires data discovery, aggregation, pivots, cleaning, or cross-sheet formula design, use the host's `WorkBuddySheet` tool. Pass the uploaded workbook's absolute workspace path, the original user request verbatim and `action: "edit"` or `action: "read"`. Use ToolSearch if the tool is deferred. Do not pre-read the workbook or add execution instructions before delegating. An in-place edit omits `output_path`; use a separate path if the user explicitly asked for a copy.

The host opens a staged workbook in the editor, delegates reading and editing to the original SheetAgent with its own MCP tools, then saves and verifies the file. On a failed or incomplete tool result, do not claim the workbook was saved. For an unavailable tool or unsupported format, report the limitation or explicitly identify the existing compatibility route if used.

For a user-requested in-place edit that requires discovery or formula design, use `WorkBuddySheet` so the host's staged save, source-conflict check and atomic publication also apply. Pass the original request; the host, not the model, replaces the uploaded workbook after verification. Do not invent an extra deliverable copy.

For a bounded edit to an ordinary XLSX, inspect actual tool schemas, then pass a JSON array of `{"tool": "sheet_…", "sheet": "sheet name", "arguments": {…}}`. The adapter resolves the sheet name in the opened workbook. Use a distinct output path; the SDK writes a staged copy, then the adapter repairs the known formula serialization and verifies recalculation before delivery.

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" xlsx tools > sheet-tools.json
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" xlsx apply-native --input "/absolute/input.xlsx" --output "/absolute/output/revised.xlsx" --operations operations.json
```

Read back the edited values and confirm the existing formulas and workbook features are intact. For macro-enabled files or workbooks with features the SDK has not been verified to preserve, use the compatibility path or report the limitation.

If a user brings an XLSX already saved by WorkBuddy that has a formula serialization issue, use the following on a separate output path. It validates a scratch copy with real recalculation and preserves the source and other workbook parts in the delivered copy:

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" xlsx verify-native --input "/absolute/workbuddy-saved.xlsx" --output "/absolute/output/verified.xlsx"
```

For a simple cell update using the compatibility path, write a JSON array:

```json
[{"sheet":"预算","cell":"C2","value":96000}]
```

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" xlsx edit --input "/absolute/input.xlsx" --output "/absolute/output/revised.xlsx" --changes changes.json
```

For more complex edits, use openpyxl in your own script, preserve formulas, styles and charts, save a copy, and run the managed recalculation command. Preserve `.xlsm` and use `keep_vba=True` for macro-enabled workbooks. Do not claim unsupported advanced workbook features were preserved without checking them. CSV/TSV operations can use Python's standard csv module; legacy format resources remain in `references/legacy-SKILL.md`.

## Runtime

```bash
"$UNICLAW_OFFICE_PYTHON" "$UNICLAW_OFFICE_CLI" status
```

Quote environment paths. Do not replace missing cached results with hard-coded numbers or call an error a successful recalculation. Deliver the workbook through the existing file presentation tool, with a short explanation of its sheets and formulas.

After a successful WorkBuddySheet edit, the host has already saved, preserved the requested source formatting and performed real recalculation. Use the returned verification and summary. Do not launch another standalone recalculation or copy-edit-recalculate experiment after those checks pass.
