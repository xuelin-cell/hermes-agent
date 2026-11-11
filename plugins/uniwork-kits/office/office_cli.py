"""Document commands used by the native office skills (also runnable as a script)."""

from __future__ import annotations

import argparse
from contextlib import AbstractContextManager
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from xml.parsers import expat

if __package__:
    from .office_runtime import assets_dir, engine_path, find_soffice, pdf_path, recalc_path, runtime_status
else:
    from office_runtime import assets_dir, engine_path, find_soffice, pdf_path, recalc_path, runtime_status

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class OfficeError(RuntimeError):
    """An actionable document operation failure."""


def run(args: list[str], timeout: int = 90, *, env: dict[str, str] | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    """Run an owned process, terminating its own child tree on timeout."""
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW, env=env, cwd=cwd)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=10, creationflags=NO_WINDOW)
        else:
            proc.kill()
        proc.communicate(timeout=10)
        raise OfficeError(f"Operation timed out after {timeout}s: {Path(args[0]).name}") from error
    return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)


def tool_data(result: dict) -> dict:
    """Unwrap both structured MCP responses and the engine's text responses."""
    if result.get("isError"):
        raise OfficeError(str(result))
    if "file_id" in result:
        return result
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = dict(re.findall(r'"(file_id|file_path)"\s*:\s*"([^\"]+)"', text))
        data.update(dict(re.findall(r"\b(file_id|file_path)=(\S+)", text)))
        data["message"] = text
    if isinstance(data, dict) and (data.get("success") is False or data.get("code", 0) != 0):
        raise OfficeError(str(data))
    return data if isinstance(data, dict) else {"value": data}


class DocumentEngine(AbstractContextManager):
    """Own one isolated engine process for an atomic operation; never scan host ports."""

    def __enter__(self) -> DocumentEngine:
        if not engine_path().is_file():
            raise OfficeError("Document engine is missing; run scripts/install_workbuddy_office.py first")
        self.temp = tempfile.TemporaryDirectory(prefix="uniclaw-office-engine-")
        root = Path(self.temp.name)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.endpoint = f"http://127.0.0.1:{self.port}/mcp"
        self.log = (root / "stdout.log").open("wb")
        self.proc = subprocess.Popen([str(engine_path()), "--port", str(self.port), "--log_dir", str(root / "logs"),
                                      f"--tmp_dir={root / 'tmp'}"], cwd=root, stdin=subprocess.DEVNULL, stdout=self.log,
                                     stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
        try:
            deadline = time.monotonic() + 30
            while self.proc.poll() is None:
                try:
                    self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                            "clientInfo": {"name": "uniclaw-office", "version": "1"}}, timeout=2)
                    return self
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        raise OfficeError("Document engine did not become ready within 30 seconds")
                    time.sleep(0.2)
            raise OfficeError(f"Document engine exited during startup: {self.proc.returncode}")
        except (OSError, OfficeError):
            self.__exit__(None, None, None)
            raise

    def rpc(self, method: str, params: dict, timeout: int = 90) -> dict:
        """Send JSON-RPC only to the process started by this operation."""
        request = urllib.request.Request(self.endpoint, method="POST",
                                        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                        headers={"Content-Type": "application/json", "Accept": "application/json"})
        with OPENER.open(request, timeout=timeout) as response:
            data = json.load(response)
        if data.get("error"):
            raise OfficeError(str(data["error"]))
        return data.get("result", {})

    def call(self, name: str, arguments: dict) -> dict:
        """Invoke one tool and validate its result."""
        return tool_data(self.rpc("tools/call", {"name": name, "arguments": arguments}))

    def __exit__(self, *_: object) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self.log.close()
        self.temp.cleanup()


