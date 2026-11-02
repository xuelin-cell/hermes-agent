"""Main-content extraction and static-page quality evaluation."""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass
from urllib.parse import urljoin

import trafilatura
from bs4 import BeautifulSoup, Tag
from bs4.element import NavigableString
from markdownify import markdownify

logger = logging.getLogger(__name__)

_DYNAMIC_MARKERS = (
    "enable javascript",
    "javascript is required",
    "please turn javascript on",
    "__next_data__",
    "__nuxt__",
    "data-reactroot",
    "ng-version",
)
_CHALLENGE_MARKERS = (
    "checking your browser",
    "verify you are human",
    "attention required! | cloudflare",
    "cf-chl-",
)
_NOISE_TAGS = (
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "nav",
    "footer",
    "aside",
    "form",
)
_MIN_FALLBACK_LENGTH = 80
_MIN_READABLE_LENGTH = 120
_MIN_DYNAMIC_LENGTH = 600
_MIN_SHORT_PAGE_LENGTH = 220
_MIN_PARAGRAPHS = 2
_MIN_REPEATED_ITEMS = 3
_MIN_REPEATED_ITEM_TEXT = 20
_MIN_REPEATED_TEXT_MATCHES = 2
_MIN_DISTINCTIVE_FRAGMENT_LENGTH = 4
_REPEATED_ITEM_TAGS = frozenset({"article", "li", "section"})
_RATING_WORDS = frozenset({"one", "two", "three", "four", "five"})
_AUXILIARY_COLLECTION_MARKERS = (
    "also bought",
    "also viewed",
    "cross sell",
    "cross-sell",
    "customers also",
    "recently viewed",
    "recommendation",
    "recommended",
    "related items",
    "related products",
    "suggested",
    "upsell",
    "you may also",
)
_REGION_METADATA_ATTRIBUTES = (
    "id",
    "class",
    "aria-label",
    "data-section",
    "data-testid",
)


@dataclass(frozen=True, slots=True)
class ExtractedContent:
    """Page content after boilerplate removal and Markdown conversion."""

    markdown: str
    title: str | None
    text_length: int


# 正文提取保留主要列表与链接，去掉导航噪声且不覆盖详情内容。
def extract_content(html: str, url: str) -> ExtractedContent:
    """Extract readable Markdown and title from HTML."""
    soup = BeautifulSoup(html, "lxml")
    title = _extract_title(soup)
    _normalize_links(soup, url)
    _annotate_semantic_metadata(soup)
    extraction_soup = _without_auxiliary_collections(soup)

    try:
        extracted = trafilatura.extract(
            str(extraction_soup),
            url=url,
            output_format="markdown",
            include_comments=False,
            include_links=True,
            include_images=False,
            include_tables=True,
            favor_precision=True,
            deduplicate=True,
        )
    except Exception as exc:  # noqa: BLE001 - third-party extraction must not disable web fetch
        logger.warning(
            "Trafilatura extraction failed for %s; using HTML fallback: %s", url, exc
        )
        extracted = None
    repeated_content = _preserve_repeated_content(soup, extracted or "")
    preserve_repeated_blocks = repeated_content is not None
    used_html_fallback = False
    if repeated_content is not None:
        extracted = repeated_content
    elif not extracted or len(_plain_text(extracted)) < _MIN_FALLBACK_LENGTH:
        extracted = _fallback_markdown(extraction_soup)
        used_html_fallback = True
    else:
        extracted = _append_missing_article_links(extracted, extraction_soup)

    extracted = _append_pagination_links(extracted or "", soup)
    cleaned = _clean_markdown(
        extracted, deduplicate=not (preserve_repeated_blocks or used_html_fallback)
    )
    return ExtractedContent(
        markdown=cleaned, title=title, text_length=len(_plain_text(cleaned))
    )


