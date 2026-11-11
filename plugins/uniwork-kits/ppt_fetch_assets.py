"""Land a small batch of searched PPT photographs, preserving successful files."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import json
from pathlib import Path
import time

import httpx
from PIL import Image, UnidentifiedImageError

from .image_landing import fetch


def fetch_assets(output: Path, images: list[dict]) -> dict:
    if not isinstance(images, list) or not 1 <= len(images) <= 8:
        raise ValueError("images一次传1至8条已搜到的原图：url、source_page、title；不要传搜索结果页")
    if any(not isinstance(item, dict) or not isinstance(item.get("url"), str) or not item["url"] for item in images):
        raise ValueError("images每项须有非空url；来源名称不能代替原图地址")
    folder = output / ".ppt-assets"
    folder.mkdir(parents=True, exist_ok=True)

    def download(item):
        url = item["url"]
        key = hashlib.sha256(url.encode()).hexdigest()[:24]
        manifest = folder / (key + ".json")
        start = time.monotonic()
        if manifest.is_file():
            cached = json.loads(manifest.read_text(encoding="utf-8"))
            path = Path(cached["path"])
            if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == cached["sha256"]:
                return {**cached, "reused": True, "seconds": round(time.monotonic()-start, 3)}
        try:
            data = fetch(url, timeout=6)
            with Image.open(BytesIO(data)) as image:
                image.verify()
            with Image.open(BytesIO(data)) as image:
                width, height, kind = image.width, image.height, image.format
            suffix = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}.get(kind)
            if not suffix:
                raise ValueError(f"图片格式{kind}无法直接用于当前PPT，请换JPEG/PNG/WebP")
            path = folder / (key + suffix)
            path.write_bytes(data)
            result = {"ok": True, "url": url, "source_page": item.get("source_page", ""),
                      "title": item.get("title", ""), "path": str(path), "width": width, "height": height,
                      "sha256": hashlib.sha256(data).hexdigest(), "reused": False,
                      "seconds": round(time.monotonic()-start, 3)}
            manifest.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            return result
        except (httpx.HTTPError, OSError, ValueError, UnidentifiedImageError) as exc:
            return {"ok": False, "url": url, "error": str(exc), "seconds": round(time.monotonic()-start, 3)}

    # A query may repeat the same original URL. Download it once, without
    # concurrent writes to its receipt; distinct candidates run in parallel.
    unique = list({item["url"]: item for item in images}.values())
    with ThreadPoolExecutor(max_workers=min(4, len(unique))) as pool:
        results = list(pool.map(download, unique))
    successful=[row for row in results if row['ok']]
    contact=None
    if successful:
        from .ppt_contact_sheet import create
        key=hashlib.sha256(''.join(row['sha256'] for row in successful).encode()).hexdigest()[:16]
        contact=create([(f'Asset {i+1}',Path(row['path'])) for i,row in enumerate(successful)],folder/f'contact-{key}.png',thumbnails=True)
        for i,row in enumerate(successful):row['contact_label']=f'Asset {i+1}'
    return {"ok": any(row["ok"] for row in results), "images": results,
            "contact_sheet":contact,
            "next": "成功项已验文件、尺寸与来源并落盘，直接引用path，不再curl或重复下载。"
                    "先一次查看contact_sheet，逐ID核对主体；不确定的个别图才放大核对。"
                    "保留照片及其来源标记，默认contain完整放图，不为去除水印或避免裁脚反复裁剪识图。"
                    "明确不符的素材只补一轮，仍无法确认用用户允许的标注示意图，推进制作。"}