def normalize_docx(source: Path, output: Path, page_size: str | None = None) -> None:
    """Repack DOCX atomically, optionally specifying page geometry for a new document."""
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        contents = {n: archive.read(n) for n in archive.namelist() if not n.endswith("/")}
    if "[Content_Types].xml" not in contents or "word/document.xml" not in contents:
        raise OfficeError("Input is not a complete DOCX package")
    if page_size:
        namespaces = dict(node for _, node in ET.iterparse(io.BytesIO(contents["word/document.xml"]), events=["start-ns"]))
        for prefix, namespace in namespaces.items():
            if not re.fullmatch(r"ns\d+", prefix):
                ET.register_namespace(prefix, namespace)
        doc = ET.fromstring(contents["word/document.xml"])
        body = doc.find(W + "body")
        if body is None:
            raise OfficeError("DOCX has no document body")
        final_section = body.find(W + "sectPr")
        if final_section is None:
            final_section = ET.SubElement(body, W + "sectPr")
        width, height = (11906, 16838) if page_size == "A4" else (12240, 15840)
        sections = [*body.findall(f"{W}p/{W}pPr/{W}sectPr"), final_section]
        before_size = {W + name for name in ("headerReference", "footerReference", "footnotePr", "endnotePr", "type")}
        for section in sections:
            size = section.find(W + "pgSz")
            if size is None:
                size = ET.Element(W + "pgSz")
                index = next((i for i, node in enumerate(section) if node.tag not in before_size), len(section))
                section.insert(index, size)
            landscape = size.get(W + "orient") == "landscape"
            size.set(W + "w", str(height if landscape else width))
            size.set(W + "h", str(width if landscape else height))
        if len(sections) == 1 and final_section.find(W + "pgMar") is None:
            size = final_section.find(W + "pgSz")
            margins = ET.Element(W + "pgMar")
            final_section.insert(list(final_section).index(size) + 1, margins)
            for key in ("top", "right", "bottom", "left"):
                margins.set(W + key, "1440")
        # Keep otherwise-unused prefixes referenced by mc:Ignorable / QName values.
        serialized = ET.tostring(doc, encoding="utf-8", xml_declaration=True)
        for prefix, namespace in namespaces.items():
            attribute = f"xmlns:{prefix}" if prefix else "xmlns"
            if f'{attribute}='.encode() not in serialized:
                doc.set(attribute, namespace)
        contents["word/document.xml"] = ET.tostring(doc, encoding="utf-8", xml_declaration=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".docx", delete=False) as file:
        temporary = Path(file.name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(contents, key=lambda n: (n != "[Content_Types].xml", n)):
                archive.writestr(name, contents[name])
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def docx_extract(source: Path, output: Path) -> dict:
    """Run the original extractor when provisioned, otherwise recover readable blocks."""
    if source.resolve() == output.resolve() or output.suffix.lower() != ".json":
        raise OfficeError("Provide a distinct .json path for the extracted content")
    extractor = assets_dir() / "docx/skills/format-extract"
    entry = extractor / "run.py"
    bundle = extractor / "dist/cli.cjs"
    output.parent.mkdir(parents=True, exist_ok=True)
    if bundle.is_file() and entry.is_file():
        proc = run([sys.executable, str(entry), str(source.resolve()), "--output-dir", str(output.parent.resolve())])
        if proc.returncode:
            raise OfficeError(f"WorkBuddy format-extract failed: {proc.stderr.decode('utf-8', errors='replace')}")
        lines = proc.stdout.decode("utf-8").splitlines()
        artifact = Path(lines[-1]).resolve() if lines else None
        if artifact is None or not artifact.is_file() or not artifact.is_relative_to(output.parent.resolve()):
            raise OfficeError("WorkBuddy format-extract returned no usable artifact")
        return {"output": str(artifact), "engine": "workbuddy_format_extract", "fallback": False}

    with zipfile.ZipFile(source) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        styles = ET.fromstring(archive.read("word/styles.xml")) if "word/styles.xml" in archive.namelist() else None
    style_names = {}
    if styles is not None:
        for style in styles.findall(W + "style"):
            name = style.find(W + "name")
            if name is not None:
                style_names[style.get(W + "styleId")] = name.get(W + "val")

    def paragraph(node: ET.Element) -> str:
        parts = []
        for child in node.iter():
            if child.tag == W + "t":
                parts.append(child.text or "")
            elif child.tag == W + "tab":
                parts.append("\t")
            elif child.tag in {W + "br", W + "cr"}:
                parts.append("\n")
        return "".join(parts)

    body = document.find(W + "body")
    if body is None:
        raise OfficeError("DOCX has no document body")
    if any(body.find(".//" + W + tag) is not None for tag in ("drawing", "pict", "object", "altChunk", "sdt", "footnoteReference", "endnoteReference")):
        raise OfficeError("WorkBuddy format-extract is unavailable and this document contains elements the text fallback cannot preserve")
    blocks: list[dict] = []
    for node in body:
        if node.tag == W + "p":
            style = node.find(f"{W}pPr/{W}pStyle")
            style_id = style.get(W + "val") if style is not None else None
            blocks.append({"type": "paragraph", "style": style_names.get(style_id, style_id), "text": paragraph(node)})
        elif node.tag == W + "tbl":
            rows = [["\n".join(paragraph(p) for p in cell.findall(W + "p"))
                     for cell in row.findall(W + "tc")] for row in node.findall(W + "tr")]
            blocks.append({"type": "table", "rows": rows})
        elif node.tag != W + "sectPr":
            raise OfficeError("WorkBuddy format-extract is unavailable and this document has unsupported content blocks")
    result = {"engine": "ooxml_content_fallback", "fallback": True, "fallback_reason": "content_extract_failed"}
    output.write_text(json.dumps({**result, "blocks": blocks}, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**result, "output": str(output.resolve())}


def docx_convert(args: argparse.Namespace) -> dict:
    """Use the vendor's verified HTML-to-Word flow against an owned SDK process."""
    converter = assets_dir() / "docx/skills/html-to-doc/scripts/convert_doc.py"
    if not converter.is_file():
        raise OfficeError(f"WorkBuddy HTML-to-Word converter is missing: {converter}")
    destination = args.output.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".word-") as work, DocumentEngine() as engine:
        staged = Path(work) / destination.name
        env = {key: value for key, value in os.environ.items()
               if not key.lower().startswith(("editor_sdk_", "codebuddy_document_"))}
        env.update({"editor_sdk_port": str(engine.port), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        command = [sys.executable, str(converter), "--html", str(args.html.resolve()), "--output", str(staged)]
        if args.require_page_furniture:
            command.append("--require-page-furniture")
        if args.require_toc:
            command.append("--require-toc")
        proc = run(command, args.timeout, env=env)
        stdout = proc.stdout.decode("utf-8", errors="replace").strip()
        try:
            result = json.loads(stdout.splitlines()[-1]) if stdout else {}
        except ValueError:
            result = {}
        if proc.returncode or result.get("success") is not True or not staged.is_file():
            raise OfficeError(f"WorkBuddy Word conversion failed: {stdout or proc.stderr.decode('utf-8', errors='replace')}")
        # Publish only after the original preflight and output verification pass.
        normalize_docx(staged, destination, args.page_size)
    return {**result, "docx_path": str(destination), "output": str(destination), "engine": "workbuddy_editor_sdk"}


def docx_operation(args: argparse.Namespace) -> dict:
    """Create, inspect or edit Word documents using the independent engine."""
    if args.action == "extract":
        return docx_extract(args.input, args.output)
    if args.action == "convert":
        return docx_convert(args)
    if args.action == "restyle":
        if __package__:
            from .word_restyle import restyle
        else:
            from word_restyle import restyle
        return restyle(args)
    if args.action == "edit-exact":
        if __package__:
            from .word_exact import edit_exact
        else:
            from word_exact import edit_exact
        return edit_exact(args.input, args.output, json.loads(args.edits) if args.edits is not None else args.changes)
    if args.action == "compose":
        if __package__:
            from .word_compose import compose
        else:
            from word_compose import compose
        return compose(args)
    if args.action == "read":
        with zipfile.ZipFile(args.input) as archive:
            doc = ET.fromstring(archive.read("word/document.xml"))
        text = "\n".join("".join(t.text or "" for t in p.iter(W + "t")) for p in doc.iter(W + "p"))
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text, encoding="utf-8")
        result = {"text": text, "output": str(args.output) if args.output else None}
        if getattr(args, "structure", False):
            body = doc.find(W + "body")
            result["paragraphs"] = [{"index": index, "text": "".join(t.text or "" for t in paragraph.iter(W + "t"))}
                                    for index, paragraph in enumerate(body.iter(W + "p"))]
            result["tables"] = [{"index": index, "rows": [["".join(t.text or "" for t in cell.iter(W + "t"))
                                    for cell in row.findall(W + "tc")] for row in table.findall(W + "tr")]}
                                for index, table in enumerate(body.iter(W + "tbl"))]
        return result
    if args.action == "normalize":
        normalize_docx(args.input, args.output)
        return {"output": str(args.output)}
    with DocumentEngine() as engine:
        if args.action == "tools":
            return {"tools": [t for t in engine.rpc("tools/list", {}).get("tools", []) if t["name"].startswith("doc_")]}
        if args.action == "create":
            created = engine.call("create_doc", {})
            live_path = created.get("file_path")
            if not live_path:
                raise OfficeError(f"create_doc did not return file_path: {created}")
            opened = engine.call("open_file", {"file_path": live_path, "wait": True})
            fid = opened.get("file_id", live_path)
            engine.call("doc_insert_html_content", {"file_id": fid, "idx": 0, "html_text": args.html.read_text(encoding="utf-8")})
        else:
            opened = engine.call("open_file", {"file_path": str(args.input.resolve()), "wait": True})
            fid = opened.get("file_id", str(args.input.resolve()))
            operations = [{"tool": "doc_find_and_replace", "arguments": {"old_text": args.old, "new_text": args.new}}] if args.action == "replace" else json.loads(args.operations.read_text(encoding="utf-8"))
            if not isinstance(operations, list):
                raise OfficeError("Operations must be a JSON array of {tool, arguments}")
            for operation in operations:
                name = operation["tool"]
                if not name.startswith("doc_"):
                    raise OfficeError("Only doc_* tools are accepted in Word operations")
                engine.call(name, {**operation.get("arguments", {}), "file_id": fid})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        engine.call("save_file", {"file_id": fid, "file_path": str(args.output.resolve())})
        engine.call("close_file", {"file_id": fid})
    normalize_docx(args.output, args.output, args.page_size if args.action == "create" else None)
    return {"output": str(args.output.resolve()), "engine": "workbuddy_editor_sdk", "normalized": True}


def recalculate(book: Path, timeout: int) -> dict:
    """Require real formula recalculation, not merely successful file serialization."""
    proc = run([sys.executable, str(Path(__file__).with_name("recalc_worker.py")), str(book.resolve()), str(timeout)], timeout + 20)
    try:
        data = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OfficeError(f"Recalculation returned invalid output: {proc.stderr.decode('utf-8', errors='replace')}") from error
    if proc.returncode or data.get("status") != "success":
        raise OfficeError(f"Recalculation failed: {data}")
    if __package__:
        from .sheet_layout import chart_print_warnings
    else:
        from sheet_layout import chart_print_warnings
    data['layout_warnings'] = chart_print_warnings(book)
    if data['layout_warnings']:
        data['next_action'] = 'Formula checks passed, but chart/print warnings remain. For a newly created workbook repair these concrete ranges/print bounds, then recalculate once. For a targeted edit preserve existing layout and report any pre-existing warning separately.'
    return data


def normalize_sheet_formulas(xml: bytes) -> tuple[bytes, int]:
    """Strip the SDK's extra formula prefix while preserving worksheet bytes."""
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    parser = expat.ParserCreate(namespace_separator=" ")
    offsets: list[int] = []
    tag = re.compile(rb"""<[^\s/>]+(?:[^"'>]|"[^"]*"|'[^']*')*>""")

    def start(name: str, _: dict[str, str]) -> None:
        if name != f"{ns} f":
            return
        opening = tag.match(xml, parser.CurrentByteIndex)
        if opening and xml[opening.end():opening.end() + 1] == b"=":
            offsets.append(opening.end())

    parser.StartElementHandler = start
    parser.Parse(xml, True)
    if not offsets:
        return xml, 0
    chunks: list[bytes] = []
    previous = 0
    for offset in offsets:
        chunks.append(xml[previous:offset])
        previous = offset + 1
    chunks.append(xml[previous:])
    return b"".join(chunks), len(offsets)


def verify_native_xlsx(source: Path, output: Path, timeout: int, *, preserve_formula_source: Path | None = None, preserve_numeric_values: bool = False) -> dict:
    """Validate an SDK save independently without rewriting the source workbook."""
    source, output = source.resolve(), output.resolve()
    if source == output or source.suffix.lower() != ".xlsx" or output.suffix.lower() != ".xlsx":
        raise OfficeError("Native verification requires a distinct .xlsx output; the original editor file must stay intact")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".sheet-") as temp:
        candidate = Path(temp) / "verified.xlsx"
        total = 0
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(candidate, "w") as target:
            if "xl/workbook.xml" not in original.namelist():
                raise OfficeError("Input is not an XLSX workbook")
            target.comment = original.comment
            for entry in original.infolist():
                data = original.read(entry)
                if re.fullmatch(r"xl/worksheets/[^/]+\.xml", entry.filename):
                    data, count = normalize_sheet_formulas(data)
                    total += count
                target.writestr(entry, data)
        if preserve_formula_source is not None:
            if __package__:
                from .office_formula_edits import preserve_numeric_formula_edits
            else:
                from office_formula_edits import preserve_numeric_formula_edits
            preserved = candidate.with_name("preserved.xlsx")
            preserve_numeric_formula_edits(preserve_formula_source, candidate, preserved,allow_value_edits=preserve_numeric_values)
            candidate = preserved
        # LibreOffice can rewrite formatting, so verify on a scratch copy.
        calculation_copy = candidate.with_name("recalc.xlsx")
        shutil.copyfile(candidate, calculation_copy)
        verification = recalculate(calculation_copy, timeout)
        os.replace(candidate, output)
    return {"output": str(output), "normalized_formulas": total, "recalc_on_copy": verification,
            "original_format_preserved": preserve_formula_source is not None}


def xlsx_operation(args: argparse.Namespace) -> dict:
    """Use the native SDK for bounded edits and the compatible path otherwise."""
    if args.action == "recalc":
        return recalculate(args.input, args.timeout)
    if args.action == "edit-exact":
        if __package__:
            from .sheet_exact import edit
        else:
            from sheet_exact import edit
        return edit(args)
    if args.action == "verify-native":
        return verify_native_xlsx(args.input, args.output, args.timeout)
    if args.action == "tools":
        with DocumentEngine() as engine:
            return {"tools": [t for t in engine.rpc("tools/list", {}).get("tools", []) if t["name"].startswith("sheet_")]}
    if args.action == "apply-native":
        return apply_native_sheet(args)
    import openpyxl

    if args.input.suffix.lower() == ".xlsm" and args.output.suffix.lower() != ".xlsm":
        raise OfficeError("Preserve the .xlsm extension when editing a macro-enabled workbook")
    workbook = openpyxl.load_workbook(args.input, keep_vba=args.input.suffix.lower() == ".xlsm")
    try:
        changes = json.loads(args.changes.read_text(encoding="utf-8"))
        if not isinstance(changes, list):
            raise OfficeError("Changes must be a JSON array of {sheet, cell, value}")
        for change in changes:
            workbook[change["sheet"]][change["cell"]] = change["value"]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(args.output)
    finally:
        workbook.close()
    return {"output": str(args.output.resolve()), "engine": "openpyxl_compatibility_fallback",
            "recalc": recalculate(args.output, args.timeout)}


def apply_native_sheet(args: argparse.Namespace) -> dict:
    """Run a bounded edit on an isolated workbook, then verify the saved copy."""
    source, output = args.input.resolve(), args.output.resolve()
    if source == output or source.suffix.lower() != ".xlsx" or output.suffix.lower() != ".xlsx":
        raise OfficeError("Native sheet edits require a distinct .xlsx output")
    operations = json.loads(args.operations.read_text(encoding="utf-8"))
    if not isinstance(operations, list) or not operations:
        raise OfficeError("Operations must be a nonempty JSON array of {tool, arguments}")
    if any(not isinstance(op, dict) or not isinstance(op.get("tool"), str) or not op["tool"].startswith("sheet_")
           or not isinstance(op.get("arguments", {}), dict) for op in operations):
        raise OfficeError("Only sheet_* tools with object arguments are accepted in native sheet edits")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".sheet-edit-") as temp:
        staged = Path(temp) / "source.xlsx"
        saved = Path(temp) / "saved.xlsx"
        shutil.copyfile(source, staged)
        with DocumentEngine() as engine:
            opened = engine.call("open_file", {"file_path": str(staged), "wait": True, "open_with_existing": True})
            fid = opened.get("file_id")
            if not fid:
                raise OfficeError("The editor did not return a workbook file_id")
            sheet_ids = {}
            if any("sheet" in operation for operation in operations):
                sheet_info = engine.call("sheet_get_sheet_info", {"file_id": fid})
                sheet_ids = {sheet["name"]: sheet["sheet_id"] for sheet in sheet_info.get("sheets", [])}
            for operation in operations:
                arguments = {**operation.get("arguments", {}), "file_id": fid}
                if "sheet" in operation:
                    name = operation["sheet"]
                    if not isinstance(name, str) or name not in sheet_ids:
                        raise OfficeError(f"Workbook has no sheet named {name!r}")
                    arguments["sheet_id"] = sheet_ids[name]
                engine.call(operation["tool"], arguments)
            engine.call("save_file", {"file_id": fid, "file_path": str(saved)})
            engine.call("close_file", {"file_id": fid})
        return {"engine": "workbuddy_editor_sdk", **verify_native_xlsx(saved, output, args.timeout)}


