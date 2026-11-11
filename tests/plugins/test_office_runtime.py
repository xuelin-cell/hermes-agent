"""Ported Office content and transaction regressions from the migration source."""
import argparse,json,subprocess,zipfile,sys,types
from pathlib import Path
import xml.etree.ElementTree as ET
import pytest
namespace=types.ModuleType('office_port_test')
namespace.__path__=[str(Path(__file__).parents[2]/'plugins/uniwork-kits')]
sys.modules[namespace.__name__]=namespace
from office_port_test.office import office_cli as cli
from office_port_test.office import office_runtime as runtime


def make_docx(path: Path) -> dict[str, bytes]:
    content = {
        "word/document.xml": (
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
            'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14">'
            '<w:body><w:p><w:r><w:t>原文</w:t></w:r></w:p></w:body></w:document>'
        ).encode(),
        "[Content_Types].xml": b"<Types/>",
        "word/media/image.png": b"unchanged-image",
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in content.items():
            archive.writestr(name, data)
    return content

def test_normalize_reorders_package_without_altering_part_bytes(tmp_path: Path) -> None:
    source, target = tmp_path / "source.docx", tmp_path / "target.docx"
    content = make_docx(source)
    before = source.read_bytes()
    cli.normalize_docx(source, target)
    with zipfile.ZipFile(target) as archive:
        assert archive.namelist()[0] == "[Content_Types].xml"
        assert {n: archive.read(n) for n in archive.namelist()} == content
    assert source.read_bytes() == before

def test_create_page_geometry_retains_qname_namespace_declarations(tmp_path: Path) -> None:
    path = tmp_path / "report.docx"
    make_docx(path)
    cli.normalize_docx(path, path, "A4")
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    doc = ET.fromstring(xml)
    size = doc.find(f".//{cli.W}pgSz")
    assert size is not None and size.get(cli.W + "w") == "11906" and size.get(cli.W + "h") == "16838"
    assert b"xmlns:w14=" in xml and b'Ignorable="w14"' in xml
    assert "原文" in xml.decode()

def test_explicit_page_size_covers_all_sections_without_resetting_orientation(tmp_path: Path) -> None:
    source, target = tmp_path / "source.docx", tmp_path / "target.docx"
    xml = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body><w:p><w:pPr><w:sectPr><w:pgSz w:orient="landscape"/>'
        '<w:pgMar w:left="1800"/></w:sectPr></w:pPr></w:p>'
        '<w:sectPr><w:pgNumType w:start="1"/></w:sectPr></w:body></w:document>'
    )
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
    cli.normalize_docx(source, target, "A4")
    with zipfile.ZipFile(target) as archive:
        doc = ET.fromstring(archive.read("word/document.xml"))
    first, last = list(doc.iter(cli.W + "sectPr"))
    assert first[0].attrib == {cli.W + "orient": "landscape", cli.W + "w": "16838", cli.W + "h": "11906"}
    assert first[1].get(cli.W + "left") == "1800"
    assert last[0].attrib == {cli.W + "w": "11906", cli.W + "h": "16838"}
    assert last[1].get(cli.W + "start") == "1"

def test_bad_docx_does_not_replace_existing_output(tmp_path: Path) -> None:
    source, target = tmp_path / "bad.docx", tmp_path / "existing.docx"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("other.txt", "not a docx")
    target.write_bytes(b"keep-me")
    with pytest.raises(cli.OfficeError, match="complete DOCX"):
        cli.normalize_docx(source, target)
    assert target.read_bytes() == b"keep-me"

def test_missing_word_extractor_recovers_ordered_content(tmp_path: Path, monkeypatch) -> None:
    source, output = tmp_path / "source.docx", tmp_path / "content.json"
    make_docx(source)
    monkeypatch.setattr(runtime,"assets_dir",lambda:tmp_path/"assets")
    result = cli.docx_extract(source, output)
    assert result["fallback_reason"] == "content_extract_failed"
    assert json.loads(output.read_text(encoding="utf-8"))["blocks"] == [{"type": "paragraph", "style": None, "text": "原文"}]

