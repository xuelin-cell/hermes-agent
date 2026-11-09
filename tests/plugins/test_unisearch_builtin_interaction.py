"""Bounded reading through real HTTP/Chromium, without a user's browser or account."""

import asyncio
from collections import Counter
from pathlib import Path

import pytest

from .test_unisearch import load_package

load_package()
from unisearch_test_plugin.fetch.builtin_parse import (
    BuiltinParseFetchProvider,
    WebAPIError,
)
from unisearch_test_plugin.fetch.builtin import browser
from unisearch_test_plugin.fetch.builtin.security import NetworkPolicy
from unisearch_test_plugin.fetch.status import result_status


# 真浏览器验证滚动、展开、虚拟列表累积、上限及写请求/表单边界，不用DOM替身。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_bounded_reading_retains_content_and_reports_remaining_work(monkeypatch):
    from playwright.async_api import async_playwright

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        executable = driver.chromium.executable_path
    if not Path(executable).is_file():
        pytest.skip("Installed Chromium fixture required")
    monkeypatch.setattr(browser, "_find_chromium_executable", lambda: executable)
    calls = Counter()
    paragraph = (
        "This page contains useful information and a detailed reading example for testing. "
        * 4
    )
    pages = {
        "/expand": f"""<main><h1>Guide</h1><p>INITIAL {paragraph}</p><button type="button" onclick="document.querySelector('#extra').innerHTML='<p>EXPANDED details are now available.</p>';this.remove()">展开全文</button><section id="extra"></section></main>""",
        "/virtual": f"""<main><h1>Reviews</h1><section role="feed"><p>FIRSTREVIEW {paragraph}</p></section><button type="button" onclick="document.querySelector('[role=feed]').innerHTML='<p>LASTREVIEW is new content replacing the first review in the DOM.</p>';this.remove()">加载更多</button></main>""",
        "/scroll": f"""<main role="feed"><h1>Comments</h1><p>FIRSTSCROLL {paragraph}</p><div style="height:800px"></div></main><script>let done=false;addEventListener('scroll',()=>{{if(!done && scrollY>200){{done=true;document.querySelector('main').insertAdjacentHTML('beforeend','<p>SCROLLEDREVIEW appeared after a real scroll event.</p>')}}}})</script>""",
        "/pages": f"""<main><h1>Series</h1><p>PAGEONE {paragraph}</p><a rel="next" href="/page-two">下一页</a></main>""",
        "/endless": f"""<main><h1>Comments</h1><p>ENDLESS {paragraph}</p><section id="rows"></section><button type="button" onclick="this.dataset.n=Number(this.dataset.n||0)+1;document.querySelector('#rows').insertAdjacentHTML('beforeend','<p>ROW'+this.dataset.n+' fresh comment content.</p>')">加载更多</button></main>""",
        "/post": f"""<main><h1>Post barrier</h1><p>POSTBASE {paragraph}</p><button type="button" onclick="fetch('/write',{{method:'POST',body:'not allowed'}}).catch(()=>{{}})">加载更多</button></main>""",
        "/navigate": f"""<main><h1>Reading boundary</h1><p>NAVBASE {paragraph}</p><button type="button" onclick="location.href='/page-two'">Load more</button></main>""",
        "/unsafe": f"""<main><h1>Reading boundary</h1><p>UNSAFEBASE {paragraph}</p><button type="button" onclick="location.href='http://127.0.0.1:1/forbidden'">Load more</button></main>""",
        "/form": f"""<main><h1>Form boundary</h1><p>FORMBASE {paragraph}</p><form action="/write" method="POST"><button>加载更多</button><input name="secret" value="fixture"></form><div data-infinite-scroll></div></main>""",
    }

    # 只接本机合成页，记录是否发生意外翻页/提交。
    async def serve(reader, writer):
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            method, path = request.split(b" ")[:2]
            path = path.decode()
            calls[(method.decode(), path)] += 1
            body = pages.get(path, "<main>UNEXPECTED TARGET</main>").encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    origin = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    original = NetworkPolicy.validate

    # 仅给当前受控端口开测试映射，其余地址仍走生产策略。
    async def validate(self, url):
        if url.startswith(origin + "/"):
            return url
        return await original(self, url)

    monkeypatch.setattr(NetworkPolicy, "validate", validate)
    provider = BuiltinParseFetchProvider(timeout=30)
    try:
        results = {}
        for path in pages:
            if path == "/unsafe":
                with pytest.raises(WebAPIError) as blocked:
                    await provider.fetch(origin + path)
                assert blocked.value.reason == "policy_blocked"
                continue
            row = await provider.fetch(origin + path)
            results[path] = row
            assert row.fetch_status == "partial", (path, row)
            wire = result_status({
                "content": row.content,
                "fetch_status": row.fetch_status,
                "reasons": row.reasons,
                "engine": row.engine,
            })
            assert wire["browser_followup"]["needed"] is True
        assert "EXPANDED" in results["/expand"].content
        assert (
            "FIRSTREVIEW" in results["/virtual"].content
            and "LASTREVIEW" in results["/virtual"].content
        )
        assert "SCROLLEDREVIEW" in results["/scroll"].content
        assert (
            results["/pages"].engine == "http"
            and "pagination_remaining" in results["/pages"].reasons
        )
        assert (
            "ROW4" in results["/endless"].content
            and "ROW5" not in results["/endless"].content
        )
        assert "interaction_limit" in results["/endless"].reasons
        assert "interaction_blocked" in results["/post"].reasons
        assert "interaction_blocked" in results["/navigate"].reasons
        assert not calls[("POST", "/write")] and not calls[("GET", "/page-two")]
        assert all("UNEXPECTED TARGET" not in row.content for row in results.values())
    finally:
        await provider.aclose()
        server.close()
        await server.wait_closed()


