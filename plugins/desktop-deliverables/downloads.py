"""只接住生成类工具返回的成品链接，下载失败不改变原工具结果。"""

import asyncio
import logging
from pathlib import Path
import re
from urllib.parse import unquote, urljoin, urlsplit
from uuid import uuid4

from tools.url_safety import async_is_safe_url, create_ssrf_safe_async_client

from .paths import EXTENSIONS

logger = logging.getLogger(__name__)
GENERATORS = {
    "txt2img_generate",
    "img2vid_generate",
    "txt2vid_generate",
    "tts_synthesize",
    "ai_podcast_generate",
    "doc_translate",
}
MAX_BYTES = 32 * 1024 * 1024
TIMEOUT = 20


def generator_urls(name, text):
    """按工具末段严格匹配，不把搜索素材或相似名称当成生成成品。"""
    if name.rsplit("__", 1)[-1] not in GENERATORS:
        return []
    urls = []
    for match in re.finditer(r'https?://[^\s<>"\'\\]+', text):
        url = match.group().rstrip(".,;:!?)]}、。，；：！？）】》”’")
        try:
            parsed = urlsplit(url)
            if (
                parsed.hostname
                and not parsed.username
                and not parsed.password
                and Path(unquote(parsed.path)).suffix.lower().lstrip(".") in EXTENSIONS
                and url not in urls
            ):
                urls.append(url)
        except ValueError:
            continue
        if len(urls) == 4:
            break
    return urls


async def fetch(url, root):
    """流式下载到随机文件，整个请求最多二十秒；半成品绝不暴露为交付卡片。"""
    temporary = None
    try:
        async with asyncio.timeout(TIMEOUT):
            folder = root / "outputs"
            if folder.is_symlink() or folder.is_junction():
                raise ValueError("outputs is linked")
            folder.mkdir(exist_ok=True)
            target = folder / (
                uuid4().hex + Path(unquote(urlsplit(url).path)).suffix.lower()
            )
            temporary = folder / ("." + target.name + ".part")
            async with create_ssrf_safe_async_client(
                timeout=TIMEOUT, follow_redirects=False
            ) as client:
                current = url
                for hop in range(4):
                    if not await async_is_safe_url(current):
                        raise ValueError("unsafe URL")
                    async with client.stream("GET", current) as response:
                        if response.is_redirect:
                            redirected = urljoin(
                                current, response.headers.get("location", "")
                            )
                            if (
                                hop == 3
                                or urlsplit(redirected).scheme not in {"http", "https"}
                                or urlsplit(redirected).username
                                or urlsplit(redirected).password
                                or (
                                    urlsplit(current).scheme == "https"
                                    and urlsplit(redirected).scheme != "https"
                                )
                            ):
                                raise ValueError("unsafe redirect")
                            current = redirected
                            continue
                        response.raise_for_status()
                        declared = response.headers.get("content-length", "")
                        if declared.isdigit() and int(declared) > MAX_BYTES:
                            raise ValueError("oversized response")
                        total = 0
                        with temporary.open("xb") as stream:
                            async for chunk in response.aiter_bytes():
                                total += len(chunk)
                                if total > MAX_BYTES:
                                    raise ValueError("oversized stream")
                                stream.write(chunk)
                        if not total:
                            raise ValueError("empty response")
                        temporary.rename(target)
                        return target
    except Exception as exc:
        # 签名链接可能含凭据，只记录错误类型，不记录 URL、响应或异常全文。
        logger.info("Generated deliverable download skipped (%s)", type(exc).__name__)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return None
