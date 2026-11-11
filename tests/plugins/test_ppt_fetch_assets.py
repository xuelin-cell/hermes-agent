"""PPT downloads retain good candidates and reuse only the owning task's files."""
from io import BytesIO
from pathlib import Path
import sys
import types

from PIL import Image

namespace = types.ModuleType("ppt_fetch_test")
namespace.__path__ = [str(Path(__file__).resolve().parents[2] / "plugins/uniwork-kits")]
sys.modules[namespace.__name__] = namespace
from ppt_fetch_test import ppt_fetch_assets as assets


def test_partial_downloads_and_cache_are_task_scoped(tmp_path, monkeypatch):
    data = BytesIO()
    Image.new("RGB", (160, 90), "blue").save(data, "PNG")
    requests = []

    def fetch(url, **kwargs):
        requests.append(url)
        if url.endswith("/bad"):
            raise ValueError("not an image")
        return data.getvalue()

    monkeypatch.setattr(assets, "fetch", fetch)
    good = {"url": "https://example.org/good", "source_page": "https://example.org/page", "title": "Bridge"}
    bad = {"url": "https://example.org/bad"}
    a, b = tmp_path / "A", tmp_path / "B"
    first = assets.fetch_assets(a, [good, good, bad])
    assert first["ok"] and len(first["images"]) == 2
    assert first["images"][0]["width"] == 160 and not first["images"][1]["ok"]
    other = assets.fetch_assets(b, [good])
    again = assets.fetch_assets(a, [good])
    assert again["images"][0]["reused"] and requests.count(good["url"]) == 2
    assert first["images"][0]["path"] != other["images"][0]["path"]
    path = Path(first["images"][0]["path"])
    path.write_bytes(b"damaged")
    assert not assets.fetch_assets(a, [good])["images"][0]["reused"]
    assert requests.count(good["url"]) == 3
