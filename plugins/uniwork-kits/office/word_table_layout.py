"""Fit an overflowing native table to its owning section without rewriting cells."""
from docx.oxml.ns import qn


def fit_tables(document):
    sections = list(document.element.body.iter(qn('w:sectPr')))
    adjusted = 0
    for table in document.tables:
        boundary = next((node for sibling in table._tbl.itersiblings()
                         for node in sibling.iter(qn('w:sectPr'))), None)
        if boundary is None:
            boundary = document.element.body.find(qn('w:sectPr'))
        section = document.sections[sections.index(boundary)]
        available = int((section.page_width - section.left_margin - section.right_margin) / 635)
        grid = table._tbl.tblGrid
        widths = [int(node.get(qn('w:w'))) for node in grid]
        total = sum(widths)
        if total <= available:
            continue
        ratio = available / total
        for node, width in zip(grid, widths):
            node.set(qn('w:w'), str(round(width * ratio)))
        for cell in table._tbl.iter(qn('w:tc')):
            width = cell.find('./' + qn('w:tcPr') + '/' + qn('w:tcW'))
            if width is not None and width.get(qn('w:type')) == 'dxa':
                width.set(qn('w:w'), str(round(int(width.get(qn('w:w'))) * ratio)))
        table.autofit = False
        adjusted += 1
    return adjusted