def ascii_temp() -> tempfile.TemporaryDirectory:
    """Stage native PDF commands at an ASCII path to avoid the CLI's Windows path bug."""
    candidates = [Path(tempfile.gettempdir()), engine_path().parents[3]]
    for parent in candidates:
        if str(parent).isascii() and parent.is_dir():
            try:
                return tempfile.TemporaryDirectory(prefix="uniclaw-office-", dir=parent)
            except OSError:
                continue
    raise OfficeError("Native PDF CLI needs an ASCII staging directory; configure the application's TEMP directory")


def _pdf_page_evidence(path: Path) -> list[dict]:
    """Read the rendered page geometry and footer without model-side cropping."""
    import pymupdf

    pages = []
    with pymupdf.open(path) as document:
        for number, page in enumerate(document, 1):
            bounds = page.rect
            footer = pymupdf.Rect(bounds.x0, bounds.y1 - min(65, bounds.height * 0.12), bounds.x1, bounds.y1)
            pages.append({
                "page": number,
                "size_points": [round(bounds.width, 1), round(bounds.height, 1)],
                "footer_text": page.get_text(clip=footer, sort=True).strip(),
                "text_chars": len(page.get_text().strip()),
                "text_preview": page.get_text(sort=True).strip()[:180],
                "internal_links": [link.get('page') + 1 for link in page.get_links() if link.get('kind') == pymupdf.LINK_GOTO and link.get('page', -1) >= 0],
            })
    return pages


