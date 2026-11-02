"""沿用旧版 RCS 文件类型、20 MiB 原生媒体限制和链接回退。"""

import asyncio
from collections import Counter
import logging
import mimetypes
from pathlib import Path
import re
import tempfile
from urllib.parse import unquote, urlsplit

import httpx

from .upload import upload_bytes

logger = logging.getLogger(__name__)
MAX_NATIVE_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
NATIVE = {
    ".jpg": ("image", "image/jpeg"), ".jpeg": ("image", "image/jpeg"), ".png": ("image", "image/png"),
    ".amr": ("audio", "audio/amr"), ".mp3": ("audio", "audio/mpeg"), ".m4a": ("audio", "audio/mp4"),
    ".mp4": ("video", "video/mp4"), ".webm": ("video", "video/webm"),
}


async def download(url):
    """流式读取网关附件或回复中的 HTTP 文件，不在日志中泄露签名 URL。"""
    if urlsplit(url).scheme not in {"http", "https"}:
        raise ValueError("unsupported_file_url")
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_FILE_BYTES:
                    raise ValueError("attachment_too_large")
            mime = response.headers.get("content-type", "").split(";", 1)[0]
    name = re.sub(r"[^\w.\- ]", "_", unquote(urlsplit(url).path.rsplit("/", 1)[-1])) or "attachment"
    if not Path(name).suffix:
        name += mimetypes.guess_extension(mime) or ".bin"
    return bytes(data), name, mime


async def receive_files(urls):
    """复用 Hermes 媒体缓存，返回能直接进入模型输入的附件事实。"""
    from gateway.platforms.base import cache_media_bytes_async

    attachments = []
    for url in dict.fromkeys(urls):
        try:
            data, name, mime = await download(url)
            cached = await cache_media_bytes_async(data, filename=name, mime_type=mime)
            if cached:
                attachments.append(cached)
        except (httpx.HTTPError, OSError, ValueError) as exc:
            logger.warning("uniAgentGate attachment unavailable: error_type=%s", type(exc).__name__)
    return attachments


def _convert_wav(data):
    """优先使用平台解析的 FFmpeg，否则通过 PM 提供独立的转码环境。"""
    import subprocess
    import pm
    from hermes_cli._subprocess_compat import windows_hide_flags
    from hermes_platform.resolver import locate_command
    from tools.environments.local import served_profile_child_env

    command = list(locate_command("ffmpeg").command)
    with tempfile.TemporaryDirectory() as temporary:
        source, target = Path(temporary) / "input.wav", Path(temporary) / "output.mp3"
        source.write_bytes(data)
        if not command:
            python = pm.ensure_environment("uniagentgate-media", ["imageio-ffmpeg>=0.6,<0.8"], timeout=180)
            script = ("import imageio_ffmpeg,subprocess,sys; "
                      "sys.exit(subprocess.call([imageio_ffmpeg.get_ffmpeg_exe(),*sys.argv[1:]]))")
            command = [str(python), "-c", script]
        result = subprocess.run(
            [*command, "-nostdin", "-y", "-loglevel", "error", "-i", str(source),
             "-codec:a", "libmp3lame", "-qscale:a", "4", str(target)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, creationflags=windows_hide_flags(),
            env=served_profile_child_env(inherit_credentials=False))
        if result.returncode:
            raise RuntimeError("audio_conversion_failed")
        return target.read_bytes()


async def build_media(paths, server="UniAI-Toolkit"):
    """仅上传本轮提取的文件；单文件失败不丢失其它产物或文字回复。"""
    from gateway.platforms.base import validate_media_delivery_path

    media, links, failures = [], [], []
    for path in dict.fromkeys(paths):
        stage = "文件读取或下载失败"
        try:
            parsed = urlsplit(path)
            if parsed.scheme in {"http", "https"}:
                data, name, _ = await download(path)
            else:
                local = unquote(parsed.path) if parsed.scheme == "file" else path
                # 文件 URL 的 /D:/ Windows 路径由 pathlib 转换前去掉 URL 前导斜杠。
                if re.match(r"^/[A-Za-z]:/", local):
                    local = local[1:]
                local = validate_media_delivery_path(local)
                if not local:
                    raise ValueError("unsafe_media_path")
                file = Path(local)
                if file.stat().st_size > MAX_FILE_BYTES:
                    raise ValueError("attachment_too_large")
                data, name = await asyncio.to_thread(file.read_bytes), file.name
            ext = Path(name).suffix.lower()
            if ext == ".wav":
                stage = "音频转换失败"
                data = await asyncio.to_thread(_convert_wav, data)
                name, ext = f"{Path(name).stem}.mp3", ".mp3"
            kind_mime = NATIVE.get(ext)
            if kind_mime and len(data) > MAX_NATIVE_BYTES:
                raise ValueError("attachment_too_large")
            stage = "上传失败"
            url = await upload_bytes(data, name, server)
            if kind_mime:
                kind, mime = kind_mime
                media.append({"url": url, "kind": kind, "mime_type": mime, "file_name": name})
            else:
                links.append(f"📎 {name} 下载链接：{url}")
            logger.info("uniAgentGate file prepared: kind=%s bytes=%s", kind_mime[0] if kind_mime else "link", len(data))
        except Exception as exc:
            codes = {"oss_tool_unavailable", "oss_tool_failed", "oss_upload_address_missing",
                     "oss_path_missing", "oss_download_address_missing", "audio_conversion_failed",
                     "unsafe_media_path", "attachment_too_large"}
            reason = str(exc) if str(exc) in codes else "file_processing_failed"
            logger.warning("uniAgentGate media skipped: reason=%s error_type=%s", reason, type(exc).__name__)
            failures.append({"attachment_too_large": "大小超限", "unsafe_media_path": "文件路径不可用"}.get(reason, stage))
    return media, links, failures


def failure_notice(failures, *, partial=False):
    """只汇总数量和原因，不向接收端暴露本机路径、签名地址或原始异常。"""
    if not failures:
        return ""
    reasons = "、".join(f"{reason} {count} 个" for reason, count in Counter(failures).items())
    prefix = "部分附件" if partial else "附件"
    return f"⚠️ {prefix}未能发送（{len(failures)} 个）：{reasons}。未自动重试。"