# 已完成采样不因局部交互到期丢失，显式取消继续传播给外层回收。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_interaction_deadline_preserves_samples_and_cancel_propagates(
    monkeypatch,
):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import collect_loaded

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    html = """<main><p>INITIAL reading content.</p><section id="extra"></section><button type="button" onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#extra').innerHTML='<p>SAVED before the remaining interaction timed out.</p>'">Load more</button></main>"""
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        chromium = await driver.chromium.launch(headless=True)
        try:
            context = await chromium.new_context()
            page = await context.new_page()
            await page.set_content(html)
            captured = await collect_loaded(
                page, await page.content(), budget_seconds=2, max_bytes=100000
            )
            assert len(captured.snapshots) > 1
            assert any(
                "SAVED" in item and "<p>SAVED" in item for item in captured.snapshots
            )
            assert "interaction_timeout" in captured.reasons
            await page.set_content(html)
            await page.evaluate("window.clicks=0")
            task = asyncio.create_task(
                collect_loaded(
                    page, await page.content(), budget_seconds=10, max_bytes=100000
                )
            )
            await page.wait_for_function("window.clicks >= 2")
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await context.close()
            assert not chromium.contexts
        finally:
            await chromium.close()


# 实际DOM文字相同但链接换项也要保存；加载状态变化不能触发重叠点击。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["href", "busy", "stuck", "decorative"])
async def test_reading_progress_uses_item_identity_and_waits_for_completion(
    monkeypatch, case
):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import collect_loaded
    from unisearch_test_plugin.fetch.builtin.links import extract_links

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    pages = {
        "href": """<main><p>Products currently available for reading.</p><a id="item" href="https://example.com/item-a">View details</a><button type="button" onclick="document.querySelector('#item').href='https://example.com/item-b'">Load more</button></main>""",
        "busy": """<main><p>Initial comments.</p><section id="items"></section><span id="status" role="status">Ready</span><button id="more" type="button" onclick="window.calls=(window.calls||0)+1;if(this.getAttribute('aria-busy')==='true')window.overlap=true;this.setAttribute('aria-busy','true');document.querySelector('#status').textContent='Loading...';setTimeout(()=>{document.querySelector('#items').insertAdjacentHTML('beforeend','<p>LOADED_CONTENT complete article row '+window.calls+'.</p>');document.querySelector('#status').textContent='Ready';this.setAttribute('aria-busy','false');if(window.calls===2)this.remove()},600)">Load more</button></main>""",
        "stuck": """<main><p>SAVED initial useful content.</p><button type="button" onclick="window.calls=(window.calls||0)+1;this.setAttribute('aria-busy','true')">Load more</button></main>""",
        "decorative": """<main><p>Unchanged article.</p><button type="button" onclick="window.calls=(window.calls||0)+1;document.querySelector('aside').textContent='Clock '+Date.now()">Load more</button></main><aside>Clock</aside>""",
    }
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        chromium = await driver.chromium.launch(headless=True)
        try:
            page = await chromium.new_page()
            await page.set_content(pages[case])
            capture = await collect_loaded(
                page, await page.content(), budget_seconds=6, max_bytes=100000
            )
            if case == "href":
                links = {
                    u
                    for html in capture.snapshots
                    for u in extract_links(html, "https://example.com/")
                }
                assert {
                    "https://example.com/item-a",
                    "https://example.com/item-b",
                } <= links
            elif case == "busy":
                assert await page.evaluate("window.calls") == 2
                assert not await page.evaluate("!!window.overlap")
                assert any(
                    "LOADED_CONTENT complete article row 2" in html
                    for html in capture.snapshots
                )
            else:
                assert await page.evaluate("window.calls") == 1
                assert len(capture.snapshots) == 1
                if case == "stuck":
                    assert "interaction_timeout" in capture.reasons
        finally:
            await chromium.close()


