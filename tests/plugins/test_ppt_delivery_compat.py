"""Delivery normalization preserves presentation content and editable line geometry."""
import importlib.util
from pathlib import Path
import zipfile
from xml.etree import ElementTree as ET

import pytest

spec = importlib.util.spec_from_file_location('ppt_delivery_compat', Path(__file__).resolve().parents[2] / 'plugins/uniwork-kits/ppt_compat.py')
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)


def test_directory_cleanup_preserves_every_document_part_and_the_working_file(tmp_path):
    source, target = tmp_path / 'working.pptx', tmp_path / 'final.pptx'
    with zipfile.ZipFile(source, 'w') as archive:
        archive.writestr('ppt/', b'')
        archive.writestr('ppt/slides/', b'')
        archive.writestr('ppt/slides/slide1.xml', f'<p:sld xmlns:p="{compat.P[1:-1]}"/>')
        archive.writestr('ppt/media/photo.png', b'original image')
    original = source.read_bytes()
    assert compat.delivery_copy(source, target)['directory_entries_removed'] == 2
    assert source.read_bytes() == original
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(target) as after:
        assert after.namelist() == [info.filename for info in before.infolist() if not info.is_dir()]
        assert all(after.read(name) == before.read(name) for name in after.namelist())


def test_line_normalization_preserves_arrows_geometry_identity_and_namespace_bytes(tmp_path):
    xml = f'''<p:sld xmlns:p="{compat.P[1:-1]}" xmlns:a="{compat.A[1:-1]}"
      xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:vendor" mc:Ignorable="v">
      <p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="7" name="Arrow"/><p:cNvSpPr txBox="0"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm flipH="1"><a:off x="10" y="20"/><a:ext cx="300" cy="400"/></a:xfrm>
      <a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:tailEnd type="triangle"/></a:ln></p:spPr>
      <p:style/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'''.encode()
    source, target = tmp_path / 'working.pptx', tmp_path / 'final.pptx'
    with zipfile.ZipFile(source, 'w') as archive:
        archive.writestr('ppt/slides/slide1.xml', xml)
    assert compat.delivery_copy(source, target)['line_shapes_normalized'] == 1
    with zipfile.ZipFile(target) as archive:
        fixed = archive.read('ppt/slides/slide1.xml')
    before = ET.fromstring(xml).find('.//' + compat.P + 'sp')
    after = ET.fromstring(fixed).find('.//' + compat.P + 'cxnSp')
    assert ET.tostring(after.find(compat.P + 'spPr')) == ET.tostring(before.find(compat.P + 'spPr'))
    assert after.find(compat.P + 'nvCxnSpPr/' + compat.P + 'cNvPr').attrib == before.find(compat.P + 'nvSpPr/' + compat.P + 'cNvPr').attrib
    assert b'xmlns:v="urn:vendor" mc:Ignorable="v"' in fixed
    assert b'<p:style/>' in fixed
    assert compat._line_connectors(fixed) == (fixed, 0)
    with pytest.raises(ValueError, match='contains text'):
        compat._line_connectors(xml.replace(b'<a:p/>', b'<a:p><a:r><a:t>Keep this</a:t></a:r></a:p>'))
