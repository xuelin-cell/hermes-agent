"""Host-side landing of UniAI ``image_search`` hits for slide decks.

Ported from 数字员工 ``image_search_materialize.py``. ``image_search`` answers
with third-party hotlinks as text; pptxgenjs and python-pptx cannot embed a
URL, and a model left to download them itself skipped the source credits and
stretched the pictures (西湖, 2026-09-23). So after the MCP call returns, the
host downloads a few originals into the session's working directory and
appends local paths — each with its pixels, 横 / 竖 / 方 and the site it came
from — to the result the model reads next.

Scope and budget, both from 数字员工:

* **Deck conversations only** (:mod:`turns`). Anywhere else ``image_search``
  is an ordinary tool and its text goes back untouched.
* **Eight searches per request.** A repeat of the same query is answered from
  memory and a spent budget is answered plainly, both from ``pre_tool_call``
  without calling the MCP. The notice never says 「换个关键词再搜」 once the
  budget is gone: said next to 「用完了」 it sent a Disney deck into fourteen
  dead searches. Searches still in flight count against the budget.

Matching is by the MCP leaf name ``image_search``: the toolkit is
``UniAI-Toolkit``, ``yuanjing`` or ``1`` depending on the build.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import struct
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urljoin, urlsplit

from . import media_slot, turns

logger = logging.getLogger(__name__)

LEAF = "image_search"
REL_DIR = Path("assets") / "image-search"
SOURCES_FILE = "来源.txt"
MAX_SEARCHES = 8
MAX_SAVE = 3
MIN_WIDTH = 1200
_MAX_TRY = 8
_MIN_BYTES = 8 * 1024
_MAX_BYTES = 8 * 1024 * 1024
_MAX_REDIRECTS = 5
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_ORIGINAL_RE = re.compile(r"原图[：:]\s*(https?://[^\s<>\"'\\]+)", re.IGNORECASE)
_THUMB_RE = re.compile(r"缩略图[：:]\s*(https?://[^\s<>\"'\\]+)", re.IGNORECASE)
_SOURCE_RE = re.compile(r"来源[：:]\s*(.*)")
_HIT_START_RE = re.compile(r"^\s*\d+[.、]\s*(.*)$")
_ANY_URL_RE = re.compile(r"https?://[^\s<>\"'\\]+")
_URL_TRAILING = ".,;:!?，。；：！？、\\)]}>"

ELSEWHERE = (
    "也可以从官网、官方新闻稿、维基百科 / Wikimedia Commons 这类可靠来源取原版图（记下来源页，图下标注）；"
    "Unsplash / Pexels 这类图库只适合风景、氛围图。"
)
CREDIT_LINE = (
    "★ 每张图正下方加一行小字写来源，用下面列出的来源名，例如「图片来源：南海网」，字号比正文小；"
    "交付时宿主会核对这一项。"
)
PLACEMENT = (
    "放图保持原比例，禁止拉伸变形；画框比例跟着图走：竖图配竖框、横图配横框（下面每张都标了横竖）。"
    "产品、人物、IP 这类主体图比例对不上时用 contain 完整放下、留出底色，不要为了铺满把主体裁掉；"
    "只有通栏横幅、半页出血这类风景 / 背景图适合用 cover 大面积裁；要裁就用 crop 按主体所在位置裁——"
    "cover 永远只裁正中间。交付时宿主会检查拉伸和大幅裁切。\n"
    "pptxgenjs 里外层 w/h 要写图片自己的尺寸（像素÷96 换成英寸），sizing.w/h 才是画框英寸，"
    "两处写成同一组数会导致裁剪量为 0、图被拉伸：\n"
    "  slide.addImage({ path: 文件, x, y, w: 1242/96, h: 1864/96, sizing: { type: 'contain', w: 画框宽, h: 画框高 } })\n"
    "画框单位是英寸，不要乘 96；页面多大由 layout 决定，pptxgenjs 默认 LAYOUT_16x9 是 10×5.625 英寸，"
    "x+w、y+h 不能超出页面。"
)


def is_image_search(tool_name: str) -> bool:
    """这次调用是不是元景工具箱的搜图工具（MCP 的 image_search）。"""
    return media_slot.leaf(tool_name) == LEAF and str(tool_name or "").startswith("mcp__")


@dataclass(frozen=True)
class Hit:
    title: str
    original: str
    thumbnail: str
    source_name: str
    source_page: str


@dataclass(frozen=True)
class Saved:
    path: Path
    source_url: str
    size: int
    source_name: str = ""
    source_page: str = ""
    title: str = ""
    width: int = 0
    height: int = 0

    @property
    def pixels(self) -> str:
        """图片尺寸的文字写法（宽×高），读不出尺寸时为空。"""
        return f"{self.width}×{self.height}" if self.width and self.height else ""

    @property
    def credit(self) -> str:
        """图下标注用的来源名：搜索结果给了来源名就用它，否则用来源网址的域名。"""
        if self.source_name:
            return self.source_name
        return (urlsplit(self.source_page or self.source_url).hostname or "").removeprefix("www.")

    @property
    def shape(self) -> str:
        """横图、竖图还是方图，帮模型挑适合画框的图；读不出尺寸时为空。"""
        if not (self.width and self.height):
            return ""
        ratio = self.width / self.height
        return "横图" if ratio > 1.15 else ("竖图" if ratio < 0.87 else "方图")


def _clean_url(url: str) -> str:
    """去掉网址里转义的换行和末尾多余的标点。"""
    return url.replace("\\n", "").replace("\\r", "").rstrip(_URL_TRAILING + "\r\n")


def parse_hits(text: str) -> List[Hit]:
    """把搜图结果拆成一条条命中（标题、原图、缩略图、来源）。"""
    hits: List[Hit] = []
    current: Optional[Dict[str, str]] = None

    def close() -> None:
        """当前这条有原图或缩略图时收进结果，然后开始下一条。"""
        if current and (current.get("original") or current.get("thumbnail")):
            hits.append(Hit(
                title=current.get("title", ""),
                original=current.get("original", ""),
                thumbnail=current.get("thumbnail", ""),
                source_name=current.get("source_name", ""),
                source_page=current.get("source_page", ""),
            ))

    for raw in (text or "").replace("\\n", "\n").splitlines():
        start = _HIT_START_RE.match(raw)
        if start and not _ORIGINAL_RE.search(raw):
            close()
            current = {"title": start.group(1).strip()}
            continue
        if current is None:
            current = {}
        original, thumb, source = _ORIGINAL_RE.search(raw), _THUMB_RE.search(raw), _SOURCE_RE.search(raw)
        if original:
            current["original"] = _clean_url(original.group(1))
        elif thumb:
            current["thumbnail"] = _clean_url(thumb.group(1))
        elif source:
            rest = source.group(1).strip()
            url = _ANY_URL_RE.search(rest)
            current["source_page"] = _clean_url(url.group(0)) if url else ""
            current["source_name"] = (rest[: url.start()] if url else rest).strip()
    close()
    return hits


def candidate_urls(hits: List[Hit]) -> List[str]:
    """按先原图、后缩略图的顺序列出要尝试下载的地址，去重；从不下载来源网页本身。"""
    ordered: List[str] = []
    for url in [h.original for h in hits] + [h.thumbnail for h in hits]:
        if url and url not in ordered:
            ordered.append(url)
    return ordered


def image_extension(data: bytes) -> Optional[str]:
    """按文件头判断图片格式，返回扩展名；不是认识的图片格式返回 None。"""
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


_JPEG_SOF = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})


def image_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    """从 JPEG、PNG、GIF 的文件头读出宽高，不需要图像库；读不出返回 None。"""
    if data.startswith(b"\xff\xd8"):
        index, end = 2, len(data) - 9
        while index < end:
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
                index += 2
                continue
            if marker in _JPEG_SOF:
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                return width, height
            index += 2 + struct.unpack(">H", data[index + 2:index + 4])[0]
        return None
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return width, height
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return width, height
    return None


def _allowed(url: str) -> bool:
    """只下载 http(s) 地址，拒绝内网、本机地址和云服务元数据地址。

    故意不在这里解析域名：数字员工遇到过公司 DNS 把图片 CDN（pinimg、花瓣）解析到内网缓存地址的情况，这些地址其实能正常下载。
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    host = parts.hostname.strip(".").lower()
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and (address.is_private or address.is_loopback or address.is_link_local
                                or address.is_reserved or address.is_multicast or address.is_unspecified):
        return False
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
        return False
    try:
        from tools.url_safety import is_always_blocked_url

        return not is_always_blocked_url(url)
    except Exception:
        return True


