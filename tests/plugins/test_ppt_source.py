"""Native extraction is ordered, reusable and isolated to the owning output directory."""
import importlib.util
from pathlib import Path
import zipfile
from io import BytesIO

from PIL import Image

spec = importlib.util.spec_from_file_location("ppt_source_tested", Path(__file__).resolve().parents[2] / "plugins/uniwork-kits/ppt_source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


def test_docx_sources_keep_native_words_image_order_and_scoped_cache(tmp_path):
    def image(color):
        data = BytesIO()
        Image.new("RGB", (80, 40), color).save(data, "PNG")
        return data.getvalue()

    doc = tmp_path / "input.docx"
    with zipfile.ZipFile(doc, "w") as archive:
        archive.writestr("word/document.xml", '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <w:body><w:p><w:r><w:t>贷款余额</w:t></w:r><w:r><w:t>≥10,000元</w:t></w:r></w:p>
          <a:blip r:embed="r2"/><a:blip r:embed="r1"/></w:body></w:document>''')
        archive.writestr("word/_rels/document.xml.rels", '<Relationships><Relationship Id="r1" Target="media/one.png"/><Relationship Id="r2" Target="media/two.png"/></Relationships>')
        archive.writestr("word/media/one.png", image("red"))
        archive.writestr("word/media/two.png", image("blue"))
    a, b = tmp_path / "A/outputs", tmp_path / "B/outputs"
    first = source.prepare_sources(a, [str(doc)])
    other = source.prepare_sources(b, [str(doc)])
    again = source.prepare_sources(a, [str(doc)])
    assert again["reused"] and first["manifest_file"] == again["manifest_file"] != other["manifest_file"]
    assert first["sources"][0]["blocks"][0]["text"] == "贷款余额≥10,000元"
    pics = first["sources"][0]["images"]
    with Image.open(pics[0]["path"]) as original:
        assert original.getpixel((0, 0)) == (0, 0, 255)
    assert all(Path(p["path"]).is_relative_to(a) for p in pics)
    crop = source.prepare_sources(a, [pics[0]["path"]], [{"source": 0, "box": [0, 0, 20, 10]}])
    assert crop["sources"][0]["images"][-1]["original_box"] == [0, 0, 20, 10]
    doc.write_bytes(doc.read_bytes() + b"updated")
    assert not source.prepare_sources(a, [str(doc)])["reused"]
