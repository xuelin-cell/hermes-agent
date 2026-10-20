"""只接住生成类工具返回的成品链接，下载到本机并在结果里写明本机副本或未能保存。"""

import asyncio
import json
import logging
import os
from pathlib import Path
import re
from urllib.parse import unquote, urljoin, urlsplit
from uuid import uuid4

import httpx

from tools.url_safety import async_is_safe_url, create_ssrf_safe_async_client

from .paths import EXTENSIONS, is_link

logger = logging.getLogger(__name__)
GENERATORS = {
    "txt2img_generate",
    "img2vid_generate",
    "txt2vid_generate",
    "tts_synthesize",
    "ai_podcast_generate",
    "doc_translate",
    "image_edit",
    "music_generate",
}
MAX_BYTES = 32 * 1024 * 1024
TIMEOUT = 20
# 与 UniWork 相同：生成成品放在固定的对象存储，本机代理（fake-ip）会把它解析成保留地址。
# 只对这个域名下各工具自己的成品目录免去内网检查；其它链接和跳转照常检查。
TRUSTED_HOST = "obs-nmhhht6.cucloud.cn"
TRUSTED_PATHS = {
    "txt2img_generate": ("/yuanjing-t2i-oss/mllm/yuanjingt2i/",),
    "img2vid_generate": ("/app-agent-prod/videos/",),
    "txt2vid_generate": ("/app-agent-prod/videos/",),
    "tts_synthesize": ("/app-agent-prod/temp/",),
    "ai_podcast_generate": ("/app-agent-prod/temp/",),
    "doc_translate": ("/app-agent-prod/translate/", "/app-agent-prod/temp/"),
    "image_edit": ("/app-agent-prod/images/edited/",),
    "music_generate": ("/app-agent-prod/music/",),
}
# 元景生图返回的成品链接是 http，其它工具是 https；只按工具放行它实际使用的协议。
TRUSTED_SCHEMES = {"txt2img_generate": ("http", "https")}
DEFAULT_PORTS = {"http": 80, "https": 443}
# 生成和编辑出的图片链接还要留给图生视频、再次编辑等工具使用；其余成品下载后从结果中移除链接。
KEEP_LINKS = {"txt2img_generate", "image_edit"}
# 没有描述可用时的文件名，同名由 claim 加序号区分。
FALLBACK_NAMES = {
    "txt2img_generate": "生成图片",
    "img2vid_generate": "生成视频",
    "txt2vid_generate": "生成视频",
    "tts_synthesize": "语音",
    "ai_podcast_generate": "AI播客",
    "doc_translate": "翻译结果",
    "image_edit": "编辑图片",
    "music_generate": "生成音乐",
}
NAME_LIMIT = 24
_RESERVED = re.compile(r"^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$", re.I)
_TRANSLATED = re.compile(r"^(?:[0-9a-f]{16,}_)?(?P<stem>.+)_(?P<variant>mono|dual)$", re.I)
_TRANSLATED_TEMP = re.compile(
    r"^(?P<label>中文版|翻译版|对照版)[:：](?P<stem>.+?)(?:_\d{8}_\d{6})?$"
)
_LINK_LABEL = re.compile(r"^[\s\-*•>]*[^\s:：]{0,16}(?:链接|地址|url|URL|link|Link)\s*[:：]?\s*$")


def leaf(name):
    """MCP 工具名只取末段：工具箱在不同版本里叫 UniAI_Toolkit、yuanjing 或 1。"""
    return str(name or "").rsplit("__", 1)[-1]


def trusted(name, url):
    """链接是否为该生成工具在固定对象存储里的成品：限定协议、默认端口、无账号信息、无上跳目录。"""
    prefixes = TRUSTED_PATHS.get(leaf(name), ())
    schemes = TRUSTED_SCHEMES.get(leaf(name), ("https",))
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    return bool(
        prefixes
        and parsed.scheme in schemes
        and parsed.hostname == TRUSTED_HOST
        and parsed.username is None
        and parsed.password is None
        and port in (None, DEFAULT_PORTS.get(parsed.scheme))
        and not parsed.fragment
        and parsed.path.startswith(prefixes)
        and ".." not in unquote(parsed.path).split("/")
    )


def generator_urls(name, text):
    """按工具末段严格匹配，不把搜索素材或相似名称当成生成成品。"""
    if leaf(name) not in GENERATORS:
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


def clean_name(value):
    """把描述变成可用的 Windows 文件名：去掉非法字符和换行，限长，避开设备保留名。"""
    # 先把换行等空白并成一个空格，再去掉非法字符，避免描述里的两行粘成一个词。
    text = re.sub(r"\s+", " ", str(value or ""))
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "", text)
    text = re.sub(r" {2,}", " ", text).strip(" .")[:NAME_LIMIT].strip(" .")
    return "" if not text or _RESERVED.match(text) else text


