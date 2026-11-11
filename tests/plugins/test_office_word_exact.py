"""Bounded Word edits preserve opaque OOXML and reject ambiguous changes atomically."""
import json
from pathlib import Path
import sys
import types
import zipfile

import pytest

namespace = types.ModuleType('office_word_test')
namespace.__path__ = [str(Path(__file__).parents[2] / 'plugins/uniwork-kits')]
sys.modules[namespace.__name__] = namespace
from office_word_test.office.word_exact import edit_exact


def package(path, xml):
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('word/document.xml', xml)
        archive.writestr('word/styles.xml', b'opaque-styles')
        archive.writestr('word/media/photo.png', b'opaque-image')


def test_split_run_edit_preserves_all_other_parts_and_xml_bytes(tmp_path):
    source, target, changes = (tmp_path / name for name in ('source.docx', 'result.docx', 'edits.json'))
    xml = (b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
           b'xmlns:custom="urn:keep-unused"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr>'
           b'<w:t>before OLD</w:t></w:r><w:r><w:t>TEXT after</w:t></w:r></w:p></w:body></w:document>')
    package(source, xml)
    before = source.read_bytes()
    changes.write_text(json.dumps([{'old': 'OLDTEXT', 'new': 'NEW & <value>'}]), encoding='utf-8')
    receipt = edit_exact(source, target, changes)
    with zipfile.ZipFile(target) as archive:
        assert archive.read('word/styles.xml') == b'opaque-styles'
        assert archive.read('word/media/photo.png') == b'opaque-image'
        expected = xml.replace(b'<w:t>before OLD</w:t>', b'<w:t xml:space="preserve">before NEW &amp; &lt;value&gt;</w:t>')
        expected = expected.replace(b'<w:t>TEXT after</w:t>', b'<w:t xml:space="preserve"> after</w:t>')
        assert archive.read('word/document.xml') == expected
    assert source.read_bytes() == before
    assert receipt['verification']['unchanged_package_parts'] == 2


def test_ambiguous_edit_does_not_publish_partial_changes(tmp_path):
    source, target, changes = (tmp_path / name for name in ('source.docx', 'result.docx', 'edits.json'))
    package(source, b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                    b'<w:body><w:p><w:r><w:t>same one</w:t></w:r></w:p>'
                    b'<w:p><w:r><w:t>same two</w:t></w:r></w:p></w:body></w:document>')
    target.write_bytes(b'existing-good-file')
    changes.write_text(json.dumps([{'old': 'one', 'new': 'three'}, {'old': 'same', 'new': 'changed'}]), encoding='utf-8')
    with pytest.raises(ValueError, match='ambiguous'):
        edit_exact(source, target, changes)
    assert target.read_bytes() == b'existing-good-file'
