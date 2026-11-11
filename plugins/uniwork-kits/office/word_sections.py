"""Preserve existing section furniture while adding only requested front matter."""
from copy import deepcopy

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def bookmark(paragraph, name, identity):
    start, end = OxmlElement('w:bookmarkStart'), OxmlElement('w:bookmarkEnd')
    start.set(qn('w:id'), str(identity)); start.set(qn('w:name'), name)
    end.set(qn('w:id'), str(identity))
    paragraph.append(start); paragraph.append(end)


def divider(section):
    paragraph = OxmlElement('w:p')
    properties = OxmlElement('w:pPr')
    properties.append(deepcopy(section)); paragraph.append(properties)
    return paragraph


def prepare(document, headings, *, cover, toc, existing_toc, preserve):
    paragraphs = document.paragraphs
    has_body_marker = bool(document.element.xpath('.//w:bookmarkStart[@w:name="UniworkBodyStart"]'))
    if existing_toc and cover:
        raise ValueError('This document already has front matter. Update its existing TOC without adding another cover.')
    first_body = headings[0]._p if cover else document.element.body[0]
    if existing_toc:
        markers = document.element.xpath('.//w:bookmarkStart[@w:name="UniworkBodyStart"]')
        first_body = next(markers[0].iterancestors(W + 'p')) if markers else headings[0]._p
    identity = max([int(value) for value in document.element.xpath('.//w:bookmarkStart/@w:id') if value.isdigit()], default=0) + 1
    added = 0
    if cover:
        first_body.addprevious(divider(document.sections[0]._sectPr)); added += 1
    if toc and not existing_toc:
        start = OxmlElement('w:p'); bookmark(start, 'UniworkTOCStart', identity)
        first_body.addprevious(start)
        end = divider(document.sections[added]._sectPr); bookmark(end, 'UniworkTOCEnd', identity + 1)
        first_body.addprevious(end); added += 1
    if not has_body_marker:
        bookmark(headings[0]._p if existing_toc and headings else first_body, 'UniworkBodyStart', identity + 2)
    sections = list(document.sections)
    if not preserve:
        for section in sections:
            section.page_width, section.page_height = Mm(210), Mm(297)
            section.top_margin = section.bottom_margin = Mm(23)
            section.left_margin = section.right_margin = Mm(25)
            section.header_distance = section.footer_distance = Mm(10)
    for section in sections[:added]:
        section.page_width, section.page_height = Mm(210), Mm(297)
        for tag in ('headerReference', 'footerReference', 'pgNumType', 'titlePg'):
            for child in list(section._sectPr.findall(W + tag)):
                section._sectPr.remove(child)
        section.header.is_linked_to_previous = False
        section.footer.is_linked_to_previous = False
    # Existing page-number rules and different headers remain intact on multi-section documents.
    if preserve and not added:
        return first_body, False
    body_section = sections[added]
    number = body_section._sectPr.find(W + 'pgNumType')
    if number is None:
        number = OxmlElement('w:pgNumType'); body_section._sectPr.append(number)
    number.set(qn('w:start'), '1')
    body_section.footer.is_linked_to_previous = False
    if not body_section.footer._element.xpath('.//w:instrText[contains(., "PAGE")] | .//w:fldSimple[contains(@w:instr, "PAGE")]'):
        p = body_section.footer.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run('第 ')
        field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE')
        p._p.append(field); p.add_run(' 页')
    return first_body, True