# 滚过已加载区域也能继续推进；到达底部或不能位移时停止，不伪造加载超时。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["threshold", "bottom", "no_movement"])
async def test_scroll_progress_is_not_gated_on_new_text(monkeypatch, case):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import collect_loaded

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    html = """<main role="feed"><p>INITIAL available content.</p><div style="height:2300px"></div><section id="extra"></section></main><script>window.moves=0;const scroll=window.scrollBy;window.scrollBy=(...args)=>{window.moves++;scroll(...args)};window.loaded=false;addEventListener('scroll',()=>{if(!window.loaded && scrollY>1000){window.loaded=true;document.querySelector('#extra').innerHTML='<p>LATERCONTENT reached after crossing old content.</p>'}})</script>"""
    if case != "threshold":
        html = html.replace("scrollY>1000", "false")
    if case == "no_movement":
        html += "<script>window.scrollBy=()=>{window.moves++}</script>"
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page(viewport={"width": 1000, "height": 700})
            await page.set_content(html)
            capture = await collect_loaded(
                page, await page.content(), budget_seconds=8, max_bytes=200000
            )
            if case == "threshold":
                from unisearch_test_plugin.fetch.builtin.http import RawPage

                raw = RawPage(
                    capture.snapshots[-1],
                    "https://example.com/scroll",
                    200,
                    {},
                    snapshots=capture.snapshots,
                    interaction_reasons=capture.reasons,
                )
                _, content, _, _ = BuiltinParseFetchProvider()._rendered_candidate(
                    raw, raw.url
                )
                assert "LATERCONTENT" in content.markdown
            elif case == "bottom":
                assert await page.evaluate(
                    "scrollY + innerHeight >= document.scrollingElement.scrollHeight - 2"
                )
            else:
                assert await page.evaluate("scrollY") == 0
                assert await page.evaluate("window.moves") == 1
            assert "interaction_timeout" not in capture.reasons
            assert await page.evaluate("window.moves") <= 4
        finally:
            await browser.close()