def pdf_operation(args: argparse.Namespace) -> dict:
    """Adapt native PDF operations and LibreOffice export without touching source files."""
    source = args.input.resolve()
    if args.action == "ocr":
        if args.output.suffix.lower() != ".json" or args.output.resolve() == source:
            raise OfficeError("Provide a distinct .json output path for OCR results")
        with tempfile.TemporaryDirectory(prefix="uniclaw-office-ocr-") as tmp:
            result = Path(tmp) / "ocr.json"
            command = [sys.executable, str(Path(__file__).with_name("office_pdf_ocr.py")), str(source), str(result)]
            command.extend(str(page) for page in args.page)
            proc = run(command, args.timeout)
            if proc.returncode or not result.is_file():
                error = proc.stderr.decode("utf-8", errors="replace").strip()
                raise OfficeError(f"Local PDF OCR failed: {error or 'no output'}")
            data = json.loads(result.read_text(encoding="utf-8"))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(result, args.output)
            blocks = [block for page in data["pages"] for block in page["blocks"]]
            lines = [
                f'{block["bbox"][1]:g},{block["bbox"][0]:g} {block["text"]} [{block["confidence"]:g}]'
                for block in blocks
            ]
            evidence = "\n".join(lines)
            return {
                "output": str(args.output.resolve()), "engine": "rapidocr", "pages": len(data["pages"]),
                "ocr_lines": evidence if len(data["pages"]) == 1 and len(evidence) <= 6000 else None,
                "ocr_high_confidence": bool(blocks) and all(block["confidence"] >= 0.95 for block in blocks),
            }
    with ascii_temp() as tmp:
        root = Path(tmp)
        if args.action == "export":
            soffice = find_soffice()
            if not soffice:
                raise OfficeError("LibreOffice is required for PDF export")
            staged = root / "input.docx"
            normalize_docx(source, staged)
            proc = run([soffice, f"-env:UserInstallation={(root / 'profile').as_uri()}", "--headless", "--convert-to",
                        "pdf:writer_pdf_Export", "--outdir", str(root), str(staged)], args.timeout)
            result = root / "input.pdf"
            if proc.returncode or not result.is_file():
                raise OfficeError(f"PDF export failed: {proc.stderr.decode('utf-8', errors='replace')}")
            evidence = {"rendered_pages": _pdf_page_evidence(result)} if getattr(args, "inspect", False) else {}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(result, args.output)
            return {"output": str(args.output.resolve()), "engine": "libreoffice", **evidence}
        staged = root / "input.pdf"
        shutil.copy2(source, staged)
        result = root / ("render" if args.action == "render" else "result")
        format_name = "png" if args.action == "render" else args.format
        proc = run([str(pdf_path()), str(staged), str(result), "-f", format_name, "--json"], args.timeout)
        if proc.returncode:
            details = (proc.stderr or proc.stdout).decode("utf-8", errors="replace").strip()
            if "PaddleOCR or Tesseract on PATH" in details:
                raise OfficeError("WorkBuddy PDF cannot OCR this scan. Use the managed local 'pdf ocr' command.")
            raise OfficeError(f"PDF CLI failed ({proc.returncode}): {details}")
        if args.action == "render" or result.is_dir():
            args.output.mkdir(parents=True, exist_ok=True)
            files = []
            for item in sorted(result.rglob("*")):
                if item.is_file():
                    destination = args.output / item.relative_to(result)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(item, destination)
                    files.append(str(destination.resolve()))
            if not files:
                raise OfficeError("PDF CLI produced no output files")
            return {"files": files, "engine": "workbuddy_pdf_cli", "ascii_staging": True}
        if not result.is_file():
            raise OfficeError("PDF CLI produced no output file")
        text = result.read_text(encoding="utf-8").replace(str(staged), str(source))
        if format_name == "structure":
            data = json.loads(text)
            data["source"] = str(source)
            text = json.dumps(data, ensure_ascii=False, indent=2)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        return {"output": str(args.output.resolve()), "engine": "workbuddy_pdf_cli", "ascii_staging": True}