# 只在静态正文不足或动态挑战迹象明确时启动浏览器补抓。
def needs_browser(raw_html: str, content: ExtractedContent) -> bool:
    """Return whether static extraction is too weak and JS rendering is worthwhile."""
    lowered = raw_html.lower()
    if any(marker in lowered for marker in _CHALLENGE_MARKERS):
        return True
    if content.text_length < _MIN_READABLE_LENGTH:
        return True

    paragraph_count = len(
        re.findall(r"(?:^|\n)\s*[^#*|>\n][^\n]{60,}", content.markdown)
    )
    dynamic_shell = any(marker in lowered for marker in _DYNAMIC_MARKERS) or bool(
        re.search(r"<div[^>]+id=[\"'](?:app|root|__next)[\"'][^>]*>\s*</div>", lowered)
    )
    if dynamic_shell and content.text_length < _MIN_DYNAMIC_LENGTH:
        return True
    return (
        content.text_length < _MIN_SHORT_PAGE_LENGTH
        and paragraph_count < _MIN_PARAGRAPHS
    )


# 沿网页语义元数据优先级取得标题，兼容普通文章标题。
def _extract_title(soup: BeautifulSoup) -> str | None:
    for selector, attribute in (
        ('meta[property="og:title"]', "content"),
        ('meta[name="twitter:title"]', "content"),
    ):
        node = soup.select_one(selector)
        if isinstance(node, Tag):
            value = node.get(attribute)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if soup.title is not None:
        value = soup.title.get_text(" ", strip=True)
        if value:
            return value
    heading = soup.find("h1")
    if isinstance(heading, Tag):
        value = heading.get_text(" ", strip=True)
        return value or None
    return None


# 相对链接基于最终页面地址解析，保持正文引用可用。
def _normalize_links(soup: BeautifulSoup, base_url: str) -> None:
    for tag_name, attribute in (("a", "href"), ("img", "src")):
        for node in soup.find_all(tag_name):
            if not isinstance(node, Tag):
                continue
            value = node.get(attribute)
            if (
                isinstance(value, str)
                and value
                and not value.startswith(("data:", "javascript:", "mailto:", "tel:"))
            ):
                node[attribute] = urljoin(base_url, value)


# 把评分等非文字元数据保留成可读内容。
def _annotate_semantic_metadata(soup: BeautifulSoup) -> None:
    """Convert common non-textual metadata into readable text."""
    for node in soup.select(".star-rating"):
        if (
            not isinstance(node, Tag)
            or "rating:" in node.get_text(" ", strip=True).casefold()
        ):
            continue
        classes = node.get("class")
        if not isinstance(classes, list):
            continue
        rating = next(
            (
                value
                for value in classes
                if isinstance(value, str) and value.casefold() in _RATING_WORDS
            ),
            None,
        )
        if rating is not None:
            node.append(NavigableString(f" Rating: {rating.title()}"))

    for node in soup.select("[data-rating]"):
        if (
            not isinstance(node, Tag)
            or "rating:" in node.get_text(" ", strip=True).casefold()
        ):
            continue
        data_rating = node.get("data-rating")
        if isinstance(data_rating, str) and data_rating.strip():
            node.append(NavigableString(f" Rating: {data_rating.strip()}"))


# 先剔除推荐区再提取，避免详情正文被相关商品替换。
def _without_auxiliary_collections(soup: BeautifulSoup) -> BeautifulSoup:
    """Copy the DOM and remove recommendation-like sections before extraction."""
    extraction_soup = BeautifulSoup(str(soup), "lxml")

    for node in list(extraction_soup.find_all()):
        if (
            isinstance(node, Tag)
            and node.parent is not None
            and _tag_has_auxiliary_metadata(node)
        ):
            node.decompose()

    headings = list(extraction_soup.find_all(re.compile(r"^h[2-6]$", re.IGNORECASE)))
    for heading in headings:
        if not isinstance(heading, Tag) or heading.parent is None:
            continue
        if not _has_auxiliary_marker(heading.get_text(" ", strip=True)):
            continue
        _remove_heading_section(heading)

    return extraction_soup