# 初始busy须等待，等待中取得的内容到期仍保留；取消必须向外传播。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["finish", "stuck", "cancel"])
@pytest.mark.parametrize("container", ["main", "parent"])
async def test_initial_loading_waits_and_preserves_progress(
    monkeypatch, case, container
):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import collect_loaded

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            content = (
                '<main><p>INITIAL content.</p><section id="extra"></section></main>'
            )
            await page.set_content(
                content.replace("<main>", '<main aria-busy="true">')
                if container == "main"
                else '<div aria-busy="true">' + content + "</div>"
            )
            await page.evaluate(
                "setTimeout(()=>{document.querySelector('#extra').innerHTML='<p>ARRIVED_DURING_WAIT valid content.</p>';window.ready=true},300)"
            )
            if case == "finish":
                await page.evaluate(
                    "setTimeout(()=>document.querySelector('[aria-busy]').setAttribute('aria-busy','false'),500)"
                )
            task = asyncio.create_task(
                collect_loaded(
                    page,
                    await page.content(),
                    budget_seconds=1.5 if case == "stuck" else 6,
                    max_bytes=200000,
                )
            )
            if case == "cancel":
                await page.wait_for_function("window.ready")
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                capture = await task
                assert any(
                    "<p>ARRIVED_DURING_WAIT" in html for html in capture.snapshots
                )
                assert ("interaction_timeout" in capture.reasons) == (case == "stuck")
        finally:
            await browser.close()


# 同一HTML的静态与实际浏览器加载判定保持一致，引用/隐藏/兄弟区域不制造加载状态。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "hidden",
        "inline_hidden",
        "aria_hidden",
        "quote",
        "code",
        "sidebar",
        "outside",
        "main",
        "parent",
        "body",
        "plain_text",
        "status",
        "progress",
        "false",
        "hidden_parent",
        "display_contents",
    ],
)
async def test_loading_scope_agrees_between_static_and_browser(monkeypatch, case):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import (
        _READING_STATE,
        collect_loaded,
    )
    from unisearch_test_plugin.fetch.builtin.quality import assess
    from unisearch_test_plugin.fetch.builtin.content import extract_content
    from unisearch_test_plugin.fetch.builtin.http import RawPage

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    body = "<p>ARTICLE readable information with useful details for readers who need a complete description of this topic.</p><p>This guide provides another substantial paragraph with clear instructions and stable information.</p>"
    loading = '<span aria-busy="true">Loading...</span>'
    snippets = {
        "hidden": "<section hidden>" + loading + "</section>",
        "inline_hidden": '<section style="display:none !important">'
        + loading
        + "</section>",
        "aria_hidden": '<section aria-hidden="true">' + loading + "</section>",
        "quote": '<blockquote><p aria-busy="true">Loading...</p></blockquote>',
        "code": '<p><code aria-busy="true">Loading...</code> is example text.</p>',
        "sidebar": "<aside>" + loading + "</aside>",
        "plain_text": "<div>Loading...</div>",
        "status": '<div role="status">Loading...</div>',
        "progress": '<div role="progressbar"></div>',
    }
    html = (
        "<main"
        + (' aria-busy="true"' if case == "main" else "")
        + ">"
        + body
        + snippets.get(case, "")
        + "</main>"
    )
    if case in {"parent", "false", "hidden_parent", "display_contents"}:
        attrs = ' aria-busy="' + ("false" if case == "false" else "true") + '"'
        attrs += (
            " hidden"
            if case == "hidden_parent"
            else ' style="display:contents"'
            if case == "display_contents"
            else ""
        )
        html = "<div" + attrs + ">" + html + "</div>"
    if case == "body":
        html = '<body aria-busy="true">' + html + "</body>"
    if case == "outside":
        html += '<div aria-busy="true">Loading...</div>'
    expected = case in {
        "main",
        "parent",
        "body",
        "plain_text",
        "status",
        "progress",
        "display_contents",
        "aria_hidden",
    }
    url = "https://example.com/loading"
    raw = RawPage(html, url, 200, {})
    assessment = assess(
        raw, extract_content(html, url), requested_url=url, engine="http"
    )
    assert ("dynamic_content_pending" in assessment.reasons) == expected
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            state = await page.evaluate(_READING_STATE)
            assert state["busy"] == expected
            if not expected:
                capture = await collect_loaded(
                    page, await page.content(), budget_seconds=2.5, max_bytes=200000
                )
                assert "interaction_timeout" not in capture.reasons
        finally:
            await browser.close()


