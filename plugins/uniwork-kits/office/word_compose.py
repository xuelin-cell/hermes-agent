"""A single content-to-Word pass through the original WorkBuddy converter."""
from __future__ import annotations

import argparse
from html import escape
import json
import os
from pathlib import Path
import re
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET


def keep_table_rows(path):
    """Avoid a responsibility row straddling pages; keep small tables together."""
    from lxml import etree
    ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    w = '{' + ns + '}'
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        parts = {entry.filename: archive.read(entry) for entry in entries}
    root = etree.fromstring(parts['word/document.xml'])
    for table in root.iter(w + 'tbl'):
        rows = table.findall(w + 'tr')
        small = len(rows) <= 10 and len(''.join(table.itertext(w + 't'))) <= 500
        for number, row in enumerate(rows):
            properties = row.find(w + 'trPr')
            if properties is None:
                properties = etree.Element(w + 'trPr'); row.insert(0, properties)
            if properties.find(w + 'cantSplit') is None:
                etree.SubElement(properties, w + 'cantSplit')
            if number == 0 and properties.find(w + 'tblHeader') is None:
                etree.SubElement(properties, w + 'tblHeader')
            if small:
                for paragraph in row.iter(w + 'p'):
                    ppr = paragraph.find(w + 'pPr')
                    if ppr is None:
                        ppr = etree.Element(w + 'pPr'); paragraph.insert(0, ppr)
                    keep = ppr.find(w + 'keepNext')
                    if keep is None:
                        keep = etree.SubElement(ppr, w + 'keepNext')
                    keep.set(w + 'val', '1' if number < len(rows) - 1 else '0')
    parts['word/document.xml'] = etree.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True)
    rewritten = path.with_suffix('.pagination.docx')
    with zipfile.ZipFile(rewritten, 'w') as archive:
        for entry in entries:
            archive.writestr(entry, parts[entry.filename])
    os.replace(rewritten, path)


def compose(args):
    if __package__:
        from .office_cli import docx_convert, pdf_operation, W
    else:
        from office_cli import docx_convert, pdf_operation, W
    data = json.loads(args.content.read_text(encoding='utf-8'))
    maximum=data.get('max_pages')
    if maximum is not None and (type(maximum) is not int or maximum<1):raise ValueError('max_pages must be a positive integer')
    if not isinstance(data, dict) or not isinstance(data.get('title'), str) or not data.get('sections'):
        raise ValueError('Word content needs title and a nonempty sections array')
    if not re.fullmatch('[0-9A-Fa-f]{6}', args.accent):
        raise ValueError('Use a six-digit accent color')
    expected = []

    def value(text):
        if not isinstance(text, str):
            raise ValueError('Paragraphs and table cells must be strings; preserve user-supplied wording and units')
        expected.append(text)
        return escape(text)

    blocks = ['<h1>' + value(data['title']) + '</h1>']
    if data.get('summary'):
        blocks.append('<p class="summary">' + value(data['summary']) + '</p>')
    for section in data['sections']:
        blocks.append('<h2>' + value(section['heading']) + '</h2>')
        for paragraph in section.get('paragraphs', []):
            blocks.append('<p>' + value(paragraph) + '</p>')
        table = section.get('table')
        if table:
            headers, rows = table['headers'], table['rows']
            if not headers or any(len(row) != len(headers) for row in rows):
                raise ValueError('Word table rows must match the header width')
            blocks.append('<table><thead><tr>' + ''.join('<th>' + value(cell) + '</th>' for cell in headers) + '</tr></thead><tbody>')
            for row in rows:
                blocks.append('<tr>' + ''.join('<td>' + value(cell) + '</td>' for cell in row) + '</tr>')
            blocks.append('</tbody></table>')
    html = '''<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
@page { size: A4; margin: 23mm 25mm; @bottom-center { content: "第 " counter(page) " 页"; } }
body { font-family: "Microsoft YaHei"; font-size: 11pt; line-height: 1.35; color: #222222; }
h1 { font-size: 21pt; text-align: center; margin: 0 0 18pt; color: #ACCENT; }
h2 { font-size: 14pt; margin: 13pt 0 6pt; color: #ACCENT; page-break-after: avoid; }
p { margin: 0 0 7pt; } .summary { background-color: #F1F5F8; padding: 9pt; }
table { border-collapse: collapse; width: 100%; margin: 7pt 0; }
th, td { border: 0.5pt solid #CDD5DD; padding: 6pt; font-size: 10.5pt; }
th { background-color: #ACCENT; color: #FFFFFF; font-weight: bold; }
</style></head><body><section role="body" data-page-restart="1">'''.replace('ACCENT', args.accent)
    html += ''.join(blocks) + '</section></body></html>'
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    checks = output.parent / '.office-checks' / output.stem
    checks.mkdir(parents=True, exist_ok=True)
    source = checks / 'source.html'
    source.write_text(html, encoding='utf-8')
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='.word-compose-', dir=output.parent) as temporary:
        saved = Path(temporary) / 'composed.docx'
        docx_convert(argparse.Namespace(html=source, output=saved, page_size='A4', require_page_furniture=True, require_toc=False, timeout=args.timeout))
        keep_table_rows(saved)
        with zipfile.ZipFile(saved) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
        text = ''.join(node.text or '' for node in root.iter(W + 't'))
        if ''.join(text.split()) != ''.join(''.join(expected).split()):
            raise ValueError('Word conversion changed the supplied content; no deliverable was published')
        evidence = pdf_operation(argparse.Namespace(action='export', input=saved, output=checks / 'preview.pdf', timeout=args.timeout, inspect=True))
        pages = evidence['rendered_pages']
        compacted=False
        if maximum is not None and len(pages)>maximum:
            from docx import Document
            from docx.shared import Pt
            document=Document(saved)
            paragraphs=list(document.paragraphs)+[p for table in document.tables for row in table.rows for cell in row.cells for p in cell.paragraphs]
            for paragraph in paragraphs:
                if not paragraph.text.strip() and not paragraph._p.xpath('.//w:sectPr | .//w:drawing | .//w:fldChar'):
                    paragraph._p.getparent().remove(paragraph._p)
                else:
                    paragraph.paragraph_format.line_spacing=1.15
                    paragraph.paragraph_format.space_after=Pt(4)
                    paragraph.paragraph_format.space_before=Pt(6 if paragraph.style.name.startswith('Heading') else 0)
            document.save(saved)
            evidence=pdf_operation(argparse.Namespace(action='export',input=saved,output=checks/'preview.pdf',timeout=args.timeout,inspect=True))
            pages=evidence['rendered_pages'];compacted=True
            if len(pages)>maximum:raise ValueError(f'Content still occupies {len(pages)} pages after one spacing repair; requested at most {maximum}. Shorten the draft once without changing facts.')
        for number, page in enumerate(pages, 1):
            if f'第 {number} 页' not in page['footer_text']:
                raise ValueError(f'Word page {number} failed the page-number check')
        saved.replace(output)
    return {'output': str(output), 'engine': 'workbuddy_editor_sdk', 'verification': {'content_matches_draft': True, 'body_numbering_from_one': True, 'table_rows_kept_together': True, 'source_request_reviewed': False},
            'rendered_pages': pages, 'preview_pdf': str(checks / 'preview.pdf'), 'spacing_compacted':compacted, 'seconds': round(time.monotonic() - started, 3)}
