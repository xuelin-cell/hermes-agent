"""Builtin reference, candidate and cancellation contracts through real parsers."""

import asyncio
import time
from unittest.mock import AsyncMock

import pytest

from .test_unisearch import load_package

load_package()
from unisearch_test_plugin.fetch.builtin.content import extract_content
from unisearch_test_plugin.fetch.builtin.links import extract_links
from unisearch_test_plugin.fetch.builtin.http import RawPage
from unisearch_test_plugin.fetch.builtin.security import URLSecurityError
from unisearch_test_plugin.fetch.builtin.browser import BrowserRenderError
from unisearch_test_plugin.fetch.builtin_parse import (
    BuiltinParseFetchProvider,
    WebAPIError,
)


# 同一文档的正文引用和发现链接必须使用相同基准，同时保住应用路由。
@pytest.mark.parametrize(
    "base,expected",
    [
        ('<base href="//example.com/docs/">', "https://example.com/docs/guide"),
        ('<base href="/docs/">', "https://example.com/docs/guide"),
        ('<base href="../docs/">', "https://example.com/docs/guide"),
        (
            '<base href="https://other.example/docs/">',
            "https://other.example/docs/guide",
        ),
        (
            '<base href="javascript:bad"><base href="/ignored/">',
            "https://example.com/news/guide",
        ),
        ("", "https://example.com/news/guide"),
    ],
)
def test_document_links_share_base_and_preserve_route_identity(base, expected):
    html = f'<html><head>{base}</head><body><article><h1>Guide</h1><p>Read this detailed documentation and use the following reference links.</p><a href="guide">Guide reference</a><a href="/#/a">Article A</a><a href="/#/b">Article B</a><a href="/#!/c">Article C</a><a href="guide#one">One</a><a href="guide#two">Two</a><a href="https://user:password@example.com/">Bad</a></article></body></html>'
    links = extract_links(html, "https://example.com/news/index")
    content = extract_content(html, "https://example.com/news/index").markdown
    assert expected in links and expected in content
    assert any(x.endswith("/#/a") for x in links)
    assert any(x.endswith("/#/b") for x in links)
    assert any(x.endswith("/#!/c") for x in links)
    assert links.count(expected) == 1
    assert not any("password" in x for x in links)


# 短正文、噪声、应用路由及超时均执行真实提取和候选决策。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "static_html,rendered_html,url,expected,status",
    [
        (
            '<article><h1>Guide</h1><p>This is a useful article explaining the subject with details for readers.</p><form><h1>Sign in</h1><input type="password"></form></article>',
            None,
            "https://example.com/",
            "useful article",
            "usable",
        ),
        (
            "<main><h1>Notice</h1><p>Closed on Monday.</p></main>",
            None,
            "https://example.com/",
            "Closed on Monday",
            "usable",
        ),
        (
            "<main><table><tr><th>Item</th><th>Price</th></tr><tr><td>Book</td><td>10</td></tr></table></main>",
            None,
            "https://example.com/",
            "Book",
            "usable",
        ),
        (
            "<article><h1>How login and verification work</h1><p>This article explains how to verify you are human and sign in safely.</p></article>",
            None,
            "https://example.com/",
            "explains",
            "usable",
        ),
        (
            "<h1>Verify you are human</h1><p>Please complete the security check.</p>",
            None,
            "https://example.com/",
            None,
            "unavailable",
        ),
        (
            "<title>Sign in</title><h1>Sign in</h1><p>"
            + "Read our long account and login instructions. " * 40
            + "</p>",
            None,
            "https://example.com/",
            None,
            "unavailable",
        ),
        (
            '<main><p>Useful static article.</p></main><div id="app"></div>',
            "<main><p>Hydrated full article with all the requested details.</p></main>",
            "https://example.com/",
            "Hydrated full",
            "usable",
        ),
        (
            "<div>Useful short static content.</div>",
            "<title>Sign in</title><p>" + "Login instructions. " * 40 + "</p>",
            "https://example.com/",
            "Useful short static",
            "partial",
        ),
        (
            "<main><p>Useful partial article.</p><p>Loading...</p></main>",
            None,
            "https://example.com/",
            "Useful partial",
            "partial",
        ),
        (
            "<main><p>Useful partial article.</p><p>Loading...</p></main>",
            "<main><h1>Finished</h1><p>Full browser article with all the details.</p></main>",
            "https://example.com/",
            "Full browser",
            "usable",
        ),
        (
            "<main>Homepage content is not the target article.</main>",
            None,
            "https://example.com/#/a",
            None,
            "unavailable",
        ),
    ],
)
async def test_candidate_selection_uses_content_not_length(
    static_html, rendered_html, url, expected, status
):
    provider = BuiltinParseFetchProvider(timeout=3)
    provider._http.fetch = AsyncMock(
        return_value=RawPage(static_html, url.split("#")[0], 200, {})
    )
    if rendered_html is None:
        provider._browser.render = AsyncMock(
            side_effect=BrowserRenderError("unavailable")
        )
    else:
        provider._browser.render = AsyncMock(
            return_value=RawPage(rendered_html, url, 200, {})
        )
    if expected is None:
        with pytest.raises(WebAPIError):
            await provider.fetch(url)
    else:
        result = await provider.fetch(url)
        assert expected in result.content
        assert result.fetch_status == status
        if status == "partial":
            assert result.reasons