# 普通正文按完整语境判断；真实独立提示和显式状态仍保持加载语义。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "strong_prose",
        "heading",
        "direct_prose",
        "split_spinner",
        "standalone",
        "explicit_status",
        "inline_spinner",
        "inline_prose_after_block",
        "inline_split_spinner",
        "bare_spinner",
        "bare_prose",
    ],
)
async def test_loading_text_uses_context_in_both_engines(monkeypatch, case):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.loading import has_loading_content
    from unisearch_test_plugin.fetch.builtin.interaction import _READING_STATE
    from bs4 import BeautifulSoup

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    snippets = {
        "strong_prose": "<p><strong>Loading</strong> is the first phase, followed by decoding and rendering.</p>",
        "heading": "<h2>Loading</h2><p>This section describes how to load a module.</p>",
        "direct_prose": "<strong>Loading</strong> is a term used in this guide.",
        "split_spinner": "<div><span>Load</span><strong>ing</strong>...</div>",
        "standalone": "<div><strong>Loading...</strong></div>",
        "explicit_status": '<h2 role="status">Loading...</h2>',
        "inline_spinner": "<span>Loading...</span>",
        "inline_prose_after_block": "<span>Loading</span> is the first phase of this guide.",
        "inline_split_spinner": "<span>Load</span><strong>ing</strong>...",
        "bare_spinner": "Loading...",
        "bare_prose": "Loading is the first phase of this guide.",
    }
    html = (
        "<main><p>Readable article with complete information.</p>"
        + snippets[case]
        + "</main>"
    )
    expected = case in {
        "split_spinner",
        "standalone",
        "explicit_status",
        "inline_spinner",
        "inline_split_spinner",
        "bare_spinner",
    }
    assert has_loading_content(BeautifulSoup(html, "lxml")) == expected
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            assert (await page.evaluate(_READING_STATE))["busy"] == expected
        finally:
            await browser.close()


# CSS覆盖按实际结果等待；静态解析识别简单行内顺序，浏览器允许样式表/可见性继承的覆盖。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "shown",
        "hidden",
        "important_hidden",
        "important_shown",
        "visible_child",
        "hidden_attribute",
        "aria_hidden",
        "stylesheet",
    ],
)
async def test_loading_visibility_respects_css_result(monkeypatch, case):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.loading import has_loading_content
    from unisearch_test_plugin.fetch.builtin.interaction import (
        _READING_STATE,
        collect_loaded,
    )
    from bs4 import BeautifulSoup

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    styles = {
        "shown": "display:none;display:block",
        "hidden": "display:block;display:none",
        "important_hidden": "display:none!important;display:block",
        "important_shown": "display:none;display:block!important",
        "visible_child": "visibility:visible",
        "stylesheet": "display:none",
    }
    attrs = (
        " hidden"
        if case == "hidden_attribute"
        else ' aria-hidden="true"'
        if case == "aria_hidden"
        else ""
    )
    html = (
        '<main id="target" aria-busy="true" style="'
        + styles.get(case, "")
        + '"'
        + attrs
        + '><p>INITIAL readable body.</p><section id="extra"></section></main>'
    )
    if case == "visible_child":
        html = '<div style="visibility:hidden">' + html + "</div>"
    if case == "stylesheet":
        html += "<style>#target{display:block!important}</style>"
    expected = case in {"shown", "important_shown", "visible_child", "stylesheet", "aria_hidden"}
    assert has_loading_content(BeautifulSoup(html, "lxml")) == (
        expected and case != "stylesheet"
    )
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            assert (await page.evaluate(_READING_STATE))["busy"] == expected
            if expected:
                await page.evaluate(
                    "setTimeout(()=>{document.querySelector('#extra').innerHTML='<p>LATERBODY arrived.</p>';document.querySelector('#target').setAttribute('aria-busy','false')},400)"
                )
                capture = await collect_loaded(
                    page, await page.content(), budget_seconds=4, max_bytes=200000
                )
                assert any("<p>LATERBODY" in item for item in capture.snapshots)
                assert "interaction_timeout" not in capture.reasons
        finally:
            await browser.close()


