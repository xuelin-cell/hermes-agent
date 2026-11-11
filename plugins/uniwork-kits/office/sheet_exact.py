"""Bounded numeric edits, real recalculation and original-package publication."""
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

import openpyxl


def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').digest()


def edit(args):
    if __package__:
        from .file_lock import file_lock
        from .office_cli import recalculate
        from .office_formula_edits import preserve_numeric_formula_edits
    else:
        from file_lock import file_lock
        from office_cli import recalculate
        from office_formula_edits import preserve_numeric_formula_edits
    source,output=args.input.resolve(),args.output.resolve()
    if source.suffix.lower()!='.xlsx' or output.suffix.lower()!='.xlsx':
        raise ValueError('Exact numeric editing supports ordinary .xlsx workbooks only')
    changes=json.loads(args.edits)
    if not isinstance(changes,list) or not changes: raise ValueError('edits must be a nonempty array')
    output.parent.mkdir(parents=True,exist_ok=True)
    with file_lock(source),tempfile.TemporaryDirectory(prefix='.sheet-exact-',dir=output.parent) as work:
        baseline=digest(source);staged=Path(work)/'edited.xlsx';verified=Path(work)/'verified.xlsx'
        book=openpyxl.load_workbook(source)
        targets=set()
        for change in changes:
            value=change['value']
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
                raise ValueError('Exact edits accept finite numeric values, not formulas or text')
            cell=book[change['sheet']][change['cell']]
            if cell.data_type=='f' or isinstance(cell.value,bool) or not isinstance(cell.value,(int,float)):
                raise ValueError('The target must be an existing numeric input cell')
            if 'old' in change and cell.value!=change['old']:
                raise ValueError(f"The original value changed at {change['sheet']}!{change['cell']}; no changes published")
            targets.add((change['sheet'],cell.coordinate));cell.value=value
        book.save(staged);book.close()
        recalc=recalculate(staged,args.timeout)
        preserve_numeric_formula_edits(source,staged,verified,allow_value_edits=True,value_targets=targets)
        formulas=openpyxl.load_workbook(verified,data_only=False)
        cached=openpyxl.load_workbook(verified,data_only=True)
        try:
            actual=[{'sheet':c['sheet'],'cell':c['cell'],'value':cached[c['sheet']][c['cell']].value} for c in changes]
            for requested,saved in zip(changes,actual):
                if saved['value']!=requested['value']:raise ValueError('The saved numeric edit differs from the request')
            values={}
            for target in args.inspect:
                sheet,address=target.rsplit('!',1);values[target]=cached[sheet][address].value
            if digest(source)!=baseline:raise ValueError('The source changed during calculation; no changes published')
            os.replace(verified,output)
        finally:
            formulas.close();cached.close()
    return {'output':str(output),'engine':'source_preserving_numeric_edit','saved_in_place':source==output,
            'applied_changes':actual,'values':values,'recalc':recalc,
            'verification':{'original_package_preserved':True,'only_requested_numeric_inputs_changed':True,'real_recalculation':True},
            'next_action':'The requested values were saved and formulas recalculated. Report the returned values now; do not delegate again, recalculate again or create a second workbook.'}