# 浏览器耗尽局部预算可保留候选；安全拒绝和用户取消不能变成成功。
@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["timeout", "cancel", "security"])
async def test_partial_candidate_survives_only_recoverable_render_failure(mode):
    provider = BuiltinParseFetchProvider(timeout=0.3 if mode == "timeout" else 5)
    page = RawPage(
        "<main><p>Useful partial article.</p><p>Loading...</p></main>",
        "https://example.com/",
        200,
        {},
    )
    provider._http.fetch = AsyncMock(return_value=page)
    entered = asyncio.Event()

    # 显式同步启动，避免取消测试依赖调度速度。
    async def render(*args, **kwargs):
        entered.set()
        if mode == "security":
            raise URLSecurityError("blocked")
        await asyncio.Event().wait()

    provider._browser.render = render
    start = time.monotonic()
    task = asyncio.create_task(provider.fetch(page.url))
    await entered.wait()
    if mode == "cancel":
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    elif mode == "security":
        with pytest.raises(WebAPIError, match="blocked unsafe"):
            await task
    else:
        result = await task
        assert "Useful partial" in result.content
        assert result.fetch_status == "partial" and "render_timeout" in result.reasons
        assert time.monotonic() - start < 3


# 升级后不复用未经评估的旧缓存，只有合格正文允许再次命中。
@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["usable", "partial", "unavailable", "missing"])
async def test_builtin_cache_reassesses_legacy_and_excludes_weak_results(
    tmp_path, status
):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from unisearch_test_plugin import cache
    from unisearch_test_plugin.fetch.providers import BuiltinParseProvider

    token = set_hermes_home_override(tmp_path)
    provider = BuiltinParseProvider(lambda key, default=None: default)
    url = "https://example.com/cache-upgrade"
    legacy = {"url": url, "content": "Legacy unassessed response"}
    cache.put(
        cache.identity(provider.name, "", "", url),
        {"success": True, "data": legacy},
        provider._config,
    )
    fresh = {
        "url": url,
        "content": "Fresh response",
        "engine": "http",
        "fetch_status": status,
        "reasons": ["thin_content"] if status == "partial" else [],
    }
    if status == "unavailable":
        fresh.update(content="", error="No usable body", reasons=["access_page"])
    if status == "missing":
        fresh.pop("fetch_status")
    provider._fetch = AsyncMock(return_value=fresh)
    try:
        first = (await provider.extract([url]))[0]
        second = (await provider.extract([url]))[0]
        assert "Legacy" not in first["content"]
        assert first["fetch_status"] == (
            "unavailable" if status == "missing" else status
        )
        assert second["fetch_status"] == first["fetch_status"]
        assert provider._fetch.await_count == (1 if status == "usable" else 2)
    finally:
        reset_hermes_home_override(token)