# 隐藏噪声不改可见语境；可见引用/换行仍属于句子，真实提示继续等待后续正文。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "snippet,expected",
    [
        (
            '<div id="state"><span>Loading...</span><span hidden>Noise</span></div>',
            True,
        ),
        (
            '<div id="state"><span hidden>Noise</span><span>Loading...</span></div>',
            True,
        ),
        (
            '<div id="state">Loading...<span style="display:none">Noise</span></div>',
            True,
        ),
        (
            '<div id="state">Loading...<span style="visibility:hidden">Noise</span></div>',
            True,
        ),
        ('<div id="state">Loading...<span aria-hidden="true">Noise</span></div>', False),
        (
            '<div id="state"><span>Loading...<b hidden>Nested noise</b></span></div>',
            True,
        ),
        (
            '<div id="state">Load<span hidden>Noise</span><strong>ing</strong>...</div>',
            True,
        ),
        ('<div id="state">Loading...<template>Noise</template></div>', True),
        (
            '<div id="state">Loading...<script type="application/json">{"state":"noise"}</script></div>',
            True,
        ),
        ('<div id="state">Loading...<style>.decoration{color:red}</style></div>', True),
        (
            '<div id="state" style="visibility:hidden"><span style="visibility:visible">Loading...</span></div>',
            True,
        ),
        ('<p id="state">Loading<br> is the first step in this guide.</p>', False),
        ('<p id="state">Loading<code> is a term used here.</code></p>', False),
        ('<p id="state">Loading<q> is a quoted term here.</q></p>', False),
        (
            '<div id="state">Loading<div hidden>Hidden block</div> is a term used here.</div>',
            False,
        ),
        (
            '<div id="state"><span>Loading</span><span hidden>Noise</span> is a term used here.</div>',
            False,
        ),
        (
            '<div id="state"><span hidden>Loading...</span>Complete article.</div>',
            False,
        ),
        ('<div id="state">Loading...<br></div>', True),
        ('<div id="state">Load<br>ing</div>', False),
    ],
)
async def test_loading_context_uses_only_visible_reading_text(
    monkeypatch, snippet, expected
):
    from bs4 import BeautifulSoup
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.loading import has_loading_content
    from unisearch_test_plugin.fetch.builtin.interaction import (
        _READING_STATE,
        collect_loaded,
    )

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    html = (
        "<main><p>Readable article with useful information already available.</p>"
        + snippet
        + '<section id="extra"></section></main>'
    )
    assert has_loading_content(BeautifulSoup(html, "lxml")) == expected
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            assert (await page.evaluate(_READING_STATE))["busy"] == expected
            if expected:
                await page.evaluate(
                    "setTimeout(()=>{document.querySelector('#state').remove();document.querySelector('#extra').innerHTML='<p>AFTERLOAD new readable content.</p>'},400)"
                )
            capture = await collect_loaded(
                page, await page.content(), budget_seconds=4, max_bytes=200000
            )
            assert "interaction_timeout" not in capture.reasons
            if expected:
                assert any("<p>AFTERLOAD" in item for item in capture.snapshots)
        finally:
            await browser.close()


