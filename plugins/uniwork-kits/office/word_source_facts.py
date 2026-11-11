"""Read native attachment text/data for the independent Word factual review."""
import json
from pathlib import Path
import sys
import zipfile
import xml.etree.ElementTree as ET


def extract(path):
    path=Path(path);suffix=path.suffix.lower()
    if suffix=='.docx':
        with zipfile.ZipFile(path) as archive:
            root=ET.fromstring(archive.read('word/document.xml'))
        w='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        return {'file':path.name,'paragraphs':[''.join(t.text or '' for t in p.iter(w+'t')) for p in root.iter(w+'p')]}
    if suffix=='.pdf':
        import pymupdf
        with pymupdf.open(path) as document:
            return {'file':path.name,'pages':[{'page':i+1,'text':page.get_text(sort=True)} for i,page in enumerate(document)]}
    if suffix=='.xlsx':
        import openpyxl
        book=openpyxl.load_workbook(path,data_only=False)
        try:
            return {'file':path.name,'sheets':[{'name':sheet.title,'cells':{cell.coordinate:cell.value for cell in sheet._cells.values() if cell.value is not None}} for sheet in book]}
        finally:book.close()
    raise ValueError('Native factual review supports DOCX, PDF and XLSX attachments')


if __name__=='__main__':
    print(json.dumps([extract(path) for path in sys.argv[1:]],ensure_ascii=False,default=str))
