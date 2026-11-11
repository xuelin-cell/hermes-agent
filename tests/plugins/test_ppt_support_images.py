"""Exercise the photo manifest through real HTTP and file I/O in a temp home."""
import importlib.util
import io
import json
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture
def image_client(monkeypatch):
    source = Path(__file__).parents[2] / "plugins/uniwork-kits/pptx_support/commons_images.py"
    spec = importlib.util.spec_from_file_location("ppt_commons_test", source)
    monkeypatch.syspath_prepend(str(source.parent))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    data = io.BytesIO()
    Image.new("RGB", (1200, 800), "green").save(data, format="PNG")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if self.path.startswith("/image"):
                body = data.getvalue() if self.path == "/image-good" else b"not an image"
            else:
                args = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                if args.get("gsrsearch") == ["limited"]:
                    self.send_response(429)
                    self.send_header("Retry-After", "120")
                    self.end_headers()
                    return
                title = args.get("titles", ["File:Chosen bird.png"])[0]
                kind = "bad" if "Broken" in title else "good"
                body = json.dumps({"query": {"pages": [{"title": title, "imageinfo": [{
                    "width": 1200, "height": 800, "mime": "image/png",
                    "thumburl": "https://thumb.wikimedia.org/image-" + kind,
                    "descriptionurl": "https://commons.wikimedia.org/wiki/" + title,
                    "extmetadata": {"Artist": {"value": "<a>A photographer</a>"},
                                    "LicenseShortName": {"value": "CC BY 4.0"}},
                }]}]}}).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{server.server_port}"
    original = urllib.request.urlopen

    def transport(request, **kwargs):
        # Only the test transport relocates Wikimedia's image host onto the local fixture.
        if urllib.parse.urlsplit(request.full_url).hostname in ("upload.wikimedia.org", "thumb.wikimedia.org"):
            request = urllib.request.Request(base + urllib.parse.urlsplit(request.full_url).path)
        return original(request, **kwargs)

    monkeypatch.setattr(urllib.request, "urlopen", transport)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    try:
        yield module.CommonsClient(base + "/api"), requests, module
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_search_never_selects_or_downloads_and_selection_keeps_real_dimensions(image_client, tmp_path):
    client, requests, _ = image_client
    candidates = client.search([{"key": "bird", "query": "a bird", "purpose": "show the entire body"}])
    assert not any(path.startswith("/image") for path in requests)
    chosen = candidates["subjects"][0]["candidates"][0]
    result = client.download([{"key": "bird", "title": chosen["title"], "purpose": "entire body"}], tmp_path)
    item = result["images"][0]
    assert (item["w"], item["h"]) == (1200, 800)
    assert item["title"] == chosen["title"] and item["source_url"] == chosen["source_url"]
    assert item["artist"] == "A photographer" and item["license"] == "CC BY 4.0"
    assert item["status"] == "downloaded_needs_review"
    assert Path(item["path"]).is_file() and Path(item["path"]).parent == tmp_path


def test_broken_photo_does_not_replace_a_good_one_or_claim_success(image_client, tmp_path):
    client, _, _ = image_client
    valid = client.download([{"key": "bird", "title": "File:Chosen bird.png"}], tmp_path)["images"][0]
    before = Path(valid["path"]).read_bytes()
    broken = client.download([{"key": "bird", "title": "File:Broken bird.png"}], tmp_path)["images"][0]
    assert broken["status"] == "failed" and "path" not in broken
    assert Path(valid["path"]).read_bytes() == before
    with pytest.raises(ValueError):
        client.download([{"key": "../other-session", "title": "File:Chosen bird.png"}], tmp_path)


def test_rate_limit_preserves_full_retry_after_and_is_shared_before_more_http(image_client, tmp_path):
    client, requests, module = image_client
    client.gate = module.TrafficGate(tmp_path / "traffic.db")
    subjects = [{"key": "limited", "query": "limited"}, {"key": "later", "query": "another bird"}]
    result = client.search(subjects)
    assert len(requests) == 1
    assert all(item["status"] == "failed" and item["retry_after_seconds"] >= 120 for item in result["subjects"])
    other = module.CommonsClient(client.api)
    other.gate = module.TrafficGate(client.gate.path)
    with pytest.raises(module.CoolingDown) as error:
        other.get(client.api)
    assert error.value.retry_after_seconds >= 119 and len(requests) == 1
    from email.utils import formatdate
    assert module.retry_delay(formatdate(1120, usegmt=True), now=1000) == 120


def test_partial_search_is_saved_and_retry_does_not_repeat_successful_queries(image_client, tmp_path):
    client, requests, _ = image_client
    output = tmp_path / "assets/candidates.json"
    subjects = [{"key": "bird", "query": "a bird"}, {"key": "limited", "query": "limited"}]
    first = client.search(subjects, output)
    assert json.loads(output.read_text())["subjects"] == first["subjects"]
    assert [item["status"] for item in first["subjects"]] == ["candidates", "failed"]
    second = client.search(subjects, output)
    queries = [urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).get("gsrsearch") for path in requests]
    assert queries.count(["a bird"]) == 1 and queries.count(["limited"]) == 2
    assert second["subjects"][0]["candidates"] == first["subjects"][0]["candidates"]
