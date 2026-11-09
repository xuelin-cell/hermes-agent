"""Builtin-only reference resolution; network permission stays with NetworkPolicy."""

from urllib.parse import urljoin, urlsplit, urlunsplit


# 只接受可解释的网页引用，不把凭据或非法协议输出为链接。
def web_reference(base_url: str, reference: str) -> str | None:
    try:
        if any(ord(c) < 32 for c in reference.strip()):
            return None
        value = urljoin(base_url, reference.strip())
        parsed = urlsplit(value)
        if (
            parsed.scheme.lower() not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port == 0
            or any(ord(c) < 32 for c in value)
        ):
            return None
        return value
    except (ValueError, UnicodeError):
        return None


# 文档首个base决定引用起点，无效时回到最终页面地址。
def document_base(soup, page_url: str) -> str:
    tag = soup.find("base", href=True)
    if tag is not None and isinstance(tag.get("href"), str):
        return web_reference(page_url, tag["href"]) or page_url
    return page_url


# 只识别明确的应用路由，普通章节锚点不产生新的抓取身份。
def route_fragment(url: str) -> str:
    fragment = urlsplit(url).fragment
    return fragment if fragment.startswith(("/", "!/")) else ""


# 网络校验后的主机和协议保持不变，仅恢复导航所需的原始片段。
def navigation_url(validated_url: str, original_url: str) -> str:
    return urlunsplit(
        urlsplit(validated_url)._replace(fragment=urlsplit(original_url).fragment)
    )


# 发现链接按普通锚点去重，但不能合并不同应用路由。
def discovery_url(url: str) -> str:
    return urlunsplit(urlsplit(url)._replace(fragment=route_fragment(url)))
