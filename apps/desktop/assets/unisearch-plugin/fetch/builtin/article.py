"""Primary article coverage, using only the candidate's readable projection."""

import re
from html import unescape
from urllib.parse import urljoin, urlsplit


# 统一正文和Markdown的比较形式，链接地址不打断原文片段。
def comparison_text(text):
    text = re.sub(r"\[([^\]]*)\]\([^\n]*?\)", r"\1", text)
    text = re.sub(r"\\([\\`*_{}\[\]()#+.!>\-])", r"\1", text)
    return re.sub(r"[^\w]+", " ", unescape(text).casefold()).strip()


# 只认唯一主要文章；多卡片列表和侧栏不升级成缺失正文。
def primary_article(soup):
    candidates = [
        node
        for node in soup.select("article, [role=article]")
        if not any(
            parent.name in {"article", "aside", "nav", "footer", "form", "template"}
            or parent.get("role")
            in {"article", "dialog", "complementary", "navigation"}
            for parent in node.parents
        )
        and article_fragments(node)
    ]
    return candidates[0] if len(candidates) == 1 else None


# 通过实际段落、列表、代码及单元格建立覆盖证据，不用标题或字数代替正文。
def article_fragments(article):
    return [
        text
        for node in article.select("p, pre, li, td, th, dd")
        if not any(
            parent.name in {"nav", "aside", "footer", "form"} for parent in node.parents
        )
        if (text := comparison_text(node.get_text(" ", strip=True)))
    ]


# 质量层与提取层共用覆盖判断，不能用原DOM的结构为漏提结果背书。
def article_missing(article, markdown):
    text = comparison_text(markdown)
    return any(fragment not in text for fragment in article_fragments(article))


# 仓库根页的文件树只证明目录可读，不证明已取得项目介绍；子目录仍按目录评估。
def repository_overview_unverified(soup, url):
    target = urlsplit(url)
    path = target.path.strip("/").split("/")
    if (
        target.hostname != "github.com"
        or len(path) != 2
        or primary_article(soup) is not None
    ):
        return False
    root = soup.select_one("main, [role=main]") or soup
    entries = set()
    for link in root.select("a[href]"):
        destination = urlsplit(urljoin(url, link["href"]))
        parts = destination.path.strip("/").split("/")
        if (
            destination.hostname == target.hostname
            and parts[:2] == path
            and len(parts) >= 5
            and parts[2] in {"tree", "blob"}
            and link.find_parent(["nav", "aside", "footer"]) is None
        ):
            entries.add(destination.path)
    return len(entries) >= 2
