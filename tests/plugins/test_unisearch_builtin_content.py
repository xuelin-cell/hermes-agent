from __future__ import annotations
from .test_unisearch import load_package

load_package()

from configparser import NoOptionError

import trafilatura

from unisearch_test_plugin.fetch.builtin.content import extract_content, needs_browser

_CARD_COUNT = 10
_FALLBACK_CARD_COUNT = 3
_TRAFILATURA_MISSING_OPTION = "min_extracted_size"
_TRAFILATURA_DEFAULT_SECTION = "DEFAULT"


# 去导航噪声同时保留正文链接，不产生重复段落。
def test_extract_content_removes_noise_normalizes_links_and_deduplicates() -> None:
    paragraph = "A unique article paragraph with enough meaningful words to be retained by the extraction pipeline."
    html = f"""
    <html><head><meta property="og:title" content="Extraction title"></head><body>
      <nav>Navigation noise that should not be part of the result.</nav>
      <article><h1>Heading</h1><p>{paragraph}</p><p>{paragraph}</p>
      <p><a href="/docs/details">Read the detailed documentation from this relative link.</a></p></article>
      <footer>Footer noise that should not be part of the result.</footer>
    </body></html>
    """

    result = extract_content(html, "https://example.com/articles/one")

    assert result.title == "Extraction title"
    assert paragraph in result.markdown
    assert result.markdown.count(paragraph) == 1
    assert "https://example.com/docs/details" in result.markdown
    assert "Navigation noise" not in result.markdown
    assert "Footer noise" not in result.markdown


# 空动态壳需浏览器补抓，不能当成已取得正文。
def test_needs_browser_rejects_empty_javascript_application_shell() -> None:
    html = '<html><body><div id="root"></div><script src="bundle.js"></script></body></html>'

    content = extract_content(html, "https://example.com/app")

    assert needs_browser(html, content) is True


# 静态文章足够时不额外启动浏览器。
def test_needs_browser_accepts_substantial_static_article() -> None:
    html = """
    <html><body><article><h1>Article</h1>
    <p>This first static paragraph contains substantial useful information and is long enough for quality evaluation.</p>
    <p>This second static paragraph contains more useful information and confirms that this is not an application shell.</p>
    <p>A final paragraph provides additional material so the extracted article comfortably passes the static threshold.</p>
    </article></body></html>
    """

    content = extract_content(html, "https://example.com/article")

    assert needs_browser(html, content) is False


# 挑战页面不能误判为正常正文。
def test_needs_browser_detects_challenge_page() -> None:
    repeated = "Checking your browser before accessing the requested article. " * 20
    html = f"<html><body><main>{repeated}</main><div class='cf-chl-widget'></div></body></html>"

    content = extract_content(html, "https://example.com/challenge")

    assert needs_browser(html, content) is True


# 提取器缺配置时仍可从HTML取得可读内容。
def test_extract_content_falls_back_when_trafilatura_config_is_missing(
    monkeypatch,
) -> None:
    cards = "".join(
        f"""
        <article class="product-card">
          <h2><a href="/book/{index}">Book {index}</a></h2>
          <p class="price">Price {index}</p>
          <p class="star-rating Three"></p>
        </article>
        """
        for index in range(1, _FALLBACK_CARD_COUNT + 1)
    )
    html = f"""
    <html><body>
      <nav>Navigation noise <ul><li class="next"><a href="/catalogue/page-2/">Next</a></li></ul></nav>
      <main>{cards}</main>
    </body></html>
    """

    # 模拟提取器缺配置，确认HTML兜底仍可用。
    def missing_config(*args: object, **kwargs: object) -> str:
        del args, kwargs
        raise NoOptionError(_TRAFILATURA_MISSING_OPTION, _TRAFILATURA_DEFAULT_SECTION)

    monkeypatch.setattr(trafilatura, "extract", missing_config)

    result = extract_content(html, "https://example.com/catalogue/")

    for index in range(1, _FALLBACK_CARD_COUNT + 1):
        assert f"Book {index}" in result.markdown
        assert f"https://example.com/book/{index}" in result.markdown
    assert result.markdown.count("Rating: Three") == _FALLBACK_CARD_COUNT
    assert "Navigation noise" not in result.markdown
    assert "## Pagination" in result.markdown
    assert "https://example.com/catalogue/page-2/" in result.markdown