def parser() -> argparse.ArgumentParser:
    """Build the deliberately explicit file-oriented CLI."""
    root = argparse.ArgumentParser(description=__doc__)
    groups = root.add_subparsers(dest="kind", required=True)
    groups.add_parser("status")
    for kind, actions in {"docx": ("create", "compose", "read", "extract", "convert", "restyle", "edit-exact", "replace", "apply", "normalize", "tools"),
                          "xlsx": ("recalc", "edit", "edit-exact", "tools", "apply-native", "verify-native"),
                          "pdf": ("extract", "render", "export", "ocr")}.items():
        group = groups.add_parser(kind)
        commands = group.add_subparsers(dest="action", required=True)
        for action in actions:
            command = commands.add_parser(action)
            if action not in {"create", "compose", "convert", "tools"}:
                command.add_argument("--input", type=Path, required=True)
            if action not in {"recalc", "tools"}:
                command.add_argument("--output", type=Path, required=action != "read")
            if kind == "docx":
                if action == "compose":
                    command.add_argument("--content", type=Path, required=True)
                    command.add_argument("--accent", default="234E70")
                    command.add_argument("--timeout", type=int, default=90)
                if action == "restyle":
                    command.add_argument("--reference", type=Path)
                    command.add_argument("--cover", action="store_true")
                    command.add_argument("--toc", action="store_true")
                    command.add_argument("--accent", default="234E70")
                    command.add_argument("--font", default="Microsoft YaHei")
                    command.add_argument("--body-size", type=float, default=11)
                    command.add_argument("--timeout", type=int, default=90)
                if action == "edit-exact":
                    edits = command.add_mutually_exclusive_group(required=True)
                    edits.add_argument("--changes", type=Path)
                    edits.add_argument("--edits", help="Inline JSON array for small exact edits")
                if action == "read":
                    command.add_argument("--structure", action="store_true")
                if action == "create":
                    command.add_argument("--html", type=Path, required=True)
                    command.add_argument("--page-size", choices=["A4", "Letter"], default="A4")
                if action == "convert":
                    command.add_argument("--html", type=Path, required=True)
                    command.add_argument("--page-size", choices=["A4", "Letter"])
                    command.add_argument("--require-page-furniture", action="store_true")
                    command.add_argument("--require-toc", action="store_true")
                    command.add_argument("--timeout", type=int, default=180)
                if action == "replace":
                    command.add_argument("--old", required=True)
                    command.add_argument("--new", required=True)
                if action == "apply":
                    command.add_argument("--operations", type=Path, required=True)
            if kind == "xlsx":
                command.add_argument("--timeout", type=int, default=60)
                if action == "edit-exact":
                    command.add_argument("--edits",required=True)
                    command.add_argument("--inspect",action="append",default=[])
                if action == "edit":
                    command.add_argument("--changes", type=Path, required=True)
                if action == "apply-native":
                    command.add_argument("--operations", type=Path, required=True)
            if kind == "pdf":
                command.add_argument("--timeout", type=int, default=90)
                if action == "extract":
                    command.add_argument("--format", choices=["md", "txt", "md-plain", "structure", "table"], default="md")
                if action == "export":
                    command.add_argument("--inspect", action="store_true", help="Return rendered page sizes and footer text")
                if action == "ocr":
                    command.add_argument("--page", type=int, action="append", default=[])
    return root


def main() -> int:
    """Print machine-readable results; do not report partial operations as success."""
    args = parser().parse_args()
    try:
        if args.kind == "status":
            result = runtime_status()
        elif args.kind == 'docx' and getattr(args, 'output', None):
            if __package__:
                from .file_lock import file_lock
            else:
                from file_lock import file_lock
            with file_lock(args.output):
                result = docx_operation(args)
        else:
            result = {"docx": docx_operation, "xlsx": xlsx_operation, "pdf": pdf_operation}[args.kind](args)
        print(json.dumps({"success": True, **result}, ensure_ascii=False))
        return 0
    except (OfficeError, OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, expat.ExpatError) as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