def fetch(url: str, *, timeout: float = 20.0) -> bytes:
    """下载一个地址：每一跳重定向都重新检查是否允许，并限制文件大小。"""
    import httpx

    current = url
    headers = {"User-Agent": _USER_AGENT, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"}
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=8.0), headers=headers, follow_redirects=False) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            if not _allowed(current):
                raise ValueError(f"不下载这个地址：{current}")
            with client.stream("GET", current) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("重定向没有目标")
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                if int(response.headers.get("content-length") or 0) > _MAX_BYTES:
                    raise ValueError("文件过大")
                chunks: List[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > _MAX_BYTES:
                        raise ValueError("文件过大")
                    chunks.append(chunk)
                return b"".join(chunks)
    raise ValueError("重定向过多")


def download(
    urls: List[str],
    dest: Path,
    *,
    sources: Mapping[str, Hit],
    fetcher: Callable[[str], bytes] = fetch,
    max_save: int = MAX_SAVE,
) -> List[Saved]:
    """最多保存 max_save 张真图，宽度够的优先；同一张图只存一份，并写一份来源清单。"""
    candidates: List[Tuple[str, bytes, str, Tuple[int, int]]] = []
    seen: set = set()
    for url in urls[:_MAX_TRY]:
        if sum(1 for c in candidates if c[3][0] >= MIN_WIDTH) >= max_save:
            break
        try:
            data = fetcher(url)
        except Exception as exc:
            logger.info("image_search skip %s: %s", url, exc)
            continue
        ext = image_extension(data)
        if ext is None or len(data) < _MIN_BYTES:
            continue
        digest = data[:64] + str(len(data)).encode()
        if digest in seen:
            continue
        seen.add(digest)
        candidates.append((url, data, ext, image_dimensions(data) or (0, 0)))
    big = [c for c in candidates if c[3][0] >= MIN_WIDTH]
    small = sorted((c for c in candidates if c[3][0] < MIN_WIDTH), key=lambda c: c[3][0] * c[3][1], reverse=True)
    picked = (big + small)[:max_save]
    saved: List[Saved] = []
    if picked:
        dest.mkdir(parents=True, exist_ok=True)
    for url, data, ext, (width, height) in picked:
        path = dest / f"{len(saved) + 1:02d}{ext}"
        if path.exists():
            path = dest / f"{len(saved) + 1:02d}-{uuid.uuid4().hex[:6]}{ext}"
        path.write_bytes(data)
        hit = sources.get(url)
        saved.append(Saved(
            path=path, source_url=url, size=len(data),
            source_name=hit.source_name if hit else "", source_page=hit.source_page if hit else "",
            title=hit.title if hit else "", width=width, height=height,
        ))
    if saved:
        rows = ["文件\t像素\t来源\t来源页面\t原图链接\t标题"]
        rows += ["\t".join([s.path.name, s.pixels, s.credit, s.source_page, s.source_url, s.title]) for s in saved]
        (dest / SOURCES_FILE).write_text("\n".join(rows) + "\n", encoding="utf-8")
    return saved


def _file_line(item: Saved) -> str:
    """已下载图片在说明里的一行：路径、大小、像素、横竖、来源。"""
    details = [f"{item.size} 字节"] + [value for value in (item.pixels and f"{item.pixels} 像素", item.shape) if value]
    line = f"- {item.path.as_posix()}  （{'，'.join(details)}）"
    if item.credit:
        line += f"  来源：{item.credit}" + (f"（{item.source_page}）" if item.source_page else "")
    return line


def landing_footer(saved: List[Saved], *, where: str, left: int, reuse: bool = False) -> str:
    """接在搜图结果后面的说明：哪些图已经下到本机、还能搜几次、怎么挑图和摆放、找不到真图怎么办。"""
    budget = f"这次请求还可以再搜 {left} 次（每次换个关键词）。" if left > 0 else "这次请求的搜图额度已经用完，不能再搜了。"
    if not saved:
        return "【宿主落地】这批搜图链接没有下成真图。" + budget + ELSEWHERE + "真实存在的产品、地标、人物不要用生成图顶替。"
    head = (
        "【宿主已落地图片】这个关键词刚搜过，下面是上次的结果，本次没有再打搜索。" if reuse
        else "【宿主已落地图片】下面这些文件已经下载到本机。"
    ) + budget
    retry = "换个关键词再搜，或者" if left > 0 else ""
    lines = [
        CREDIT_LINE,
        head + f"从中最多挑 {MAX_SAVE} 张放进 PPT，主题对不上或太小的就别用——{retry}{ELSEWHERE}实在没有，这页就不配图。"
        "有水印 / 台标的照用，不要去水印。真实存在的产品、地标、人物不要用生成图顶替，图不够就少放几张，先交件。",
        PLACEMENT,
        f"目录：{where}",
    ]
    lines.extend(_file_line(item) for item in saved)
    return "\n".join(lines)


def exhausted_notice(done: List[Tuple[str, List[Saved], str]]) -> str:
    """本次请求搜图次数用完时的答复：列出已经下载的全部图片，告诉模型接下来怎么办，并说明搜图工具本身是正常的。"""
    lines = [
        CREDIT_LINE,
        f"【宿主】这次请求的搜图额度（{MAX_SEARCHES} 次）已经用完，这一次没有去搜；再搜也只会收到这段话。"
        "搜图工具本身是正常的，不要告诉用户它不可用。",
        "还没配上图的页面：先从下面已经下载的图里挑；" + ELSEWHERE
        + "都没有合适的，这页就不配图，用图表或图形补，不要用生成图顶替真实存在的对象，也不要写「此处放图」。"
        "交付时在回复里说一句哪几页没配上图，用户可以自己提供素材。",
    ]
    if not done:
        lines.append("（同时发起的几次搜索已经占满额度，它们的结果返回后就在各自的回复里。）")
        return "\n".join(lines)
    lines.append("这次请求已经下载的全部图片：")
    for query, saved, where in done:
        lines.append(f"关键词「{query}」→ {where}")
        lines.extend(_file_line(item) for item in saved)
    return "\n".join(lines)


def _query(args: Any) -> str:
    """把搜图关键词规整成小写、单空格，用来判断是不是重复搜索。"""
    query = args.get("query") if isinstance(args, Mapping) else None
    return " ".join(str(query or "").split()).lower()


def before_search(turn: turns.Turn, args: Any) -> Optional[str]:
    """搜图前先看：同一个关键词刚搜过就直接给上次的结果，次数用完就给用完的说明；返回 None 表示照常去搜。

    只在做 PPT 时生效。
    """
    if not turn.deck:
        return None
    query = _query(args)
    repeat = next((entry for entry in turn.searches if entry[0] == query), None)
    if repeat is not None:
        _q, saved, where = repeat
        return landing_footer(saved, where=where, left=max(0, MAX_SEARCHES - len(turn.searches)), reuse=True)
    if len(turn.searches) + turn.in_flight >= MAX_SEARCHES:
        return exhausted_notice(turn.searches)
    turn.in_flight += 1
    return None


def after_search(
    turn: turns.Turn,
    args: Any,
    result: str,
    *,
    fetcher: Callable[[str], bytes] = fetch,
) -> Optional[str]:
    """搜图返回后把图下载到会话目录，在结果后面接上说明；不是做 PPT 或没有可下载的地址时返回 None。"""
    if not turn.deck:
        return None
    turn.in_flight = max(0, turn.in_flight - 1)
    hits = parse_hits(result)
    urls = candidate_urls(hits)
    if not urls:
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    sub = "-".join(part for part in (stamp, turn.session_id[-6:], str(len(turn.searches) + 1)) if part)
    dest = Path(turns.session_cwd(turn)) / REL_DIR / sub
    sources = {}
    for hit in hits:
        for url in (hit.original, hit.thumbnail):
            if url:
                sources.setdefault(url, hit)
    try:
        saved = download(urls, dest, sources=sources, fetcher=fetcher)
    except Exception:
        logger.warning("image_search landing failed", exc_info=True)
        saved = []
    if saved:
        turn.searches.append((_query(args), saved, dest.as_posix()))
    footer = landing_footer(saved, where=dest.as_posix(), left=max(0, MAX_SEARCHES - len(turn.searches)))
    return result.rstrip() + "\n\n" + footer