# 非法声明不能覆盖有效值；优先级、合法多值及其他属性中的分号必须保持各自语义。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "style,expected",
    [
        ("display:none;display:", False),
        ("display:none;display:bogus", False),
        ("display:none;display:bogus!important", False),
        ("visibility:hidden;visibility:", False),
        ("visibility:hidden;visibility:bogus", False),
        ("visibility:hidden;visibility:bogus!important", False),
        ("display:none!important;display:block", False),
        ("display:none;display:inline flex", True),
        ("display:none;display:block!important;display:bogus!important", True),
        ("display:none;display:no/**/ne", False),
        ("display:block;display:no/**/ne", True),
        ("--note:';display:none;';display:block", True),
        ("display:block;--note:';display:none;'", True),
    ],
)
async def test_invalid_inline_style_does_not_change_loading_state(
    monkeypatch, style, expected
):
    from bs4 import BeautifulSoup
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.loading import has_loading_content
    from unisearch_test_plugin.fetch.builtin.interaction import _READING_STATE

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    html = (
        '<main><p>Complete readable article with sufficient information.</p><div aria-busy="true" style="'
        + style
        + '">Loading...</div></main>'
    )
    assert has_loading_content(BeautifulSoup(html, "lxml")) == expected
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            assert (await page.evaluate(_READING_STATE))["busy"] == expected
        finally:
            await browser.close()


# 已支持值、未知扩展及转义写法不能错误沿用旧隐藏值；确定非法声明仍应忽略。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "style,static_busy,browser_busy",
    [
        ("display:none;display:-webkit-box", True, True),
        ("display:none;display:-webkit-inline-box!important", True, True),
        (r"display:none;display:\62 lock", True, True),
        ("display:none;display:-future-layout", True, False),
        ("display:none!important;display:-future-layout", False, False),
        ("display:none;display:-future-layout;display:none", False, False),
        ("display:none;display:bogus", False, False),
    ],
)
async def test_unresolved_display_does_not_confirm_hidden(
    monkeypatch, style, static_busy, browser_busy
):
    from bs4 import BeautifulSoup
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.loading import has_loading_content
    from unisearch_test_plugin.fetch.builtin.interaction import _READING_STATE

    html = (
        '<main><p>Useful article body.</p><div aria-busy="true" style="'
        + style
        + '">Loading...</div></main>'
    )
    assert has_loading_content(BeautifulSoup(html, "lxml")) == static_busy
    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            assert (await page.evaluate(_READING_STATE))["busy"] == browser_busy
        finally:
            await browser.close()


# 工作量随文字节点数增长；每次DOM采样重建缓存，隐藏文字与动态变化仍正确。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_loading_context_work_scales_and_refreshes(monkeypatch):
    from bs4 import BeautifulSoup
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin import loading
    from unisearch_test_plugin.fetch.builtin.interaction import _READING_STATE

    calls = 0
    from unisearch_test_plugin.fetch.builtin import visibility
    original = visibility._inline_visibility

    # 统计实际样式解释工作量，不依赖机器速度或源码形状。
    def counted(style):
        nonlocal calls
        calls += 1
        return original(style)

    monkeypatch.setattr(visibility, "_inline_visibility", counted)
    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    static_counts, browser_counts = [], []
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.evaluate("""() => {
                window.cssCalls = 0;
                const original = window.getComputedStyle;
                window.getComputedStyle = e => {window.cssCalls++; return original(e);};
            }""")
            for size in (100, 200, 400):
                html = (
                    '<main><p id="body">'
                    + "<span>Ordinary article text with useful details. </span>" * size
                    + '</p><p id="state"><span hidden>Decoration</span><span id="label">Complete</span></p></main>'
                )
                soup = BeautifulSoup(html, "lxml")
                calls = 0
                assert not loading.has_loading_content(soup)
                static_counts.append(calls)
                soup.select_one("#label").string = "Loading..."
                assert loading.has_loading_content(soup)
                soup.select_one("#label")["hidden"] = ""
                assert not loading.has_loading_content(soup)
                await page.set_content(html)
                await page.evaluate("window.cssCalls = 0")
                assert not (await page.evaluate(_READING_STATE))["busy"]
                browser_counts.append(await page.evaluate("window.cssCalls"))
                await page.locator("#label").evaluate(
                    "e => e.textContent = 'Loading...'"
                )
                assert (await page.evaluate(_READING_STATE))["busy"]
                await page.locator("#label").evaluate("e => e.hidden = true")
                assert not (await page.evaluate(_READING_STATE))["busy"]
            for counts in (static_counts, browser_counts):
                assert counts[0] > 0
                assert counts[1] <= counts[0] * 3
                assert counts[2] <= counts[1] * 3
        finally:
            await browser.close()