# 验证提示不能成为正文或成功缓存；正常登录主题文章不因标题被拒绝。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind", ["challenge", "login_article", "challenge_quote", "login_wall"]
)
@pytest.mark.parametrize("legacy", [False, True])
async def test_access_assessment_checks_body_and_cache_admission(
    tmp_path, kind, legacy
):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from unisearch_test_plugin.fetch.providers import BuiltinParseProvider
    from unisearch_test_plugin import cache

    paragraphs = "<p>The login protocol uses a short lived authorization code to identify a session. This technical article documents its request fields and response format.</p><p>The application exchanges the code for a session token through the documented endpoint. Review the configuration below before starting development.</p>"
    pages = {
        "challenge": '<title>Security check</title><main><p>Checking your browser before accessing this website. Please wait while we verify that your connection is secure.</p><div id="cf-chl-widget">Security verification in progress. JavaScript challenge is being prepared.</div></main>',
        "login_article": "<title>Login</title><article><h1>Login</h1>"
        + paragraphs
        + "<table><tr><td>code</td><td>Authorization code</td></tr></table></article>",
        "challenge_quote": "<title>Verification guide</title><article><h1>Verification guide</h1>"
        + paragraphs
        + "<p>The phrase checking your browser describes a verification step. This documentation explains how the cf-chl- marker is used.</p></article>",
        "login_wall": '<title>Login</title><main><h1>Login</h1><form><input type="password"><button>Sign in</button></form><p>Please sign in to access this page.</p></main>',
    }
    url = "https://example.com/" + kind
    parser = BuiltinParseFetchProvider(timeout=3)
    parser._http.fetch = AsyncMock(return_value=RawPage(pages[kind], url, 200, {}))
    parser._browser.render = AsyncMock(
        side_effect=BrowserRenderError("fixture unavailable")
    )
    token = set_hermes_home_override(tmp_path)
    provider = BuiltinParseProvider(lambda key, default=None: default)
    # 旧版曾把验证提示写为usable；新评估不能复用它。
    if legacy:
        cache.put(
            cache.identity(
                "builtin-quality-v2", cache.identity(provider.name, "", "", url)
            ),
            {
                "success": True,
                "data": {
                    "url": url,
                    "content": "STALE_WRONG_RESULT",
                    "fetch_status": "usable",
                    "engine": "http",
                    "reasons": [],
                },
            },
            provider._config,
        )

    # 只替换进程传输；实际正文提取、候选选择、缓存准入连续执行。
    async def fetch(url, key):
        try:
            result = await parser.fetch(url)
            return {
                "url": url,
                "content": result.content,
                "fetch_status": result.fetch_status,
                "engine": result.engine,
                "reasons": result.reasons,
            }
        except WebAPIError as exc:
            return {
                "url": url,
                "content": "",
                "error": "No body",
                "fetch_status": "unavailable",
                "reasons": [exc.reason],
            }

    provider._fetch = AsyncMock(side_effect=fetch)
    try:
        first = (await provider.extract([url]))[0]
        second = (await provider.extract([url]))[0]
        good = kind in {"login_article", "challenge_quote"}
        assert "STALE_WRONG_RESULT" not in first["content"]
        assert first["fetch_status"] == ("usable" if good else "unavailable")
        assert first["fetch_status"] == second["fetch_status"]
        assert provider._fetch.await_count == (1 if good else 2)
        assert parser._browser.render.await_count == (0 if good else 2)
        if good:
            assert "authorization code" in first["content"]
        else:
            assert not first["content"] and first["reasons"] == ["access_page"]
    finally:
        reset_hermes_home_override(token)


# 合并只使用已验证的采样；末尾登录墙不能覆盖此前正文或混入其链接。
@pytest.mark.asyncio
@pytest.mark.parametrize("late_access", [False, True])
async def test_rendered_samples_use_their_own_quality_and_keep_only_valid_links(
    late_access,
):
    url = "https://example.com/article"
    static = "<main><p>STATIC fallback text.</p><p>Loading...</p></main>"
    access = '<title>Login</title><main><h1>Login</h1><form><input type="password"></form><a href="/signin">Sign in</a></main>'
    valid = '<article><h1>Actual article</h1><p>VALID_CAPTURE contains the article body that was actually read.</p><a href="/reference">Reference</a></article>'
    snapshots = (valid, access) if late_access else (access, valid)
    provider = BuiltinParseFetchProvider(timeout=3)
    provider._http.fetch = AsyncMock(return_value=RawPage(static, url, 200, {}))
    provider._browser.render = AsyncMock(
        return_value=RawPage(
            snapshots[0],
            url,
            200,
            {},
            snapshots=snapshots,
            interaction_reasons=("interaction_scope_limited",),
        )
    )
    result = await provider.fetch(url)
    assert "VALID_CAPTURE" in result.content
    assert result.engine == "chromium" and result.fetch_status == "partial"
    assert url.rsplit("/", 1)[0] + "/reference" in result.links
    assert not any("/signin" in link for link in result.links)
    if late_access:
        assert "render_no_usable_content" in result.reasons


