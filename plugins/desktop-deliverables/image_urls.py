"""桌面多模态图片经元景对象存储交付，模型请求只携带 HTTPS 链接。"""

import base64
from collections import OrderedDict
from concurrent.futures import Future
import hashlib
import mimetypes
from pathlib import Path
import tempfile
from threading import RLock
import time

from . import uploads

_lock = RLock()
_urls = OrderedDict()


def uploaded_url(data_url, prefix):
    """按账号和图片内容复用有效链接，同一图片并发上传只执行一次。"""
    from hermes_constants import get_hermes_home

    header, separator, encoded = data_url.partition(",")
    if (
        not separator
        or not header.startswith("data:image/")
        or not header.endswith(";base64")
    ):
        raise uploads.Refusal("图片数据格式无效，请重新添加图片。")
    if len(encoded) > 4 * ((uploads.MAX_BYTES + 2) // 3):
        raise uploads.Refusal("图片超过元景上传大小限制，请缩小后重试。")
    mime = header[5:].split(";", 1)[0]
    digest = hashlib.sha256(data_url.encode("ascii")).hexdigest()
    key = (str(get_hermes_home().resolve()), prefix, digest)
    with _lock:
        future = _urls.get(key)
        if future is not None and future.done():
            _, expires = future.result()
            if expires <= time.time() + uploads.LINK_MARGIN:
                future = None
        owner = future is None
        if owner:
            future = Future()
            _urls[key] = future
        _urls.move_to_end(key)
        while len(_urls) > 128:
            _urls.popitem(last=False)
    if not owner:
        return future.result()[0]
    try:
        raw = base64.b64decode(encoded, validate=True)
        if not raw or len(raw) > uploads.MAX_BYTES:
            raise uploads.Refusal("图片为空或超过元景上传大小限制，请重新添加图片。")
        suffix = mimetypes.guess_extension(mime) or ".img"
        with tempfile.TemporaryDirectory(prefix="hermes-image-url-") as folder:
            path = Path(folder) / ("image" + suffix)
            path.write_bytes(raw)
            url = uploads.upload_url(prefix, path)
        # 无有效期的地址只服务本次等待中的请求，下次重新获取。
        expires = uploads.link_expiry(url) or time.time()
        future.set_result((url, expires))
        return url
    except Exception as exc:
        with _lock:
            if _urls.get(key) is future:
                _urls.pop(key)
            future.set_exception(exc)
        raise


def rewrite_part(part, prefix):
    """替换三种原生图片部件，保留清晰度等字段和已有网络链接。"""
    if not isinstance(part, dict):
        return part
    kind = part.get("type")
    if kind in {"image_url", "input_image"}:
        image = part.get("image_url")
        url = image.get("url") if isinstance(image, dict) else image
        if isinstance(url, str) and url.startswith("data:image/"):
            linked = uploaded_url(url, prefix)
            return {
                **part,
                "image_url": {**image, "url": linked}
                if isinstance(image, dict)
                else linked,
            }
    if kind == "image":
        source = part.get("source")
        if isinstance(source, dict) and source.get("type") == "base64":
            url = f"data:{source.get('media_type', '')};base64,{source.get('data', '')}"
            return {**part, "source": {"type": "url", "url": uploaded_url(url, prefix)}}
    return part


def rewrite_message(message, prefix):
    """同时覆盖用户附图和工具返回的图片，按需复制，不改写会话历史。"""
    if not isinstance(message, dict):
        return message
    rewritten = rewrite_part(message, prefix)
    for key in ("content", "output"):
        content = message.get(key)
        if not isinstance(content, list):
            continue
        parts = [rewrite_part(part, prefix) for part in content]
        if any(new is not old for new, old in zip(parts, content)):
            rewritten = {**rewritten, key: parts}
    return rewritten


def rewrite_request(*, request=None, platform="", model="", **_):
    """仅为已接通元景上传的桌面多模态请求换图，模型和本机原图继续沿用。"""
    from .native_images import active

    if (
        platform != "desktop"
        or not isinstance(request, dict)
        or not active(platform=platform, model=model)
    ):
        return None
    key = "messages" if isinstance(request.get("messages"), list) else "input"
    messages = request.get(key)
    prefix = uploads._upload_prefix()
    if not isinstance(messages, list) or prefix is None:
        return None
    rewritten = [rewrite_message(message, prefix) for message in messages]
    if all(new is old for new, old in zip(rewritten, messages)):
        return None
    return {**request, key: rewritten}
