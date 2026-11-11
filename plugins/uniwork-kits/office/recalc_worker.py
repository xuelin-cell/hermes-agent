"""Run the original recalculation flow, counting only actual Excel error cells."""
from pathlib import Path
import runpy
import sys

from office_runtime import recalc_path


def scan(filename):
    from openpyxl import load_workbook
    errors={}
    book=load_workbook(filename,data_only=True)
    try:
        for sheet in book:
            if not hasattr(sheet,'iter_rows'):continue
            # openpyxl is pinned to 3.1.5. Iterate physical cells, not the bounding
            # rectangle: SDK formatting can leave a cell at Excel's last row.
            for cell in sheet._cells.values():
                if cell.data_type=='e':errors.setdefault(str(cell.value),[]).append(f'{sheet.title}!{cell.coordinate}')
    finally:book.close()
    return sum(len(cells) for cells in errors.values()),{error:{'count':len(cells),'cells':cells} for error,cells in errors.items()}


def formula_cells(filename,formula_text):
    from openpyxl import load_workbook
    from openpyxl.worksheet.formula import ArrayFormula
    book=load_workbook(filename,data_only=False)
    try:
        return [(sheet.title,cell.coordinate,text,isinstance(cell.value,ArrayFormula))
                for sheet in book if hasattr(sheet,'iter_rows')
                for cell in sheet._cells.values() if (text:=formula_text(cell)) is not None]
    finally:book.close()


if __name__=='__main__':
    sys.path.insert(0,str(recalc_path().parent))
    module=runpy.run_path(str(recalc_path()),run_name='workbuddy_recalc')
    module['main'].__globals__['_scan_cached_errors']=scan
    module['main'].__globals__['_formula_cells']=lambda filename:formula_cells(filename,module['_formula_text'])
    module['main']()