# 有长说明的登录表单仍是访问门槛；标题相同的文章及其附属表单可以保留。
@pytest.mark.asyncio
@pytest.mark.parametrize("article", [False, True])
async def test_login_form_with_long_text_is_not_mistaken_for_article(article):
    paragraphs = "<p>To continue reading, sign in with your registered account and provide your password in the form below.</p><p>Your account grants access to this service. Complete the authentication step before reading the requested page.</p>"
    form = '<form><input type="password"><button>Sign in</button></form>'
    article_body = "<p>The login protocol uses a short lived authorization code. This technical article explains request and response fields.</p><p>Applications validate the returned session token before loading protected content. Review the documented configuration options.</p>"
    html = (
        "<title>Login</title><main><h1>Login</h1>"
        + (
            "<article>" + article_body + "</article>" + form
            if article
            else paragraphs + form
        )
        + "</main>"
    )
    url = "https://example.com/login-topic"
    provider = BuiltinParseFetchProvider(timeout=3)
    provider._http.fetch = AsyncMock(return_value=RawPage(html, url, 200, {}))
    provider._browser.render = AsyncMock(
        side_effect=BrowserRenderError("fixture unavailable")
    )
    if article:
        assert (await provider.fetch(url)).fetch_status == "usable"
    else:
        with pytest.raises(WebAPIError) as failure:
            await provider.fetch(url)
        assert failure.value.reason == "access_page"


# 验证页之后只出现薄弱占位文本，不应因此优先替换已有的有效静态正文。
@pytest.mark.asyncio
async def test_thin_post_challenge_sample_does_not_displace_static_body():
    url = "https://example.com/article"
    static = "<main><p>KEEP_STATIC contains useful article details for readers and should survive an unsuccessful browser attempt.</p><p>Loading...</p></main>"
    access = "<title>Login</title><h1>Login</h1><p>Sign in to continue.</p>"
    thin = "<div>Welcome</div>"
    provider = BuiltinParseFetchProvider(timeout=3)
    provider._http.fetch = AsyncMock(return_value=RawPage(static, url, 200, {}))
    provider._browser.render = AsyncMock(
        return_value=RawPage(
            access,
            url,
            200,
            {},
            snapshots=(access, thin),
            interaction_reasons=("interaction_scope_limited",),
        )
    )
    result = await provider.fetch(url)
    assert "KEEP_STATIC" in result.content and result.engine == "http"