def output_stem(name, url, args):
    """翻译沿用原文件名并标明译本类型；其它成品取生成时的描述，取不到时用工具名称。"""
    tool = leaf(name)
    args = args if isinstance(args, dict) else {}
    if tool == "doc_translate":
        # 上游文件名里的中文有时被编码两次，只解码用于起名，下载仍用原链接。
        stem = Path(unquote(unquote(urlsplit(url).path))).stem
        source = args.get("file_name")
        match = _TRANSLATED.match(stem)
        if match:
            label = "翻译版" if match.group("variant").lower() == "mono" else "中英对照版"
        else:
            match = _TRANSLATED_TEMP.match(stem)
            label = "中英对照版" if match and match.group("label") == "对照版" else "翻译版"
        base = clean_name(Path(str(source)).stem if source else match.group("stem") if match else "")
        return f"{base}_{label}" if base else FALLBACK_NAMES[tool]
    for key in ("prompt", "text", "topic", "title"):
        named = clean_name(args.get(key))
        if named:
            return named
    return FALLBACK_NAMES.get(tool, "生成文件")


def claim(folder, stem, suffix):
    """按“名字、名字-2、名字-3…”独占创建空文件占位，同名不覆盖，并行下载也不会抢到同一个名字。"""
    for index in range(1, 1000):
        target = folder / (stem + suffix if index == 1 else f"{stem}-{index}{suffix}")
        try:
            with target.open("xb"):
                return target
        except FileExistsError:
            continue
    raise ValueError("no free file name")


async def fetch(url, root, name="", args=None):
    """流式下载到隐藏的临时文件，整个请求最多二十秒；完整后才以可读名字出现，半成品绝不成卡。"""
    temporary = None
    target = None
    # 按原始链接一次决定：可信成品用普通客户端，每次跳转也必须仍在可信范围内。
    exempt = trusted(name, url)
    try:
        async with asyncio.timeout(TIMEOUT):
            folder = root / "outputs"
            if is_link(folder):
                raise ValueError("outputs is linked")
            folder.mkdir(exist_ok=True)
            suffix = Path(unquote(urlsplit(url).path)).suffix.lower()
            temporary = folder / ("." + uuid4().hex + suffix + ".part")
            client_factory = (
                httpx.AsyncClient if exempt else create_ssrf_safe_async_client
            )
            async with client_factory(
                timeout=TIMEOUT, follow_redirects=False
            ) as client:
                current = url
                for hop in range(4):
                    if exempt:
                        if not trusted(name, current):
                            raise ValueError("untrusted redirect")
                    elif not await async_is_safe_url(current):
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
                        target = claim(folder, output_stem(name, url, args), suffix)
                        os.replace(temporary, target)
                        return target
    except Exception as exc:
        # 签名链接可能含凭据，只记录错误类型，不记录 URL、响应或异常全文。
        logger.info("Generated deliverable download skipped (%s)", type(exc).__name__)
        if target is not None:
            target.unlink(missing_ok=True)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return None


def strip_links(text, urls):
    """去掉已下载成品的链接；只剩“下载链接：”这类空标签的行一并删除，其它正文保留。"""
    lines = []
    for line in text.splitlines():
        changed = line
        for url in urls:
            # 上游有时写成 [下载](url)，只留链接文字，不留空括号。
            changed = re.sub(r"\[([^\]]*)\]\(\s*" + re.escape(url) + r"\s*\)", r"\1", changed)
            changed = changed.replace(url, "")
        if changed == line:
            lines.append(line)
        elif changed.strip() and not _LINK_LABEL.match(changed):
            lines.append(re.sub(r"\s*[:：]\s*$", "", changed.rstrip()))
    return "\n".join(lines)


def strip_data(value, urls):
    """在 JSON 结构的每个字符串里去掉已下载的链接；变成空字符串的字段整体去掉。"""
    if isinstance(value, str):
        return strip_links(value, urls).strip() if any(url in value for url in urls) else value
    if isinstance(value, list):
        items = [strip_data(item, urls) for item in value]
        return [item for item, old in zip(items, value) if item != "" or old == ""]
    if isinstance(value, dict):
        pairs = {key: strip_data(item, urls) for key, item in value.items()}
        return {key: item for key, item in pairs.items() if item != "" or value[key] == ""}
    return value


def saved_note(name, root, paths, missing):
    """用陈述事实的方式告诉模型本机副本在哪、哪些没存下；结果在不可信包装内，不写成命令。"""
    parts = []
    if paths:
        usage = (
            "原链接仍在结果中，仅用于传给图生视频等需要网络地址的工具；在回复中引用时用本机副本"
            if leaf(name) in KEEP_LINKS
            else "原下载链接已移除，回复中引用时用本机副本"
        )
        parts.append(f"已保存本机副本，桌面聊天区会自动显示预览卡片（{usage}）。")
    if missing:
        parts.append(
            f"有 {len(missing)} 个成品没有本机副本（链接保留在结果中，签名链接会过期）。"
            f"桌面只为本机文件显示预览卡片：要交付它，需先下载到当前工作目录 {root} 内，"
            "再在回复里单独一行写 MEDIA:<本机绝对路径>。"
        )
    return "".join(parts)


def annotate(name, result, data, root, saved, missing):
    """返回改写后的工具结果：成品去链接或保留链接，并写明本机副本与未保存的成品。"""
    paths = [str(path) for path in saved.values()]
    removed = [] if leaf(name) in KEEP_LINKS else list(saved)
    note = saved_note(name, root, paths, missing)
    if isinstance(data, dict):
        rewritten = strip_data(data, removed)
        if paths:
            rewritten["desktop_deliverables"] = paths
        rewritten["desktop_note"] = note
        return json.dumps(rewritten, ensure_ascii=False)
    text = strip_links(str(result), removed).rstrip() if removed else str(result)
    return "\n\n".join(part for part in [text, note, "\n".join(paths)] if part)
