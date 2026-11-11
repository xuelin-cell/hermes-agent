"""Bounded Word text edits that never round-trip the package through an editor."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
import zipfile
import xml.etree.ElementTree as etree
from xml.parsers import expat
from xml.sax.saxutils import escape

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
W = '{' + NS['w'] + '}'


def text(node):
    return ''.join(t.text or '' for t in node.iter(W + 't'))


def replace_text(node, old: str, new: str):
    """Keep the runs/formatting on both sides of a replacement, including split runs."""
    nodes = list(node.iter(W + 't'))
    combined = ''.join(t.text or '' for t in nodes)
    if combined.count(old) != 1:
        raise ValueError('The selected Word target must contain the old text exactly once')
    begin = combined.index(old)
    end = begin + len(old)
    offset = 0
    inserted = False
    for item in nodes:
        value = item.text or ''
        right = offset + len(value)
        if offset < end and right > begin:
            before = value[:max(0, begin - offset)]
            after = value[max(0, end - offset):]
            item.text = before + (new if not inserted else '') + after
            inserted = True
        offset = right


def patch_text_bytes(xml, root):
    """Touch only changed text nodes, retaining namespace declarations and opaque XML."""
    parser = expat.ParserCreate(namespace_separator=' ')
    tag = re.compile(rb'''<[^\s/>]+(?:[^"'>]|"[^"]*"|'[^']*')*>''')
    ranges = []
    active = None

    def start(name, _):
        nonlocal active
        if name == NS['w'] + ' t':
            opening = tag.match(xml, parser.CurrentByteIndex)
            active = (parser.CurrentByteIndex, opening.end(), opening.group().endswith(b'/>'))

    def end(name):
        nonlocal active
        if name == NS['w'] + ' t':
            ranges.append((*active, parser.CurrentByteIndex))
            active = None

    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.Parse(xml, True)
    original = list(etree.fromstring(xml).iter(W + 't'))
    nodes = list(root.iter(W + 't'))
    if len(original) != len(nodes) or len(nodes) != len(ranges):
        raise ValueError('Word text edit changed the document structure')
    replacements = []
    for old, new, (begin, content, empty, end) in zip(original, nodes, ranges):
        if old.text == new.text:
            continue
        if empty:
            raise ValueError('Cannot replace text in an empty Word XML element')
        opening = xml[begin:content]
        if b'xml:space=' not in opening:
            opening = opening[:-1] + b' xml:space="preserve">'
        else:
            opening = re.sub(rb'''xml:space=("[^"]*"|'[^']*')''', b'xml:space="preserve"', opening)
        replacements.append((begin, end, opening + escape(new.text or '').replace('\r', '&#13;').encode('utf-8')))
    for begin, end, value in reversed(replacements):
        xml = xml[:begin] + value + xml[end:]
    return xml


def edit_exact(source: Path, output: Path, changes: Path | list) -> dict:
    edits = changes if isinstance(changes, list) else json.loads(changes.read_text(encoding='utf-8'))
    if not isinstance(edits, list) or not edits:
        raise ValueError('Word changes must be a nonempty JSON array')
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        parts = {entry.filename: archive.read(entry) for entry in entries}
    root = etree.fromstring(parts['word/document.xml'])
    body = root.find(W + 'body')
    if body is None:
        raise ValueError('Word document has no body')
    before = text(body)
    for edit in edits:
        old, new = edit['old'], edit['new']
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ValueError('Every change needs nonempty old text and a string new value')
        if 'table' in edit:
            if 'paragraph_contains' in edit:
                raise ValueError('Use a table cell or paragraph selector, not both')
            indexes = [edit.get(key) for key in ('table', 'row', 'column')]
            if any(not isinstance(index, int) or index < 0 for index in indexes):
                raise ValueError('table, row and column are zero-based nonnegative integers')
            try:
                target = list(body.iter(W + 'tbl'))[indexes[0]].findall(W + 'tr')[indexes[1]].findall(W + 'tc')[indexes[2]]
            except IndexError as error:
                raise ValueError('The requested Word table cell does not exist') from error
        else:
            targets = [p for p in body.iter(W + 'p')
                       if old in text(p) and edit.get('paragraph_contains', old) in text(p)]
            if len(targets) != 1:
                raise ValueError(f'Word change is ambiguous: matched {len(targets)} paragraphs; supply paragraph_contains or a table cell')
            target = targets[0]
        replace_text(target, old, new)
    updated = patch_text_bytes(parts['word/document.xml'], root)
    if text(etree.fromstring(updated)) != text(root):
        raise ValueError('The serialized Word text does not match the requested edits')
    # No styles, relationships, images, field codes, headers or other package parts are saved by an editor.
    parts['word/document.xml'] = updated
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.docx', delete=False) as stream:
        staged = Path(stream.name)
    try:
        with zipfile.ZipFile(staged, 'w') as archive:
            for entry in entries:
                archive.writestr(entry, parts[entry.filename])
        os.replace(staged, output)
    finally:
        staged.unlink(missing_ok=True)
    return {'output': str(output.resolve()), 'engine': 'ooxml_exact_edit', 'edits': len(edits), 'applied_changes': edits,
            'verification': {'unchanged_package_parts': len(parts) - 1, 'changed_part': 'word/document.xml',
                             'text_changed': before != text(body)},
            'next_action': 'Only the requested text was edited; other package parts are byte-identical. Present the revised Word file once; no layout/export/style reinspection is needed.'}
