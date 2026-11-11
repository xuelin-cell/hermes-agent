"""Normalize observed SDK packaging quirks in the delivery copy, preserving source bytes."""
from io import BytesIO
from pathlib import Path
import re
import shutil
import zipfile
from xml.etree import ElementTree as ET

P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'


def _line_connectors(data):
    root = ET.fromstring(data)
    shapes = list(root.iter(P + 'sp'))
    lines = [i for i, node in enumerate(shapes)
             if (geometry := node.find(P + 'spPr/' + A + 'prstGeom')) is not None
             and geometry.get('prst') == 'line']
    if not lines:
        return data, 0
    if any((text.text or '').strip() for i in lines for text in shapes[i].iter(A + 't')):
        raise ValueError('SDK line shape contains text; preserve it with an editable text box before delivery')
    namespaces = dict(value for _, value in ET.iterparse(BytesIO(data), events=['start-ns']))
    prefix = next(key for key, uri in namespaces.items() if uri == P[1:-1])
    tag = re.escape(prefix + ':' if prefix else '')
    ordinal = -1

    def convert(match):
        nonlocal ordinal
        ordinal += 1
        if ordinal not in lines:
            return match.group()
        fragment = match.group()
        # Surgical edits preserve all other bytes, including namespace declarations
        # referenced by mc:Ignorable and vendor extension attributes.
        for old, new in [('sp', 'cxnSp'), ('nvSpPr', 'nvCxnSpPr'), ('cNvSpPr', 'cNvCxnSpPr')]:
            fragment = re.sub(r'(<\/?)(' + tag + ')' + old + r'(?=[\s/>])',
                              lambda m: m[1] + m[2] + new, fragment)
        fragment = re.sub(r'<' + tag + r'txBody\b[^>]*>.*?</' + tag + r'txBody\s*>', '', fragment, flags=re.S)
        fragment = re.sub(r'(<' + tag + r'cNvCxnSpPr\b[^>]*?)\s+txBox=["\'][^"\']*["\']', r'\1', fragment)
        return fragment

    result = re.sub(r'<' + tag + r'sp\b[^>]*>.*?</' + tag + r'sp\s*>', convert, data.decode('utf-8'), flags=re.S)
    if ordinal + 1 != len(shapes):
        raise ValueError('Unsupported SDK line XML; delivery was not rewritten')
    return result.encode('utf-8'), len(lines)


def delivery_copy(source: Path, target: Path):
    stats = {'directory_entries_removed': 0, 'line_shapes_normalized': 0}
    with zipfile.ZipFile(source) as archive:
        replacements = {}
        for entry in archive.infolist():
            if entry.is_dir():
                stats['directory_entries_removed'] += 1
            elif re.fullmatch(r'ppt/slides/slide\d+\.xml', entry.filename):
                data, count = _line_connectors(archive.read(entry))
                if count:
                    replacements[entry.filename] = data
                    stats['line_shapes_normalized'] += count
        if not any(stats.values()):
            shutil.copyfile(source, target)
            return stats
        with zipfile.ZipFile(target, 'w') as output:
            output.comment = archive.comment
            for entry in archive.infolist():
                if not entry.is_dir():
                    output.writestr(entry, replacements.get(entry.filename, archive.read(entry)))
    return stats