# HTTP 200软错误页不能因长段落或表格放行；相关主题文章和代码引用保持可读。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind", ["soft404", "denied", "error_table", "article", "quoted", "http404"]
)
async def test_soft_error_pages_and_related_articles_have_distinct_cache_admission(
    tmp_path, kind
):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from unisearch_test_plugin.fetch.providers import BuiltinParseProvider
    from unisearch_test_plugin import cache

    error = "<p>The requested page is not available. The address may have changed or the page may have been removed from this website.</p><p>Please check the address and try again, or return to the home page to find another resource. Contact support if the problem persists.</p>"
    article = "<p>HTTP 404 indicates that the server could not locate a requested resource. This article describes routing and response handling.</p><p>Applications should map missing routes to the appropriate handler and display a helpful response. Review the implementation examples below.</p>"
    title = "Access denied" if kind == "denied" else "404 Not Found"
    body = article if kind in {"article", "quoted", "http404"} else error
    if kind == "quoted":
        body += "<pre><code>&lt;p&gt;The requested page is not available.&lt;/p&gt;</code></pre>"
    if kind == "error_table":
        body = "<table><tr><td>The requested page is not available.</td><td>Return to the home page.</td></tr></table>"
    html = f"<title>{title}</title><main><h1>{title}</h1>{body}</main>"
    url = "https://example.com/soft-error-" + kind
    parser = BuiltinParseFetchProvider(timeout=3)
    parser._http.fetch = AsyncMock(
        return_value=RawPage(html, url, 404 if kind == "http404" else 200, {})
    )
    parser._browser.render = AsyncMock(
        side_effect=BrowserRenderError("fixture unavailable")
    )
    provider = BuiltinParseProvider(lambda key, default=None: default)
    token = set_hermes_home_override(tmp_path)
    # v3可缓存误判的软错误页；升级后必须重新经过实际质量判断。
    cache.put(
        cache.identity(
            "builtin-quality-v3", cache.identity(provider.name, "", "", url)
        ),
        {
            "success": True,
            "data": {
                "url": url,
                "content": "STALE_SOFT_ERROR",
                "fetch_status": "usable",
                "engine": "http",
                "reasons": [],
            },
        },
        provider._config,
    )

    # 只替换worker传输，正文/状态/缓存准入均执行生产逻辑。
    async def transfer(url, key):
        try:
            value = await parser.fetch(url)
            return {
                "url": url,
                "content": value.content,
                "fetch_status": value.fetch_status,
                "engine": value.engine,
                "reasons": value.reasons,
            }
        except WebAPIError as exc:
            return {
                "url": url,
                "content": "",
                "error": "No readable body",
                "fetch_status": "unavailable",
                "reasons": [exc.reason],
            }

    provider._fetch = AsyncMock(side_effect=transfer)
    try:
        first = (await provider.extract([url]))[0]
        second = (await provider.extract([url]))[0]
        good = kind in {"article", "quoted"}
        assert "STALE_SOFT_ERROR" not in first["content"]
        assert (
            first["fetch_status"]
            == second["fetch_status"]
            == ("usable" if good else "unavailable")
        )
        assert provider._fetch.await_count == (1 if good else 2)
        if good:
            assert "routing and response handling" in first["content"]
        else:
            assert not first["content"]
    finally:
        reset_hermes_home_override(token)


# 引用示例保持正文可读，真实错误说明即使同时带引用也仍须拒收。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", ["inline_code", "blockquote", "table_code", "real_error"]
)
async def test_error_evidence_separates_quoted_examples_from_page_state(case):
    article = "<p>HTTP 404 indicates that the server could not locate a requested resource. This article describes routing and response handling.</p><p>Applications should map missing routes to the appropriate handler and display a helpful response. Review the implementation examples below.</p>"
    examples = {
        "inline_code": "<p><code>The requested page is not available.</code> is an example response, not this documentation page's status.</p>",
        "blockquote": "<blockquote><p>The requested page is not available.</p></blockquote>",
        "table_code": "<table><tr><td><code>The requested page is not available.</code></td><td>Example message</td></tr></table>",
        "real_error": "<p>The requested page is not available. Please return to the homepage.</p><blockquote><p>Example status code: 404.</p></blockquote>",
    }
    raw = RawPage(
        "<title>404 Not Found</title><article><h1>404 Not Found</h1>"
        + article
        + examples[case]
        + "</article>",
        "https://example.com/docs",
        200,
        {},
    )
    parser = BuiltinParseFetchProvider(timeout=3)
    parser._http.fetch = AsyncMock(return_value=raw)
    parser._browser.render = AsyncMock(return_value=raw)
    if case == "real_error":
        with pytest.raises(WebAPIError) as failure:
            await parser.fetch(raw.url)
        assert failure.value.reason == "access_page"
    else:
        result = await parser.fetch(raw.url)
        assert result.fetch_status == "usable"
        assert "routing and response handling" in result.content
        assert "The requested page is not available." in result.content
        assert parser._browser.render.await_count == 0


