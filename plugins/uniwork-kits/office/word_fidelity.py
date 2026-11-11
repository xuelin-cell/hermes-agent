"""Compare semantic side parts and section furniture without freezing field caches."""
from collections import Counter
import re
import posixpath
import zipfile
from lxml import etree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
NS = {'w': W[1:-1]}


def literal_text(root):
    fields, values = [], []
    for element in root.iter():
        if element.tag == W + 'fldChar':
            kind = element.get(W + 'fldCharType')
            if kind == 'begin': fields.append('')
            elif kind == 'end' and fields: fields.pop()
        elif element.tag == W + 'instrText' and fields:
            fields[-1] += element.text or ''
        elif element.tag == W + 't':
            simple = [p.get(W + 'instr', '') for p in element.iterancestors(W + 'fldSimple')]
            if not any(re.match(r'\s*(?:PAGE|NUMPAGES|SECTIONPAGES)\b', value) for value in fields + simple):
                values.append(element.text or '')
    return ''.join(''.join(values).split())


def side_signature(path):
    annotations, furniture = [], []
    with zipfile.ZipFile(path) as archive:
        body = etree.fromstring(archive.read('word/document.xml'))
        for filename, tag in [('word/comments.xml', 'comment'), ('word/footnotes.xml', 'footnote'), ('word/endnotes.xml', 'endnote')]:
            if filename not in archive.namelist(): continue
            root = etree.fromstring(archive.read(filename))
            notes = {node.get(W + 'id'): ''.join(node.itertext(W + 't')) for node in root.findall(W + tag) if ''.join(node.itertext(W + 't'))}
            anchors = 'commentRangeStart' if tag == 'comment' else tag + 'Reference'
            for anchor in body.iter(W + anchors):
                paragraph = next(anchor.iterancestors(W + 'p'), None)
                if paragraph is not None:
                    annotations.append((tag, notes.get(anchor.get(W + 'id')), ''.join(paragraph.itertext(W + 't'))))
        relationships = etree.fromstring(archive.read('word/_rels/document.xml.rels'))
        targets = {node.get('Id'): (node.get('Target').lstrip('/') if node.get('Target').startswith('/')
                                   else posixpath.normpath('word/' + node.get('Target'))) for node in relationships}
        active = {targets.get(node.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
                  for tag in ['headerReference', 'footerReference'] for node in body.iter(W + tag)}
        for name in active:
            if name in archive.namelist() and re.fullmatch(r'word/(?:header|footer)\d+\.xml', name):
                text = literal_text(etree.fromstring(archive.read(name)))
                if text: furniture.append(text)
        sections = []
        for section in body.iter(W + 'sectPr'):
            sections.append({name:dict(section.find(W + name).attrib) if section.find(W + name) is not None else {}
                             for name in ['pgSz', 'pgMar', 'pgNumType', 'type']})
    return {'annotations': sorted(annotations), 'furniture': sorted(furniture), 'sections': sections}


def verify_sides(source, saved, *, preserve_sections, reference=False):
    if source['annotations'] != saved['annotations']:
        raise ValueError('Formatted Word changed footnotes, endnotes or comment anchors')
    if not reference and not Counter(source['furniture']) <= Counter(saved['furniture']):
        raise ValueError('Formatted Word changed original header/footer text')
    if preserve_sections and source['sections'] != saved['sections']:
        # Editors may expand omitted defaults; compare geometry and explicit numbering only.
        if len(source['sections']) != len(saved['sections']):
            raise ValueError('Formatted Word changed the section count')
        for before, after in zip(source['sections'], saved['sections']):
            for tag in ['pgSz', 'pgMar', 'pgNumType', 'type']:
                if any(after[tag].get(key) != value for key,value in before[tag].items()):
                    raise ValueError(f'Formatted Word changed the original section {tag}')
