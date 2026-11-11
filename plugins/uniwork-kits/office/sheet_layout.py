"""Report chart/print-area mismatches without changing existing workbooks."""
from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries, get_column_letter
from openpyxl.worksheet.cell_range import CellRange
import re


def _range(reference):
    return range_boundaries(reference.rsplit('!', 1)[-1])


def chart_print_warnings(path):
    book = load_workbook(path, data_only=False)
    issues = []
    try:
        for sheet in book:
            areas = [CellRange(match) for match in re.findall(r'\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+', sheet.print_area)] if sheet.print_area else []
            for index, chart in enumerate(sheet._charts):
                anchor = chart.anchor
                if not hasattr(anchor, '_from'):
                    continue
                marker = anchor._from
                x, y = marker.colOff / 9525, marker.rowOff / 9525
                if hasattr(anchor, 'ext'):
                    x += anchor.ext.cx / 9525
                    y += anchor.ext.cy / 9525
                    col, row = marker.col + 1, marker.row + 1
                    while x > (sheet.column_dimensions[get_column_letter(col)].width or 13) * 7 + 5:
                        x -= (sheet.column_dimensions[get_column_letter(col)].width or 13) * 7 + 5
                        col += 1
                    while y > (sheet.row_dimensions[row].height or sheet.sheet_format.defaultRowHeight or 15) * 4 / 3:
                        y -= (sheet.row_dimensions[row].height or sheet.sheet_format.defaultRowHeight or 15) * 4 / 3
                        row += 1
                else:
                    col, row = anchor.to.col + 1, anchor.to.row + 1
                if areas and not any(a.min_col <= marker.col + 1 and a.min_row <= marker.row + 1
                                     and a.max_col >= col and a.max_row >= row for a in areas):
                    issues.append({'sheet': sheet.title, 'chart': index, 'problem': 'chart_outside_print_area',
                                   'required_bottom_right': f'{get_column_letter(col)}{row}',
                                   'print_area': str(sheet.print_area)})
                for series in chart.series:
                    cats = getattr(series, 'cat', None)
                    values = getattr(series, 'val', None)
                    catref = getattr(cats, 'numRef', None) or getattr(cats, 'strRef', None)
                    valref = getattr(values, 'numRef', None)
                    if catref is None or valref is None or not catref.f or not valref.f:
                        continue
                    c, v = _range(catref.f), _range(valref.f)
                    if (c[0] == c[2] and v[0] == v[2] and c[1::2] != v[1::2]
                            or c[1] == c[3] and v[1] == v[3] and c[::2] != v[::2]):
                        issues.append({'sheet': sheet.title, 'chart': index, 'problem': 'category_value_range_misaligned',
                                       'categories': catref.f, 'values': valref.f})
        return issues
    finally:
        book.close()
