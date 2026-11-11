"""Merge verified numeric formula edits into the original workbook package."""

from __future__ import annotations

from pathlib import Path
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from openpyxl.formula import Tokenizer

S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CELL = re.compile(rb'<(?P<prefix>(?:[\w.-]+:)?)c\b(?P<attrs>[^<>]*?)(?<!/)>(?P<body>.*?)</(?P=prefix)c\s*>', re.S)


def _sheet_paths(package: zipfile.ZipFile) -> dict[str, str]:
    relationships = ET.fromstring(package.read("xl/_rels/workbook.xml.rels"))
    targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
    workbook = ET.fromstring(package.read("xl/workbook.xml"))
    return {
        sheet.attrib["name"]: posixpath.normpath(posixpath.join("xl", targets[sheet.attrib[R + "id"]])).lstrip("/")
        for sheet in workbook.findall(f"{S}sheets/{S}sheet")
    }


def _formula_key(formula: str | None, sheets: dict[str, str]) -> tuple | None:
    if formula is None:
        return None
    tokens = []
    for token in Tokenizer("=" + formula).items:
        value = token.value
        if token.subtype == "RANGE" and "!" in value:
            sheet, ref = value.rsplit("!", 1)
            unquoted = sheet[1:-1].replace("''", "'") if sheet.startswith("'") and sheet.endswith("'") else sheet
            if unquoted in sheets:
                value = unquoted + "!" + ref
        tokens.append((token.type, token.subtype, value))
    return tuple(tokens)


def _worksheet(package: zipfile.ZipFile, path: str) -> dict[str, ET.Element]:
    root = ET.fromstring(package.read(path))
    return {cell.attrib["r"]: cell for cell in root.findall(f"{S}sheetData/{S}row/{S}c")}


def _nonnumeric_literals(package, cells):
    strings=[]
    if 'xl/sharedStrings.xml' in package.namelist():
        strings=[''.join(item.itertext()) for item in ET.fromstring(package.read('xl/sharedStrings.xml'))]
    values={}
    for address,cell in cells.items():
        kind=cell.get('t','n')
        if cell.find(S+'f') is not None or kind not in {'s','inlineStr','str','b','e'}:continue
        value=cell.findtext(S+'v')
        if kind=='s' and value is not None:value=strings[int(value)]
        elif kind=='inlineStr':value=''.join(node.text or '' for node in cell.iter(S+'t'))
        if value not in {None,''}:values[address]=(kind if kind in {'b','e'} else 'text',value)
    return values


def _write_changes(xml: bytes, changes: dict[str, tuple[str | None, str]]) -> bytes:
    pending = changes.copy()

    def replace(match: re.Match[bytes]) -> bytes:
        attrs, body, prefix = (match[name] for name in ("attrs", "body", "prefix"))
        address = re.search(rb"""\br=(["'])([A-Z]+[0-9]+)\1""", attrs)
        if not address or (change := pending.pop(address[2].decode("ascii"), None)) is None:
            return match[0]
        formula, value = change
        value_tag = rb"<" + prefix + rb"v(?:\s[^>]*)?>[^<]*</" + prefix + rb"v\s*>"
        updated_value = b"<" + prefix + b"v>" + escape(value).encode("utf-8") + b"</" + prefix + b"v>"
        if formula is not None:
            updated_value = b"<" + prefix + b"f>" + escape(formula).encode("utf-8") + b"</" + prefix + b"f>" + updated_value
        body, replaced = re.subn(value_tag, lambda _: updated_value, body, count=1)
        if replaced != 1:
            raise ValueError(f"Cannot safely update numeric cell {address[2].decode('ascii')}")
        return b"<" + prefix + b"c" + attrs + b">" + body + b"</" + prefix + b"c>"

    result = CELL.sub(replace, xml)
    if pending:
        raise ValueError("Some formula edits could not be applied to the original workbook")
    return result


def preserve_numeric_formula_edits(original: Path, edited: Path, output: Path, *, allow_value_edits: bool = False, value_targets: set | None = None) -> None:
    """Preserve original styles and formulas while applying new numeric formulas and dependent caches."""
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(edited) as native:
        source_sheets, native_sheets = _sheet_paths(source), _sheet_paths(native)
        if list(source_sheets) != list(native_sheets):
            raise ValueError("Formula-only edits must preserve the original worksheets")
        patches = {}
        wrote_formula = False
        wrote_value = False
        for sheet, path in source_sheets.items():
            old_cells, new_cells = _worksheet(source, path), _worksheet(native, native_sheets[sheet])
            if allow_value_edits and _nonnumeric_literals(source,old_cells)!=_nonnumeric_literals(native,new_cells):
                raise ValueError('Bounded numeric edits cannot change text, booleans or error literals')
            changes = {}
            for address, updated in new_cells.items():
                new_formula = updated.find(S + "f")
                if new_formula is None or not new_formula.text:
                    old=old_cells.get(address)
                    if allow_value_edits and old is not None and old.find(S+'f') is None:
                        old_value,new_value=old.findtext(S+'v'),updated.findtext(S+'v')
                        if old.get('t','n')=='n' and updated.get('t','n')=='n' and old_value and new_value and old_value!=new_value:
                            if value_targets is not None and (sheet,address) not in value_targets:
                                if float(old_value)==float(new_value):continue
                                raise ValueError(f'An unrelated numeric input changed at {sheet}!{address}')
                            changes[address]=(None,new_value)
                            wrote_value=True
                    continue
                old = old_cells.get(address)
                if old is None:
                    raise ValueError(f"Cannot preserve formatting for a formula in a missing cell ({sheet}!{address})")
                old_formula = old.find(S + "f")
                if old_formula is not None and (
                    _formula_key(old_formula.text, source_sheets) != _formula_key(new_formula.text, source_sheets)
                ):
                    raise ValueError(f"An existing formula changed in {sheet}!{address}")
                old_value, new_value = old.findtext(S + "v"), updated.findtext(S + "v")
                if old_formula is not None and old_value == new_value:
                    continue
                if (old.get("t", "n") != "n" or updated.get("t", "n") != "n"
                        or not old_value or not new_value or set(new_formula.attrib)-{'aca','ca'}):
                    raise ValueError(f"Only ordinary numeric formula cells can be merged ({sheet}!{address})")
                changes[address] = (new_formula.text if old_formula is None else None, new_value)
                wrote_formula |= old_formula is None
            if changes:
                patches[path] = _write_changes(source.read(path), changes)
        if not wrote_formula and not (allow_value_edits and wrote_value):
            raise ValueError("SheetAgent did not add a new formula to an existing numeric cell")
        with zipfile.ZipFile(output, "w") as target:
            target.comment = source.comment
            for entry in source.infolist():
                target.writestr(entry, patches[entry.filename] if entry.filename in patches else source.read(entry))
