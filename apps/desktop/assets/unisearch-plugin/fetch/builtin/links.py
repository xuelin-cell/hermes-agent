"""Link discovery from fetched HTML."""

from __future__ import annotations

from urllib.parse import urldefrag, urljoin, urlsplit

from bs4 import BeautifulSoup


# 按文档顺序保留有效HTTP链接并去重。
def extract_links(html: str, base_url: str) -> tuple[str, ...]:
    """Return de-duplicated HTTP links in document order.

    Args:
        html: Raw or browser-rendered page HTML.
        base_url: Final page URL used to resolve relative links.

    Returns:
        Absolute HTTP(S) URLs without fragments.
    """
    soup = BeautifulSoup(html, "lxml")
    discovered: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href")
        if not isinstance(href, str) or not href.strip():
            continue
        absolute, _ = urldefrag(urljoin(base_url, href.strip()))
        parsed = urlsplit(absolute)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            continue
        if absolute not in seen:
            seen.add(absolute)
            discovered.append(absolute)
    return tuple(discovered)