# 未知文字不能证实普通正文、吞掉加载提示；确定隐藏和确定可见仍保留原语义。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "snippet,static_pending,browser_busy",
    [
        (
            '<span>Loading...</span><span style="display:none;display:-moz-box">Noise</span>',
            True,
            True,
        ),
        (
            '<span>Loading...</span><span style="display:none;display:-moz-box!important">Noise</span>',
            True,
            True,
        ),
        (
            '<span>Loading...</span><span style="visibility:hidden;visibility:-unknown">Noise</span>',
            True,
            True,
        ),
        (
            '<span style="display:none;display:-moz-box">Noise</span><span>Loading...</span>',
            True,
            True,
        ),
        (
            '<span>Loading...<b style="display:none;display:-moz-box">Noise</b></span>',
            True,
            True,
        ),
        (
            '<span>Loading...</span><span style="display:none;display:-webkit-box"> is a term.</span>',
            True,
            False,
        ),
        (
            '<span>Loading...</span><span style="display:block"> is a term.</span>',
            False,
            False,
        ),
        (
            '<span>Loading...</span><span style="display:none!important;display:-moz-box">Noise</span>',
            True,
            True,
        ),
        (
            '<span style="display:none">Loading...</span><span>Complete</span>',
            False,
            False,
        ),
        (
            '<span style="display:none;display:-moz-box">Loading...</span><span>Complete</span>',
            True,
            False,
        ),
        (
            '<span style="display:none;display:-moz-box">Load</span><span>ing...</span>',
            True,
            False,
        ),
        (
            'Loading...<div style="display:none;display:-moz-box"></div> is a term.',
            True,
            False,
        ),
        (
            '<span style="visibility:hidden;visibility:-unknown"><b style="visibility:visible">Complete</b></span>',
            False,
            False,
        ),
        (
            '<span hidden style="display:-moz-box">Loading...</span>Complete',
            True,
            False,
        ),
        ('Complete<button style="display:-moz-box">Loading...</button>', False, False),
    ],
)
async def test_unknown_visibility_remains_uncertain_in_reading_context(
    monkeypatch, snippet, static_pending, browser_busy
):
    from bs4 import BeautifulSoup
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.loading import has_loading_content
    from unisearch_test_plugin.fetch.builtin.interaction import _READING_STATE

    html = (
        '<main><p>Useful article content.</p><section id="state">'
        + snippet
        + "</section></main>"
    )
    soup = BeautifulSoup(html, "lxml")
    assert has_loading_content(soup) == static_pending
    # 同一个树变化后不沿用不确定性，缓存生命周期只能是一次评估。
    soup.select_one("#state").clear()
    soup.select_one("#state").string = "Complete article."
    assert not has_loading_content(soup)
    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        if not Path(driver.chromium.executable_path).is_file():
            pytest.skip("Installed Chromium fixture required")
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html)
            assert (await page.evaluate(_READING_STATE))["busy"] == browser_busy
            await page.locator("#state").evaluate(
                "e => e.textContent = 'Complete article.'"
            )
            assert not (await page.evaluate(_READING_STATE))["busy"]
        finally:
            await browser.close()