# 主内容busy须贯通补抓/缓存；旁栏、隐藏及引用中的标记不能触发无关补抓。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "main",
        "nested",
        "sidebar",
        "hidden",
        "css_hidden",
        "false",
        "quotation",
        "render_busy",
        "render_failure",
        "parent",
        "hidden_loading",
        "quoted_loading",
        "hidden_sibling",
        "invalid_style",
        "vendor_display",
        "unknown_context",
        "unknown_render_failure",
    ],
)
async def test_main_busy_drives_render_and_cache_admission(tmp_path, case):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from unisearch_test_plugin.fetch.providers import BuiltinParseProvider
    from unisearch_test_plugin import cache

    paragraphs = "<p>INITIAL useful article contains details already loaded for the reader and enough context to be independently readable.</p><p>More related information is described here with complete sentences and a stable document structure.</p>"
    extras = {
        "nested": '<section aria-busy="true">Additional entries are being fetched.</section>',
        "sidebar": '<aside aria-busy="true">Additional entries are being fetched.</aside>',
        "hidden": '<section hidden><div aria-busy="true">Pending entries</div></section>',
        "css_hidden": '<section style="display: none !important"><div aria-busy="true">Pending entries</div></section>',
        "quotation": '<blockquote><div aria-busy="true">Example markup</div></blockquote>',
        "hidden_loading": '<section hidden><div aria-busy="true">Loading...</div></section>',
        "quoted_loading": '<blockquote><p aria-busy="true">Loading...</p></blockquote>',
        "hidden_sibling": "<section><span>Loading...</span><span hidden>Decorative text</span></section>",
        "invalid_style": '<section aria-busy="true" style="display:none;display:bogus">Loading...</section>',
    }
    extras["vendor_display"] = (
        '<section aria-busy="true" style="display:none;display:-webkit-box">Loading...</section>'
    )
    unknown_context = '<section><span>Loading...</span><span style="display:none;display:-moz-box">Decoration</span></section>'
    extras["unknown_context"] = extras["unknown_render_failure"] = unknown_context
    active = case in {
        "main",
        "nested",
        "render_busy",
        "render_failure",
        "parent",
        "hidden_sibling",
        "vendor_display",
        "unknown_context",
        "unknown_render_failure",
    }
    attr = (
        ' aria-busy="true"'
        if case in {"main", "render_busy", "render_failure"}
        else ' aria-busy="false"'
    )
    html = (
        "<main"
        + attr
        + ">"
        + paragraphs
        + extras.get(case, "")
        + '</main><script src="/entries.js"></script>'
    )
    if case == "parent":
        html = '<div id="app" aria-busy="true">' + html + "</div>"
    url = "https://example.com/busy-" + case
    parser = BuiltinParseFetchProvider(timeout=3)
    raw = RawPage(html, url, 200, {})
    parser._http.fetch = AsyncMock(return_value=raw)
    completed = RawPage(
        "<main>" + paragraphs + "<p>FINISHED additional content.</p></main>",
        url,
        200,
        {},
    )
    parser._browser.render = AsyncMock(
        return_value=raw if case == "render_busy" else completed
    )
    if case in {"render_failure", "unknown_render_failure"}:
        parser._browser.render.side_effect = BrowserRenderError("fixture unavailable")
    provider = BuiltinParseProvider(lambda key, default=None: default)
    token = set_hermes_home_override(tmp_path)
    # v9可能把未知文字旁的加载页面误缓存；修正后必须重判。
    if case in {
        "main",
        "parent",
        "hidden_sibling",
        "vendor_display",
        "unknown_context",
        "unknown_render_failure",
    }:
        cache.put(
            cache.identity(
                "builtin-quality-v9", cache.identity(provider.name, "", "", url)
            ),
            {
                "success": True,
                "data": {
                    "url": url,
                    "content": "STALE_BUSY_RESULT",
                    "fetch_status": "usable",
                    "engine": "http",
                    "reasons": [],
                },
            },
            provider._config,
        )

    # 只替换worker传输，真实候选选择与Provider缓存连续执行。
    async def transfer(url, key):
        value = await parser.fetch(url)
        return {
            "url": url,
            "content": value.content,
            "fetch_status": value.fetch_status,
            "engine": value.engine,
            "reasons": value.reasons,
        }

    provider._fetch = AsyncMock(side_effect=transfer)
    try:
        first = (await provider.extract([url]))[0]
        second = (await provider.extract([url]))[0]
        limited = case in {"render_busy", "render_failure", "unknown_render_failure"}
        assert (
            first["fetch_status"]
            == second["fetch_status"]
            == ("partial" if limited else "usable")
        )
        assert "STALE_BUSY_RESULT" not in first["content"]
        assert provider._fetch.await_count == (2 if limited else 1)
        assert parser._browser.render.await_count == (
            (2 if limited else 1) if active else 0
        )
        if active and not limited:
            assert "FINISHED" in first["content"] and first["engine"] == "chromium"
        if limited:
            assert "INITIAL" in first["content"]
            assert "dynamic_content_pending" in first["reasons"]
            assert first["browser_followup"]["needed"]
    finally:
        reset_hermes_home_override(token)