# 主列表条目及标签不能因去重而被遗漏。
def test_extract_content_preserves_all_repeated_cards_and_tags(monkeypatch) -> None:
    cards = "".join(
        f"""
        <div class="quote-card">
          <a class="item-link" href="/quote/{index}">Open quote {index}</a>
          <span class="text">Unique quote number {index} with enough text to represent a substantial repeated content card.</span>
          <small class="author">Author {index}</small>
          <span class="price">Price {index}</span>
          <span class="availability">In stock</span>
          <p class="star-rating Three"><i class="icon-star"></i></p>
          <div class="tags"><a class="tag" href="/tag/tag-{index}">tag-{index}</a></div>
        </div>
        """
        for index in range(1, 11)
    )
    html = f"<html><body><main><div class='results'>{cards}</div></main></body></html>"
    partial = "\n\n".join(f"Price {index}" for index in range(1, 11))

    # 模拟只保留部分主列表，验证正文恢复与推荐区边界。
    def partial_extract(*args: object, **kwargs: object) -> str:
        del args, kwargs
        return partial

    monkeypatch.setattr(trafilatura, "extract", partial_extract)

    result = extract_content(html, "https://example.com/quotes/")

    for index in range(1, 11):
        assert f"Unique quote number {index} " in result.markdown
        assert f"Author {index}" in result.markdown
        assert f"tag-{index}" in result.markdown
    assert result.markdown.count("In stock") == _CARD_COUNT
    assert result.markdown.count("Rating: Three") == _CARD_COUNT


# 保留前后页入口，同时继续移除其他导航。
def test_extract_content_preserves_pagination_links_while_removing_other_navigation() -> (
    None
):
    html = """
    <html><body>
      <main><article><p>A sufficiently substantial article paragraph that remains in the extracted page content.</p></article></main>
      <nav><a href="/account">Account</a><ul class="pager">
        <li class="previous"><a href="/page/1">Previous</a></li>
        <li class="next"><a href="/page/3">Next</a></li>
      </ul></nav>
    </body></html>
    """

    result = extract_content(html, "https://example.com/page/2")

    assert "## Pagination" in result.markdown
    assert "Previous" in result.markdown
    assert "https://example.com/page/1" in result.markdown
    assert "Next" in result.markdown
    assert "https://example.com/page/3" in result.markdown
    assert "Account" not in result.markdown


# 主文已完整时仍保留条目元数据。
def test_extract_content_restores_card_metadata_when_all_primary_text_is_present(
    monkeypatch,
) -> None:
    cards = "".join(
        f"""
        <article class="result-card">
          <p>Complete primary text for result card number {index} with enough unique words for matching.</p>
          <a class="tag" href="/tag/metadata-{index}">metadata-{index}</a>
        </article>
        """
        for index in range(1, 6)
    )
    html = f"<html><body><main><div class='results'>{cards}</div></main></body></html>"
    primary_text_only = "\n\n".join(
        f"Complete primary text for result card number {index} with enough unique words for matching."
        for index in range(1, 6)
    )

    # 模拟只保留部分主列表，验证正文恢复与推荐区边界。
    def partial_extract(*args: object, **kwargs: object) -> str:
        del args, kwargs
        return primary_text_only

    monkeypatch.setattr(trafilatura, "extract", partial_extract)

    result = extract_content(html, "https://example.com/results/")

    for index in range(1, 6):
        assert f"metadata-{index}" in result.markdown


# 最近浏览推荐不能覆盖详情正文。
def test_extract_content_does_not_replace_detail_with_recently_viewed_cards(
    monkeypatch,
) -> None:
    detail = (
        "Sharp Objects is the requested book detail. Its description, price, availability, "
        "and product information must remain the primary extracted content."
    )
    recent_cards = "".join(
        f"""
        <article class="product-card">
          <h3><a href="/catalogue/recent-{index}/">Recently viewed book {index}</a></h3>
          <p>Unrelated recommendation number {index} with enough repeated card text for detection.</p>
        </article>
        """
        for index in range(1, 5)
    )
    html = f"""
    <html><head><title>Sharp Objects</title></head><body>
      <main>
        <section class="product-detail"><h1>Sharp Objects</h1><p>{detail}</p></section>
        <section><h2>Products you recently viewed</h2>{recent_cards}</section>
        <section><h2>Terms</h2><p>Important terms after the recommendations remain available.</p></section>
      </main>
    </body></html>
    """

    # 模拟保留详情与部分推荐项，验证恢复不能替换主文。
    def detail_extract(extraction_html: str, *args: object, **kwargs: object) -> str:
        del args, kwargs
        assert "Products you recently viewed" not in extraction_html
        assert "Recently viewed book" not in extraction_html
        assert "Important terms after the recommendations" in extraction_html
        return f"# Sharp Objects\n\n{detail}"

    monkeypatch.setattr(trafilatura, "extract", detail_extract)

    result = extract_content(
        html, "https://example.com/catalogue/sharp-objects/index.html"
    )

    assert "Sharp Objects is the requested book detail" in result.markdown
    assert "Recently viewed book" not in result.markdown
