"""Shared evidence must preserve readable articles and reject hidden gate evidence."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from .test_unisearch import load_package

load_package()
from unisearch_test_plugin.fetch.builtin.content import extract_content  # noqa: E402
from unisearch_test_plugin.fetch.builtin.http import RawPage  # noqa: E402
from unisearch_test_plugin.fetch.builtin.quality import assess  # noqa: E402
from unisearch_test_plugin.fetch.builtin_parse import BuiltinParseFetchProvider  # noqa: E402
from unisearch_test_plugin.fetch.builtin.browser import BrowserRenderError  # noqa: E402

BODY = "<p>ARTICLE explains routing and application behavior with enough readable information for a developer to understand the protocol.</p><p>This second paragraph provides practical instructions and examples for handling response status in an application.</p>"
URL = "https://example.com/article"


# 隐藏文字无权改变正文结论；正常教程与真实验证页同时覆盖。
@pytest.mark.parametrize(
    "hidden",
    [
        "hidden",
        'style="display:none"',
        'style="visibility:hidden"',
        'style="opacity:0"',
        'style="content-visibility:hidden"',
    ],
)
@pytest.mark.parametrize("kind", ["tutorial", "challenge"])
def test_hidden_evidence_cannot_invert_quality(hidden, kind):
    if kind == "tutorial":
        base = "<title>404 Not Found</title><article><h1>404 Not Found</h1>" + BODY
        extra = "<p " + hidden + ">The requested page was not found.</p>"
        expected = "usable"
    else:
        base = "<title>Checking your browser</title><main><h1>Checking your browser</h1><p>Please wait while we verify that your connection is secure.</p>"
        extra = "<section " + hidden + ">" + BODY + "</section>"
        expected = "unavailable"
    for html in (base, base + extra):
        content = extract_content(html, URL)
        result = assess(
            RawPage(html, URL, 200, {}), content, requested_url=URL, engine="http"
        )
        assert result.status == expected
        if kind == "tutorial":
            assert "ARTICLE" in content.markdown
            assert "The requested page was not found" not in content.markdown


# 未知正文不能装成已确认，未知侧栏也不能把好文章拖成不完整。
@pytest.mark.asyncio
@pytest.mark.parametrize("scope,expected", [("main", "partial"), ("aside", "usable")])
async def test_unknown_scope_controls_fallback_not_raw_length(scope, expected):
    html = (
        "<main>"
        + BODY
        + "</main><"
        + scope
        + '><p style="display:var(--pending)">UNCERTAIN page text.</p></'
        + scope
        + ">"
    )
    provider = BuiltinParseFetchProvider(timeout=3)
    provider._http.fetch = AsyncMock(return_value=RawPage(html, URL, 200, {}))
    provider._browser.render = AsyncMock(side_effect=BrowserRenderError("offline"))
    result = await provider.fetch(URL)
    assert result.fetch_status == expected
    assert "UNCERTAIN" not in result.content
    assert provider._browser.render.await_count == (1 if scope == "main" else 0)


# 已加载的长页不需要滚动；浏览器正文已足够时不得浪费交互预算。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_loaded_long_page_has_no_reading_actions(monkeypatch):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import collect_loaded

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            html = "<main>" + BODY * 60 + "</main>"
            await page.set_content(html)
            await page.evaluate(
                "() => {window.scrollCalls=0; const old=window.scrollBy; window.scrollBy=(...a)=>{window.scrollCalls++;old(...a)}}"
            )
            capture = await collect_loaded(
                page, html, budget_seconds=4, max_bytes=200000
            )
            assert await page.evaluate("window.scrollCalls") == 0
            assert not capture.reasons
        finally:
            await browser.close()


# 真实HTTP/Chromium验证CSS证据不在回传后丢失，简单渲染不自动滚动。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_rendered_evidence_and_progressive_fetch_through_real_engines(
    monkeypatch,
):
    import asyncio
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin import browser as browser_module
    from unisearch_test_plugin.fetch.builtin.security import NetworkPolicy

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    pages = {
        "/tutorial": "<title>404 Not Found</title><style>.hidden{display:none}</style><article>"
        + BODY
        + '<p class="hidden">The requested page was not found.</p></article>',
        "/challenge": '<title>Checking your browser</title><style>.hidden{display:none}</style><main><h1>Checking your browser</h1><p>Please wait while we verify that your connection is secure.</p><div class="hidden">'
        + BODY
        + "</div></main>",
        "/route": '<main id="app"></main><script>document.querySelector("main").innerHTML='
        + repr(BODY * 40)
        + ";</script>",
        "/expand": "<main>"
        + BODY
        + '<section id="extra" hidden><p>EXPANDED substantive content is only available after the reader opens the section.</p></section><button type="button" onclick="document.querySelector(\'#extra\').hidden=false;this.remove()">Read more</button></main>',
        "/restored": '<style>.parent{visibility:hidden}.child{visibility:visible}</style><main class="parent"><article class="child">'
        + BODY
        + "</article><p>HIDDEN_PARENT_TEXT</p></main>",
    }
    requests = []

    # 本地夹具之外无请求；业务HTTP、渲染、候选与正文均执行生产实现。
    async def serve(reader, writer):
        request = await reader.readuntil(b"\r\n\r\n")
        path = request.split(b" ")[1].decode().split("#")[0]
        requests.append(path)
        html = pages.get(path, "<main>Not found</main>").encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
            + str(len(html)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + html
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    base = "http://127.0.0.1:" + str(server.sockets[0].getsockname()[1])

    # 仅将受控回环服务器映射成测试许可地址，不修改生产网络策略。
    async def validate(self, url):
        assert url.startswith(base)
        return url

    monkeypatch.setattr(NetworkPolicy, "validate", validate)
    actions = []
    original_collect = browser_module.collect_loaded

    # 记录实际操作数，不用函数调用与结果字符串替代浏览器行为。
    async def observed(page, html, **kwargs):
        await page.evaluate(
            '() => {window.scrollCalls=0;window.clickCalls=0;const old=window.scrollBy;window.scrollBy=(...a)=>{window.scrollCalls++;old(...a)};document.addEventListener("click",()=>window.clickCalls++)}'
        )
        capture = await original_collect(page, html, **kwargs)
        actions.append(
            await page.evaluate("({scroll:window.scrollCalls,click:window.clickCalls})")
        )
        return capture

    monkeypatch.setattr(browser_module, "collect_loaded", observed)
    async with async_playwright() as driver:
        monkeypatch.setattr(
            browser_module,
            "_find_chromium_executable",
            lambda: driver.chromium.executable_path,
        )
        provider = BuiltinParseFetchProvider(timeout=12)
        try:
            tutorial = await provider.fetch(base + "/tutorial")
            assert "ARTICLE" in tutorial.content
            assert "The requested page was not found" not in tutorial.content
            assert tutorial.engine == "chromium" and tutorial.fetch_status == "usable"
            from unisearch_test_plugin.fetch.builtin_parse import WebAPIError

            with pytest.raises(WebAPIError):
                await provider.fetch(base + "/challenge")
            rendered = await provider.fetch(base + "/route#/article")
            assert rendered.engine == "chromium" and "ARTICLE" in rendered.content
            assert rendered.fetch_status == "usable"
            assert actions == []
            expanded = await provider.fetch(base + "/expand")
            assert "EXPANDED" in expanded.content and expanded.fetch_status == "partial"
            assert actions == [{"scroll": 0, "click": 1}]
            # 同一真实页面的计算visibility覆盖必须进入返回正文。
            page = await provider._browser.render(
                base + "/restored", deadline_seconds=5
            )
            _, content, result, _ = provider._rendered_candidate(
                page, base + "/restored"
            )
            assert (
                "ARTICLE" in content.markdown
                and "HIDDEN_PARENT_TEXT" not in content.markdown
            )
            assert result.status == "usable"
        finally:
            await provider.aclose()
            server.close()
            await server.wait_closed()


# 明确不存在不启动浏览器；不能用额外引擎掩盖确定的HTTP结果。
@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 410])
async def test_definitive_http_error_does_not_render(status):
    import httpx
    from unisearch_test_plugin.fetch.builtin_parse import WebAPIError

    provider = BuiltinParseFetchProvider(timeout=2)
    response = httpx.Response(status, request=httpx.Request("GET", URL))
    provider._http.fetch = AsyncMock(
        side_effect=httpx.HTTPStatusError(
            "missing", request=response.request, response=response
        )
    )
    provider._browser.render = AsyncMock()
    with pytest.raises(WebAPIError):
        await provider.fetch(URL)
    assert provider._browser.render.await_count == 0


# 旧质量版本不复用，新可用结果正常缓存；未知回退保留正文但每次重新取页。
@pytest.mark.asyncio
@pytest.mark.parametrize("unknown", [False, True])
@pytest.mark.parametrize("old_version", ["v10", "v11"])
async def test_evidence_cache_rejects_old_success_and_partial(
    monkeypatch, tmp_path, unknown, old_version
):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from unisearch_test_plugin import cache
    from unisearch_test_plugin.fetch.providers import BuiltinParseProvider

    provider = BuiltinParseProvider(lambda key, default=None: default)
    token = set_hermes_home_override(tmp_path)
    cache.put(
        cache.identity(
            "builtin-quality-" + old_version, cache.identity(provider.name, "", "", URL)
        ),
        {
            "success": True,
            "data": {
                "url": URL,
                "content": "STALE_GATE",
                "fetch_status": "usable",
                "engine": "http",
                "reasons": [],
            },
        },
        provider._config,
    )
    html = (
        "<main>"
        + BODY
        + (
            '<p style="display:var(--missing)">UNCERTAIN</p>'
            if unknown
            else "<p hidden>The requested page was not found.</p>"
        )
        + "</main>"
    )
    parser = BuiltinParseFetchProvider(timeout=2)
    parser._http.fetch = AsyncMock(return_value=RawPage(html, URL, 200, {}))
    parser._browser.render = AsyncMock(side_effect=BrowserRenderError("offline"))

    # 仅worker传输替身；真实候选、状态校验和Profile缓存连续执行。
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
        first, second = (
            (await provider.extract([URL]))[0],
            (await provider.extract([URL]))[0],
        )
        assert first == second and "ARTICLE" in first["content"]
        assert (
            "STALE_GATE" not in first["content"] and "UNCERTAIN" not in first["content"]
        )
        assert first["fetch_status"] == ("partial" if unknown else "usable")
        assert provider._fetch.await_count == (2 if unknown else 1)
        if unknown:
            assert "visibility_unresolved" in first["reasons"]
            assert first["browser_followup"]["needed"]
    finally:
        reset_hermes_home_override(token)


# 只有未知正文不能回退成成功；until-found保留未展开限制，可见aria控件正常补抓。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "variant", ["unknown_only", "until_found", "aria_control", "css_gate"]
)
async def test_unresolved_reading_boundaries_require_evidence(variant):
    from unisearch_test_plugin.fetch.builtin_parse import WebAPIError

    pages = {
        "css_gate": '<title>Checking your browser</title><style>.hidden{display:none}</style><main><h1>Checking your browser</h1><p>Please wait while we verify that your connection is secure.</p><div class="hidden">'
        + BODY
        + "</div></main>",
        "unknown_only": '<main><p style="display:var(--x)">UNKNOWNBODY</p></main>',
        "until_found": "<main>"
        + BODY
        + '<section hidden="until-found">FOLDED</section></main>',
        "aria_control": "<main>"
        + BODY
        + '<button aria-hidden="true">Read more</button></main>',
    }
    parser = BuiltinParseFetchProvider(timeout=2)
    parser._http.fetch = AsyncMock(return_value=RawPage(pages[variant], URL, 200, {}))
    parser._browser.render = AsyncMock(side_effect=BrowserRenderError("offline"))
    if variant in {"unknown_only", "css_gate"}:
        with pytest.raises(WebAPIError):
            await parser.fetch(URL)
    else:
        result = await parser.fetch(URL)
        assert result.fetch_status == "partial"
        assert "interaction_required" in result.reasons
        assert "FOLDED" not in result.content
    assert parser._browser.render.await_count == 1


# 技术脚本只提供渲染线索，不能单独证明读者看到的是访问门槛。
def test_challenge_script_metadata_cannot_reject_a_readable_notice():
    html = '<main><p>NOTICE office closed today.</p></main><script src="/cdn-cgi/challenge-platform/widget.js"></script>'
    content = extract_content(html, URL)
    result = assess(
        RawPage(html, URL, 200, {}), content, requested_url=URL, engine="http"
    )
    assert result.status == "usable"
    assert "NOTICE" in content.markdown