# 通过容器语义识别推荐区，保留主文及标题区域。
def _tag_has_auxiliary_metadata(node: Tag) -> bool:
    if node.name in {"html", "body", "main"} or node.find("h1") is not None:
        return False
    values: list[str] = []
    for attribute in _REGION_METADATA_ATTRIBUTES:
        value = node.get(attribute)
        if isinstance(value, list):
            values.extend(str(item) for item in value)
        elif isinstance(value, str):
            values.append(value)
    return _has_auxiliary_marker(" ".join(values))


# 统一比较形式，兼容推荐区域的常见标记写法。
def _has_auxiliary_marker(value: str) -> bool:
    normalized = _normalized_comparison_text(value)
    return any(
        _normalized_comparison_text(marker) in normalized
        for marker in _AUXILIARY_COLLECTION_MARKERS
    )


# 移除辅助标题及其所属内容，遇到同级章节停止。
def _remove_heading_section(heading: Tag) -> None:
    """Remove an auxiliary heading and its content up to the next peer section."""
    heading_level = int(heading.name[1])
    boundary = heading
    parent = heading.parent
    if isinstance(parent, Tag) and parent.name in {"div", "header"}:
        child_tags = [
            child
            for child in parent.find_all(recursive=False)
            if isinstance(child, Tag)
        ]
        if child_tags == [heading]:
            boundary = parent

    sibling = boundary.next_sibling
    boundary.decompose()
    while sibling is not None:
        next_sibling = sibling.next_sibling
        if isinstance(sibling, Tag) and _starts_peer_section(sibling, heading_level):
            break
        sibling.extract()
        sibling = next_sibling


# 以标题层级确定辅助章节边界，避免误删后续正文。
def _starts_peer_section(node: Tag, removed_heading_level: int) -> bool:
    if re.fullmatch(r"h[1-6]", node.name or "", re.IGNORECASE):
        return int(node.name[1]) <= removed_heading_level
    heading = node.find(re.compile(r"^h[1-6]$", re.IGNORECASE))
    return isinstance(heading, Tag) and int(heading.name[1]) <= removed_heading_level


# 副本上转换可读HTML，保留原DOM供链接与分页提取。
def _fallback_markdown(soup: BeautifulSoup) -> str:
    # Work on a copy so pagination/link discovery can still inspect the
    # original rendered DOM after main-content fallback completes.
    fallback_soup = BeautifulSoup(str(soup), "lxml")
    for node in fallback_soup.find_all(_NOISE_TAGS):
        node.decompose()
    articles = fallback_soup.find_all("article")
    root = (
        articles[0]
        if len(articles) == 1
        else fallback_soup.find("main") or fallback_soup.body or fallback_soup
    )
    return str(markdownify(str(root), heading_style="ATX", bullets="-"))


# 仅补回已被正文选择的列表组，避免用推荐卡片覆盖详情。
def _preserve_repeated_content(soup: BeautifulSoup, extracted: str) -> str | None:
    """Preserve complete repeated cards when strict extraction drops items.

    Collection pages commonly render sibling cards with the same element and
    class signature. Precision-oriented article extraction can retain an
    arbitrary subset of those cards. A repeated group is eligible only when the
    primary extractor already selected an item from that same group.
    This prevents unrelated recommendation or recently-viewed cards on a detail
    page from replacing the actual main content.
    """
    extracted_text = _normalized_comparison_text(extracted)
    best_items: list[Tag] = []
    best_score = 0
    for parent in soup.descendants:
        if not isinstance(parent, Tag) or parent.name in _NOISE_TAGS:
            continue
        groups: dict[tuple[str, tuple[str, ...]], list[Tag]] = {}
        for child in parent.find_all(recursive=False):
            if not isinstance(child, Tag):
                continue
            raw_classes = child.get("class")
            classes = (
                tuple(sorted(value for value in raw_classes if isinstance(value, str)))
                if isinstance(raw_classes, list)
                else ()
            )
            if child.name not in _REPEATED_ITEM_TAGS and not classes:
                continue
            text = child.get_text(" ", strip=True)
            if len(text) < _MIN_REPEATED_ITEM_TEXT:
                continue
            groups.setdefault((child.name, classes), []).append(child)
        for items in groups.values():
            if len(items) < _MIN_REPEATED_ITEMS:
                continue
            if _repeated_group_is_auxiliary(items):
                continue
            if not _repeated_group_is_extraction_source(items, extracted_text):
                continue
            missing_count = sum(
                not _item_is_present(item, extracted_text) for item in items
            )
            score = missing_count * sum(
                len(item.get_text(" ", strip=True)) for item in items
            )
            if missing_count > 0 and score > best_score:
                best_items = items
                best_score = score
    if not best_items:
        return None
    html = "\n".join(str(item) for item in best_items)
    return str(markdownify(html, heading_style="ATX", bullets="-"))


