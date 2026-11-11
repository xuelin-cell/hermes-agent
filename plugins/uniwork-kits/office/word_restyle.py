"""Source-preserving report typography and pagination, without model layout experiments."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from collections import Counter
import re
import shutil
import tempfile
import time
import zipfile

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor
from lxml import etree

if __package__:
    from .office_runtime import config, find_soffice
else:
    from office_runtime import config, find_soffice

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
W = '{' + NS['w'] + '}'


def heading_level(paragraph):
    style = paragraph.style
    while style is not None:
        outline = style.element.find('.//' + qn('w:outlineLvl'))
        if outline is not None:
            return int(outline.get(qn('w:val'))) + 1 if int(outline.get(qn('w:val'))) < 9 else None
        match = re.fullmatch(r'heading\s*([1-9])', style.name or '', re.I)
        if match:
            return int(match[1])
        style = style.base_style
    outline = paragraph._p.find('./' + qn('w:pPr') + '/' + qn('w:outlineLvl'))
    return int(outline.get(qn('w:val'))) + 1 if outline is not None else None


def content_signature(path):
    """Read original paragraphs/cells in order, excluding only our generated index region."""
    with zipfile.ZipFile(path) as archive:
        root = etree.fromstring(archive.read('word/document.xml'))
        media = sorted(hashlib.sha256(archive.read(name)).hexdigest()
                       for name in archive.namelist() if name.startswith('word/media/') and not name.endswith('/'))
        charts = sum(name.startswith('word/charts/chart') and name.endswith('.xml') for name in archive.namelist())
    for index in root.xpath('.//w:sdt[w:sdtPr/w:docPartObj/w:docPartGallery[@w:val="Table of Contents"]] | .//w:fldSimple[contains(@w:instr, "TOC ")]', namespaces=NS):
        index.getparent().remove(index)
    lines = []
    fields = []
    for element in root.find(W + 'body').iter():
        if element.tag == W + 'fldChar':
            kind = element.get(W + 'fldCharType')
            if kind == 'begin': fields.append('')
            elif kind == 'end' and fields: fields.pop()
        elif element.tag == W + 'instrText' and fields:
            fields[-1] += element.text or ''
        in_toc = any(re.match(r'\s*TOC\b', code) for code in fields)
        if element.tag == W + 't' and not in_toc:
            lines.append(element.text or '')
        elif element.tag in {W + 'tab', W + 'br', W + 'cr'} and not in_toc:
            lines.append('\t' if element.tag == W + 'tab' else '\n')
    # Run splitting is an editor serialization detail; words, whitespace and ordering are not.
    text = ''.join(lines)
    tables = []
    for table in root.findall('.//' + W + 'tbl'):
        tables.append([[ ''.join(cell.itertext(W + 't')) for cell in row.findall(W + 'tc')]
                       for row in table.findall(W + 'tr')])
    return {'text': text, 'tables': tables, 'media': media, 'charts': charts}


def format_document(source, prepared, *, cover, toc, accent, font, body_size, reference=None):
    document = Document(source)
    paragraphs = list(document.paragraphs)
    headings = [p for p in paragraphs if heading_level(p) is not None]
    if toc and not headings:
        raise ValueError('A clickable TOC needs existing heading styles. Identify the headings explicitly before formatting; do not invent them.')
    existing_toc = bool(document.element.xpath('.//w:instrText[contains(., "TOC ")] | .//w:fldSimple[contains(@w:instr, "TOC ")]'))
    if cover and (not headings or not paragraphs or 'title' not in paragraphs[0].style.name.lower()):
        raise ValueError('Automatic cover layout needs an existing Title paragraph followed by styled headings')
    preserve = len(document.sections) > 1 or existing_toc
    if __package__:
        from .word_sections import prepare
    else:
        from word_sections import prepare
    first_body, numbering = prepare(document, headings, cover=cover, toc=toc, existing_toc=existing_toc, preserve=preserve)
    normal = document.styles['Normal']
    normal.font.name, normal.font.size = font, Pt(body_size)
    normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), font)
    in_cover = cover
    reached_body = not existing_toc
    for p in paragraphs:
        if p._p is first_body: reached_body = True
        if not reached_body: continue
        if p._p is first_body:
            in_cover = False
        level = heading_level(p)
        title = p.style.name.casefold() == 'title'
        fmt = p.paragraph_format
        fmt.keep_together, fmt.widow_control = False, True
        fmt.keep_with_next = level is not None
        fmt.line_spacing, fmt.space_after = 1.3, Pt(6)
        fmt.space_before = Pt(12 if level else 0)
        size = max(body_size, 17 - (level or 0) * 2) if level else body_size
        if title:
            size = 24 if in_cover else 21
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            fmt.space_after = Pt(12)
        if in_cover:
            title = p is paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            fmt.space_before = Pt(135 if title else 24)
            fmt.space_after = Pt(12)
            fmt.keep_with_next = True
            size = 24 if title else body_size
        for run in p.runs:
            run.font.name, run.font.size = font, Pt(size)
            run._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), font)
            if level or title:
                run.font.bold, run.font.color.rgb = True, RGBColor.from_string(accent)
    for table in document.tables:
        header = table.rows[0]._tr.get_or_add_trPr()
        if header.find(W + 'tblHeader') is None:
            header.append(OxmlElement('w:tblHeader'))
        for row_number, row in enumerate(table.rows):
            for cell in row.cells:
                if row_number == 0:
                    shading = cell._tc.get_or_add_tcPr().find(W + 'shd')
                    if shading is None:
                        shading = OxmlElement('w:shd'); cell._tc.get_or_add_tcPr().append(shading)
                    shading.set(qn('w:fill'), accent)
                for p in cell.paragraphs:
                    p.paragraph_format.space_after = Pt(4)
                    p.paragraph_format.line_spacing = 1.15
                    for run in p.runs:
                        run.font.name, run.font.size = font, Pt(body_size)
                        run._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), font)
                        if row_number == 0:
                            run.font.bold, run.font.color.rgb = True, RGBColor(255, 255, 255)
    reference_receipt = {}
    if reference:
        if __package__:
            from .word_reference import apply
        else:
            from word_reference import apply
        reference_receipt = apply(document, reference)
    if __package__:
        from .word_table_layout import fit_tables
    else:
        from word_table_layout import fit_tables
    fitted = fit_tables(document)
    document.save(prepared)
    return {'headings': len([p for p in headings if heading_level(p) <= 3]), 'tables': len(document.tables),
            'preserve_sections': preserve, 'existing_toc_updated': existing_toc, 'numbering_required': numbering,
            'overflowing_tables_fitted': fitted, **reference_receipt}


def restyle(args):
    if __package__:
        from .office_cli import run, _pdf_page_evidence
    else:
        from office_cli import run, _pdf_page_evidence
    if args.input.resolve() == args.output.resolve():
        raise ValueError('Report formatting requires a separate output; the source is kept intact')
    if not re.fullmatch('[0-9A-Fa-f]{6}', args.accent) or not 9 <= args.body_size <= 16:
        raise ValueError('Use a six-digit accent color and body size between 9 and 16 pt')
    soffice = find_soffice()
    if not soffice:
        raise ValueError('LibreOffice is required to update and verify the Word TOC and page numbers')
    # A companion resource of the configured installation, not a global Python/UNO dependency.
    python = Path(config().get('libreoffice_python_path') or Path(soffice).with_name('python.exe' if os.name == 'nt' else 'python'))
    if not python.is_file():
        raise ValueError('Set native_office.libreoffice_python_path to the Python/UNO interpreter of this LibreOffice installation')
    if __package__:
        from .word_fidelity import side_signature, verify_sides
    else:
        from word_fidelity import side_signature, verify_sides
    source = content_signature(args.input)
    source_sides = side_signature(args.input)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='.word-layout-', dir=output.parent) as temporary:
        root = Path(temporary)
        prepared, result, pdf = root / 'prepared.docx', root / 'verified.docx', root / 'verified.pdf'
        structure = format_document(args.input, prepared, cover=args.cover, toc=args.toc,
                                    accent=args.accent.upper(), font=args.font, body_size=args.body_size, reference=getattr(args,'reference',None))
        command = [str(python), str(Path(__file__).with_name('word_refresh.py')), '--soffice', soffice,
                   '--input', str(prepared), '--output', str(result), '--pdf', str(pdf)]
        if args.toc:
            command.append('--toc')
        proc = run(command, args.timeout)
        if proc.returncode or not result.is_file() or not pdf.is_file():
            raise ValueError('Word pagination failed: ' + proc.stderr.decode('utf-8', errors='replace')[-2500:])
        pagination = json.loads(proc.stdout.decode('utf-8').splitlines()[-1])
        saved = content_signature(result)
        reference = getattr(args,'reference',None)
        saved_sides = side_signature(result)
        verify_sides(source_sides, saved_sides, preserve_sections=structure['preserve_sections'] and not reference, reference=bool(reference))
        differences = [key for key in source if source[key] != saved[key] and not (key=='media' and reference and Counter(source[key]) <= Counter(saved[key]))]
        if differences:
            raise ValueError('Formatted Word failed source preservation checks: ' + ', '.join(differences))
        pages = _pdf_page_evidence(pdf)
        # Hidden UNO view cursors can report a different page after a multi-page TOC
        # reflows. The exported PDF is the pagination evidence users actually see.
        body_page = next((page['page'] for page in pages if re.search(r'第\s*1\s*页', page['footer_text'])), None)
        if body_page is None:
            if structure['numbering_required']: raise ValueError('The rendered document has no body page numbered 1')
            body_page = 1
        if args.cover and body_page < 2 + int(args.toc):
            raise ValueError('Cover, TOC and body did not paginate into separate sections')
        for i, page in enumerate(pages[body_page - 1:], 1):
            if structure['numbering_required'] and not re.search(rf'第\s*{i}\s*页', page['footer_text']):
                raise ValueError(f'Body page {i} does not have the expected page number')
        links = sum(len(page['internal_links']) for page in pages[:body_page - 1])
        if args.toc and (pagination['indexes'] != 1 or links < structure['headings']):
            raise ValueError('The Word TOC is missing clickable heading links')
        checked_numbers = 0
        if args.toc:
            import pymupdf
            with pymupdf.open(pdf) as rendered:
                for page in list(rendered)[:body_page - 1]:
                    for link in page.get_links():
                        if link.get('kind') != pymupdf.LINK_GOTO:
                            continue
                        label = page.get_textbox(link['from']).strip()
                        number = re.search(r'\.{2,}\s*(\d+)\s*$', label)
                        if number is None or int(number[1]) != link['page'] - body_page + 2:
                            raise ValueError('A rendered TOC page number does not match its actual destination')
                        checked_numbers += 1
        checks = output.parent / '.office-checks' / output.stem
        checks.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pdf, checks / 'preview.pdf')
        receipt = {'output': str(output), 'engine': 'ooxml_source_preserving_typeset',
                   'verification': {'original_text_and_tables_unchanged': True, 'images_and_charts_preserved': True,
                                    'notes_and_comment_anchors_preserved': True, 'original_furniture_preserved': not bool(reference),
                                    'reference_furniture_applied': bool(reference),
                                    'body_first_page': body_page, 'toc_links': links, 'toc_page_numbers_verified': checked_numbers,
                                    'annotation_counts': dict(Counter(item[0] for item in saved_sides['annotations'])),
                                    'header_footer_text': saved_sides['furniture'],
                                    'section_geometry': saved_sides['sections'], **structure},
                   'rendered_pages': pages, 'preview_pdf': str(checks / 'preview.pdf'),
                   'seconds': round(time.monotonic() - started, 3),
                   'next_action': 'Formatting and rendered pagination are complete. Original text, tables, annotation anchors and section furniture were compared with the source; their evidence is above. Present this Word file once now. Do not inspect Normal-style XML, unzip the file, change preserved page sizes, or repeat exports to recheck these passed properties. Only repair a concrete new defect, not an unrequested style preference.'}
        (checks / 'verification.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(result, output)
    return receipt
