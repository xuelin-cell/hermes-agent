"""PPT photo search and explicit-selection download; no model calls or credentials.

search --request subjects.json --out assets/candidates.json
download --selection selection.json --out assets/photos.json
See README.md for the two input formats. Candidates are data, not verified identities.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from commons_transport import CoolingDown, TrafficGate, retry_delay

API = "https://commons.wikimedia.org/w/api.php"
MAX_BYTES = 16 * 1024 * 1024


def plain(value):
    return html.unescape(re.sub(r"<[^>]*>", "", str(value or ""))).strip()


class CommonsClient:
    def __init__(self, api=API):
        self.api = api
        self.retries = 0
        self.gate = TrafficGate() if api == API else None

    def get(self, url):
        for attempt in range(3):
            try:
                host = urllib.parse.urlsplit(url).hostname
                if self.gate:
                    self.gate.acquire(host)
                request = urllib.request.Request(url, headers={
                    "User-Agent": "UniWork-PPT/1.1 (+https://github.com/NousResearch/hermes-agent)"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ValueError("response exceeds 16 MiB")
                return data
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 503):
                    delay = retry_delay(exc.headers.get("Retry-After"))
                    if self.gate:
                        self.gate.cooldown(host, delay)
                    raise CoolingDown(delay) from exc
                if exc.code not in (429, 502, 503, 504) or attempt == 2:
                    raise
                self.retries += 1
                delay = retry_delay(exc.headers.get("Retry-After"), fallback=8 * 2**attempt)
                time.sleep(delay)

    def query(self, **params):
        params.update(action="query", format="json", formatversion=2, prop="imageinfo",
                      iiprop="url|size|mime|extmetadata", iiurlwidth=1600)
        data = json.loads(self.get(self.api + "?" + urllib.parse.urlencode(params)))
        if "error" in data:
            raise ValueError(str(data["error"].get("code", "Commons API error")))
        pages = data.get("query", {}).get("pages", [])
        results = []
        for page in sorted(pages, key=lambda p: p.get("index", 0)):
            infos = page.get("imageinfo") or []
            if not infos:
                continue
            info = infos[0]
            if info.get("mime") not in ("image/jpeg", "image/png"):
                continue
            if max(info.get("width", 0), info.get("height", 0)) < 1000:
                continue
            meta = info.get("extmetadata") or {}
            def field(key):
                return plain((meta.get(key) or {}).get("value"))
            results.append({
                "title": page["title"], "width": info["width"], "height": info["height"],
                "source_url": info.get("descriptionurl", ""),
                "image_url": info.get("thumburl") or info.get("url", ""),
                "artist": field("Artist"), "license": field("LicenseShortName"),
                "license_url": field("LicenseUrl"), "description": field("ImageDescription")[:600],
            })
        return results

    def search(self, subjects, output=None):
        results = []
        previous = {}
        if output and output.exists():
            saved = json.loads(output.read_text(encoding="utf-8"))
            previous = {item["key"]: item for item in saved.get("subjects", [])}
        blocked = None
        for subject in subjects:
            key = safe_key(subject["key"])
            query = str(subject["query"]).strip()
            if not query or len(query) > 250:
                raise ValueError("query must have 1–250 characters")
            old = previous.get(key, {})
            if old.get("query") == query and old.get("status") in ("candidates", "not_found"):
                results.append({**old, "purpose": str(subject.get("purpose", ""))})
                continue
            try:
                if blocked:
                    raise blocked
                items = self.query(generator="search", gsrsearch=query, gsrnamespace=6, gsrlimit=8)
            except (OSError, ValueError) as exc:
                results.append({"key": key, "query": query, "purpose": str(subject.get("purpose", "")),
                                "candidates": [], "status": "failed", "error": str(exc)})
                if isinstance(exc, CoolingDown):
                    blocked = exc
                    results[-1]["retry_after_seconds"] = exc.retry_after_seconds
                if output:
                    write_manifest(output, {"subjects": results})
                continue
            for item in items:
                item.pop("image_url", None)  # The model selects titles, not long encoded transport URLs.
            results.append({"key": key, "query": query, "purpose": str(subject.get("purpose", "")),
                            "candidates": items, "status": "candidates" if items else "not_found"})
            if output:
                write_manifest(output, {"subjects": results})
            time.sleep(1)
        return {"subjects": results}

    def download(self, selections, folder):
        from PIL import Image

        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        results = []
        blocked = None
        keys = [safe_key(s["key"]) for s in selections]
        if len(keys) != len(set(keys)):
            raise ValueError("selection keys must be unique")
        for selection in selections:
            started = time.monotonic()
            key = safe_key(selection["key"])
            title = str(selection["title"])
            if not title.startswith("File:"):
                raise ValueError("select a complete File: title from candidates")
            try:
                if blocked:
                    raise blocked
                candidates = self.query(titles=title)
                if not candidates:
                    raise ValueError("selected file missing, unsupported, or below 1000 pixels")
                item = candidates[0]
                url = item.pop("image_url")
                if urllib.parse.urlsplit(url).hostname not in ("upload.wikimedia.org", "thumb.wikimedia.org"):
                    raise ValueError("download URL is not a Wikimedia image host")
                data = self.get(url)
                with Image.open(io.BytesIO(data)) as image:
                    if image.format not in ("JPEG", "PNG"):
                        raise ValueError("download is not a JPEG or PNG")
                    width, height = image.size
                    image.verify()
                    ext = ".jpg" if image.format == "JPEG" else ".png"
                if max(width, height) < 1000:
                    raise ValueError("downloaded image is below 1000 pixels")
                digest = hashlib.sha256(data).hexdigest()
                path = folder / (key + "-" + digest[:12] + ext)
                path.write_bytes(data)
                item.update(key=key, path=str(path.resolve()), w=width, h=height,
                            sha256=digest, purpose=str(selection.get("purpose", "")),
                            status="downloaded_needs_review")
            except (OSError, ValueError) as exc:
                item = {"key": key, "title": title, "status": "failed", "error": str(exc)}
                if isinstance(exc, CoolingDown):
                    blocked = exc
                    item["retry_after_seconds"] = exc.retry_after_seconds
            item["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            results.append(item)
            time.sleep(1)
        return {"images": results}


def safe_key(value):
    value = str(value)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise ValueError("key must be a short alphanumeric identifier")
    return value


def write_manifest(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    pending.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    search = sub.add_parser("search")
    search.add_argument("--request", required=True)
    search.add_argument("--out", required=True)
    download = sub.add_parser("download")
    download.add_argument("--selection", required=True)
    download.add_argument("--out", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    client = CommonsClient()
    source = Path(args.request if args.command == "search" else args.selection)
    body = json.loads(source.read_text(encoding="utf-8-sig"))
    entries = body["subjects" if args.command == "search" else "images"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= 20:
        parser.error("provide 1–20 subjects or selected images")
    output = Path(args.out).resolve()
    if args.command == "search":
        result = client.search(entries, output)
    else:
        result = client.download(entries, output.parent / "commons")
    result["timing"] = {"elapsed_ms": round((time.monotonic() - started) * 1000), "http_retries": client.retries}
    write_manifest(output, result)
    print(json.dumps({"manifest": str(output), "timing": result["timing"]}, ensure_ascii=False))
    if any(item.get("status") == "failed" for item in result.get("images", []) + result.get("subjects", [])):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