# 依据祖先区域与标题排除推荐组，保持主文完整性。
def _repeated_group_is_auxiliary(items: list[Tag]) -> bool:
    """Return whether cards belong to recommendations rather than page content.

    Detail pages often contain repeated related/recently-viewed cards after the
    requested article. If the primary extractor keeps only some of those cards,
    treating them as an incomplete result collection would replace the actual
    detail with recommendations. Inspect semantic region metadata and headings
    on the card group and its ancestors to keep those secondary collections out
    of the repeated-content recovery path.
    """
    if not items:
        return False

    region = items[0].parent
    while isinstance(region, Tag) and region.name not in {"body", "html"}:
        semantic_values: list[str] = []
        for attribute in _REGION_METADATA_ATTRIBUTES:
            value = region.get(attribute)
            if isinstance(value, list):
                semantic_values.extend(str(item) for item in value)
            elif isinstance(value, str):
                semantic_values.append(value)

        heading = region.find(re.compile(r"^h[1-6]$", re.IGNORECASE))
        if isinstance(heading, Tag) and not any(
            heading in item.descendants for item in items
        ):
            semantic_values.append(heading.get_text(" ", strip=True))

        if _has_auxiliary_marker(" ".join(semantic_values)):
            return True
        region = region.parent
    return False


# 同时比较首尾指纹，识别列表条目是否仅被部分保留。
def _item_is_present(item: Tag, extracted_text: str) -> bool:
    leading_fingerprint, trailing_fingerprint = _item_fingerprints(item)
    return (
        bool(leading_fingerprint)
        and leading_fingerprint in extracted_text
        and bool(trailing_fingerprint)
        and trailing_fingerprint in extracted_text
    )


# 需有链接或独特正文片段证明同源，才补回整个列表组。
def _repeated_group_is_extraction_source(items: list[Tag], extracted_text: str) -> bool:
    """Return whether extracted content demonstrably originates from a card group."""
    if any(_item_link_is_present(item, extracted_text) for item in items):
        return True

    item_fragments = [_item_text_fragments(item) for item in items]
    occurrences = Counter(
        fragment for fragments in item_fragments for fragment in fragments
    )
    matched_items = sum(
        any(
            occurrences[fragment] == 1 and fragment in extracted_text
            for fragment in fragments
        )
        for fragments in item_fragments
    )
    return matched_items >= _MIN_REPEATED_TEXT_MATCHES


# 条目链接提供正文来自该组的证据，减少误补。
def _item_link_is_present(item: Tag, extracted_text: str) -> bool:
    for node in item.find_all("a", href=True):
        if not isinstance(node, Tag):
            continue
        href = node.get("href")
        if isinstance(href, str):
            normalized_href = _normalized_comparison_text(href)
            if normalized_href and normalized_href in extracted_text:
                return True
    return False