def test_native_sheet_verification_repairs_formulas_only_after_recalc(tmp_path: Path, monkeypatch) -> None:
    source, output = tmp_path / "source.xlsx", tmp_path / "output.xlsx"
    worksheet = (
        b'<s:worksheet xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        b'<s:sheetData><s:row><s:c r="A1"><s:f>=SUM(1,2)</s:f><s:v>3</s:v></s:c>'
        b'<s:c r="B1"><s:f>SUM(1,3)</s:f><s:v>4</s:v></s:c></s:row></s:sheetData></s:worksheet>'
    )
    part = "xl/worksheets/sheet1.xml"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("xl/workbook.xml", b"workbook")
        archive.writestr("xl/styles.xml", b"keep formatting")
        archive.writestr(part, worksheet)
    before = source.read_bytes()
    expected = worksheet.replace(b"<s:f>=", b"<s:f>")

    def reject(_, __):
        raise cli.OfficeError("recalc failed")

    monkeypatch.setattr(cli, "recalculate", reject)
    with pytest.raises(cli.OfficeError, match="recalc failed"):
        cli.verify_native_xlsx(source, output, 60)
    assert not output.exists() and source.read_bytes() == before

    def verify(path, _):
        with zipfile.ZipFile(path) as archive:
            assert archive.read(part) == expected
        path.write_bytes(b"Recalculation output must not replace original formatting")
        return {"status": "success"}

    monkeypatch.setattr(cli, "recalculate", verify)
    assert cli.verify_native_xlsx(source, output, 60)["normalized_formulas"] == 1
    with zipfile.ZipFile(output) as archive:
        assert archive.read(part) == expected
        assert archive.read("xl/styles.xml") == b"keep formatting"
    assert source.read_bytes() == before

def test_pdf_unicode_paths_are_staged_and_structure_source_is_restored(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "中文原件.pdf"
    source.write_bytes(b"sample-pdf")
    target = tmp_path / "中文结构.json"
    seen = []

    def fake_run(args, timeout):
        seen.append(args)
        assert args[1].isascii() and args[2].isascii()
        assert Path(args[1]).read_bytes() == b"sample-pdf"
        Path(args[2]).write_text(json.dumps({"source": args[1], "text": "中文内容"}), encoding="utf-8")
        return subprocess.CompletedProcess(args, 0, b"", b"")

    monkeypatch.setattr(cli, "run", fake_run)
    args = argparse.Namespace(input=source, output=target, action="extract", format="structure", timeout=90)
    result = cli.pdf_operation(args)
    data = json.loads(target.read_text(encoding="utf-8"))
    assert result["ascii_staging"] is True
    assert data == {"source": str(source.resolve()), "text": "中文内容"}
    assert source.read_bytes() == b"sample-pdf"
    assert not Path(seen[0][1]).exists()

def test_pdf_failure_is_not_reported_as_a_successful_artifact(tmp_path: Path, monkeypatch) -> None:
    source, target = tmp_path / "input.pdf", tmp_path / "output.md"
    source.write_bytes(b"pdf")
    monkeypatch.setattr(cli, "run", lambda args, timeout: subprocess.CompletedProcess(args, 4, b"", b"cannot read"))
    with pytest.raises(cli.OfficeError, match="PDF CLI failed"):
        cli.pdf_operation(argparse.Namespace(input=source, output=target, action="extract", format="md", timeout=90))
    assert not target.exists()

def test_missing_native_scan_ocr_reports_managed_route(tmp_path: Path, monkeypatch) -> None:
    source, target = tmp_path / "scan.pdf", tmp_path / "result.md"
    source.write_bytes(b"pdf")
    monkeypatch.setattr(cli, "run", lambda args, timeout: subprocess.CompletedProcess(
        args, 4, b'{"status":"error","message":"--ocr needs PaddleOCR or Tesseract on PATH"}', b"",
    ))
    with pytest.raises(cli.OfficeError, match="pdf ocr"):
        cli.pdf_operation(argparse.Namespace(input=source, output=target, action="extract", format="md", timeout=90))
    assert not target.exists()

def test_pdf_ocr_forwards_page_selection_and_timeout(tmp_path: Path, monkeypatch) -> None:
    source, target = tmp_path / "中文扫描件.pdf", tmp_path / "识别.json"
    source.write_bytes(b"pdf")
    data = {"pages": [{"page": 2, "blocks": [{"text": "验收单", "bbox": [12, 34, 56, 78], "confidence": 1.0}]}]}

    def fake_run(command, timeout):
        assert Path(command[1]).name == "office_pdf_ocr.py"
        assert Path(command[2]) == source and command[4:] == ["2"] and timeout == 20
        Path(command[3]).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(cli, "run", fake_run)
    args = cli.parser().parse_args(["pdf", "ocr", "--input", str(source), "--output", str(target), "--page", "2", "--timeout", "20"])
    result = cli.pdf_operation(args)
    assert result["engine"] == "rapidocr"
    assert result["ocr_lines"] == "34,12 验收单 [1]" and result["ocr_high_confidence"]
    assert json.loads(target.read_text(encoding="utf-8")) == data
    assert source.read_bytes() == b"pdf"