# 收集可区分条目的短片段，辅助判断提取源。
def _item_text_fragments(item: Tag) -> set[str]:
    """Collect short semantic fragments that can identify one repeated item."""
    fragments: set[str] = set()
    for node in item.find_all():
        if not isinstance(node, Tag):
            continue
        fragment = _normalized_comparison_text(node.get_text(" ", strip=True))
        if len(fragment) >= _MIN_DISTINCTIVE_FRAGMENT_LENGTH:
            fragments.add(fragment)
    return fragments


# 用条目首尾文字识别截断，不把相似标题当完整正文。
def _item_fingerprints(item: Tag) -> tuple[str, str]:
    words = _normalized_comparison_text(item.get_text(" ", strip=True)).split()
    return " ".join(words[:8]), " ".join(words[-4:])


# 忽略格式差异以比较网页条目与Markdown内容。
def _normalized_comparison_text(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value.casefold()).strip()


# 补回正文中被提取器漏掉的有意义链接。
def _append_missing_article_links(content: str, soup: BeautifulSoup) -> str:
    """Preserve meaningful article links discarded by strict extraction."""
    root = soup.find("article") or soup.find("main")
    if not isinstance(root, Tag):
        return content

    missing: list[str] = []
    for node in root.find_all("a", href=True):
        if not isinstance(node, Tag):
            continue
        href = node.get("href")
        label = node.get_text(" ", strip=True)
        if (
            isinstance(href, str)
            and href.startswith(("http://", "https://"))
            and label
            and href not in content
        ):
            missing.append(f"[{label}]({href})")
    if not missing:
        return content
    return f"{content}\n\n" + "\n\n".join(missing)


# 分页链接从原DOM补回，不恢复其他导航噪声。
def _append_pagination_links(content: str, soup: BeautifulSoup) -> str:
    """Append Previous/Next links removed with navigation boilerplate."""
    links: list[str] = []
    seen: set[str] = set()
    for node in soup.find_all("a", href=True):
        if not isinstance(node, Tag):
            continue
        relation = _pagination_relation(node)
        href = node.get("href")
        if relation is None or not isinstance(href, str) or href in seen:
            continue
        seen.add(href)
        label = node.get_text(" ", strip=True) or relation
        links.append(f"- {relation}: [{label}]({href})")
    if not links:
        return content
    return f"{content}\n\n## Pagination\n\n" + "\n".join(links)


# 只识别明确的前后页关系，避免收集无关链接。
def _pagination_relation(node: Tag) -> str | None:
    relation = node.get("rel")
    relations = (
        {value.casefold() for value in relation if isinstance(value, str)}
        if isinstance(relation, list)
        else set()
    )
    if "next" in relations:
        return "Next"
    if "prev" in relations or "previous" in relations:
        return "Previous"
    for name, label in (
        ("next", "Next"),
        ("previous", "Previous"),
        ("prev", "Previous"),
    ):
        if node.find_parent(
            class_=lambda value, expected=name: (
                isinstance(value, str) and expected in value.casefold().split()
            )
        ):
            return label
    return None


# 清理空白并按需要去重，列表恢复时保留不同条目。
def _clean_markdown(content: str, *, deduplicate: bool = True) -> str:
    content = content.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    content = re.sub(r"[ \t]+\n", "\n", content)
    content = re.sub(r"\n{4,}", "\n\n\n", content)
    cleaned = content.strip()
    return _deduplicate_blocks(cleaned) if deduplicate else cleaned


# 仅去掉重复块，避免引入片段重叠。
def _deduplicate_blocks(content: str) -> str:
    """Remove repeated extraction blocks without introducing chunk overlap."""
    unique: list[str] = []
    seen: set[str] = set()
    for block in re.split(r"\n{2,}", content):
        normalized = re.sub(r"\s+", " ", block).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(block.strip())
    return "\n\n".join(unique)


# 以去除Markdown标记后的长度评估可读正文。
def _plain_text(markdown: str) -> str:
    return re.sub(r"[#>*_`\[\]()|!~-]", "", markdown).strip()
