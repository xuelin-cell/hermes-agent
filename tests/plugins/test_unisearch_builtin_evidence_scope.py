"""Visibility scope must agree across static evidence, render sampling and reading hints."""

from pathlib import Path
from unittest.mock import AsyncMock
import pytest
from .test_unisearch import load_package

load_package()
from unisearch_test_plugin.fetch.builtin_parse import BuiltinParseFetchProvider  # noqa: E402
from unisearch_test_plugin.fetch.builtin.http import RawPage  # noqa: E402
from unisearch_test_plugin.fetch.builtin.browser import BrowserRenderError  # noqa: E402

BODY = "<p>ARTICLE explains application routing with enough information for the reader to understand how the implementation works.</p><p>The second paragraph gives practical instructions and detailed examples to help developers understand the protocol.</p>"
URL = "https://example.com/article"


# 是否升级由实际未知正文与可执行的阅读缺口决定，不由容器或无关控件决定。
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case,expected,render_calls",
    [
        ("restored", "usable", 0),
        ("hidden_root", "partial", 1),
        ("dialog", "usable", 0),
        ("outside_main", "usable", 0),
        ("outside_feed", "usable", 0),
        ("inert", "usable", 0),
        ("closed_dialog", "usable", 0),
        ("template", "usable", 0),
        ("hidden_input", "usable", 0),
    ],
)
async def test_static_evidence_scope_and_reading_deficits(case, expected, render_calls):
    pages = {
        "restored": '<main style="visibility:var(--state)"><article style="visibility:visible">'
        + BODY
        + "</article></main>",
        "hidden_root": "<main hidden></main><section>"
        + BODY
        + '<p style="display:var(--state)">UNKNOWNBODY</p></section>',
        "dialog": "<main>"
        + BODY
        + '<div role="dialog"><button>Read more</button></div></main>',
        "outside_main": "<header><button>Read more</button></header><main>"
        + BODY
        + "</main>",
        "outside_feed": "<main>"
        + BODY
        + '</main><section role="feed">Unrelated feed</section>',
        "inert": "<main>" + BODY + "<button inert>Read more</button></main>",
    }
    pages.update(
        {
            "closed_dialog": "<title>404 Not Found</title><main>"
            + BODY
            + "<dialog><p>The requested page was not found.</p></dialog></main>",
            "template": "<title>404 Not Found</title><main>"
            + BODY
            + "<template><p>The requested page was not found.</p></template></main>",
            "hidden_input": '<main><p>ARTICLE office closed today.</p><input type="hidden" name="cf-turnstile-response"></main>',
        }
    )
    provider = BuiltinParseFetchProvider(timeout=2)
    provider._http.fetch = AsyncMock(return_value=RawPage(pages[case], URL, 200, {}))
    provider._browser.render = AsyncMock(
        side_effect=BrowserRenderError("fixture unavailable")
    )
    result = await provider.fetch(URL)
    assert result.fetch_status == expected
    assert "ARTICLE" in result.content and "UNKNOWNBODY" not in result.content
    assert provider._browser.render.await_count == render_calls
    if case == "hidden_root":
        assert "visibility_unresolved" in result.reasons


# 真实计算样式与静态范围一致；隐藏root不能吞掉实际正文变化，旁栏折叠不造成补抓。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    ["hidden_root", "aux_folded", "outside_feed", "jquery_scroll", "native_hidden"],
)
async def test_computed_sampling_scope_matches_readable_content(monkeypatch, case):
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin.interaction import _READING_STATE

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            if case == "hidden_root":
                await page.set_content(
                    '<main hidden></main><section id="real">' + BODY + "</section>"
                )
                first = await page.evaluate(_READING_STATE)
                await page.locator("#real").evaluate(
                    'e=>e.insertAdjacentHTML("beforeend","<p>NEWCONTENT arrived and must be preserved.</p>")'
                )
                second = await page.evaluate(_READING_STATE, first["fingerprint"])
                assert second["fingerprint"] != first["fingerprint"]
                assert "NEWCONTENT" in second["html"]
            elif case == "outside_feed":
                await page.set_content(
                    "<main>"
                    + BODY
                    + '</main><section role="feed">Unrelated feed</section>'
                )
                state = await page.evaluate(_READING_STATE)
                assert not state["scroll"]
            elif case == "native_hidden":
                from unisearch_test_plugin.fetch.builtin.content import extract_content
                from unisearch_test_plugin.fetch.builtin.quality import assess
                from unisearch_test_plugin.fetch.builtin.evidence import PageEvidence

                html = (
                    "<title>404 Not Found</title><main>"
                    + BODY
                    + '<dialog><p>The requested page was not found.</p></dialog><input type="hidden" name="cf-turnstile-response"></main>'
                )
                await page.set_content(html)
                state = await page.evaluate(_READING_STATE)
                evidence = PageEvidence(
                    state["html"], "browser_computed", state["busy"]
                )
                content = extract_content(html, URL, evidence=evidence)
                assert (
                    assess(
                        RawPage(html, URL, 200, {}),
                        content,
                        requested_url=URL,
                        engine="chromium",
                    ).status
                    == "usable"
                )
                assert "was not found" not in content.markdown
            elif case == "jquery_scroll":
                from unisearch_test_plugin.fetch.builtin.interaction import (
                    collect_loaded,
                    interaction_hints,
                )

                html = (
                    "<main>"
                    + BODY
                    + '<div style="height:1500px"></div><section id="extra"></section></main><script>function $(obj){return {on:(event,cb)=>obj.addEventListener(event,cb)}};$(window).on("scroll",()=>{if(scrollY>700)document.querySelector("#extra").innerHTML="<p>SCROLLFOLLOWUP substantive content arrived beyond the initial region.</p>"})</script>'
                )
                assert "interaction_required" in interaction_hints(html)
                await page.set_content(html)
                capture = await collect_loaded(
                    page, html, budget_seconds=6, max_bytes=200000
                )
                from unisearch_test_plugin.fetch.builtin.content import extract_content

                assert any(
                    "SCROLLFOLLOWUP substantive"
                    in extract_content(e.html, URL, evidence=e).markdown
                    for e in capture.evidence
                )
                assert "interaction_scope_limited" in capture.reasons
            else:
                await page.set_content(
                    "<main>"
                    + BODY
                    + '<aside><div hidden="until-found">Auxiliary</div><div role="feed">Sidebar</div></aside></main>'
                )
                state = await page.evaluate(_READING_STATE)
                assert not state["folded"] and not state["scroll"]
        finally:
            await browser.close()


# 动态列表尚未到达时的“已经到底”不是完成，须先等待薄弱壳内容就绪再逐级滚动。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_delayed_scroll_shell_waits_before_declaring_bottom(monkeypatch):
    import asyncio
    from playwright.async_api import async_playwright
    from unisearch_test_plugin.fetch.builtin import browser as browser_module
    from unisearch_test_plugin.fetch.builtin.security import NetworkPolicy

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    html = (
        '<main id="body"><p>Preparing</p></main><script>function $(obj){return {on:(event,cb)=>obj.addEventListener(event,cb)}};setTimeout(()=>document.querySelector("main").innerHTML='
        + repr(
            BODY * 6 + '<div style="height:1500px"></div><section id="extra"></section>'
        )
        + ',600);$(window).on("scroll",()=>{if(scrollY>700)document.querySelector("#extra").innerHTML="<p>LATEFOLLOWUP arrived through a real scroll after the initial shell.</p>"})</script>'
    )

    # 仅响应本次隔离页面，实际HTTP/浏览器/候选流程保持。
    async def serve(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        body = html.encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    observed = []
    original_collect = browser_module.collect_loaded

    # 失败时保留真实DOM与采样，区分没加载、没采样及提取遗漏。
    async def collect(page, html, **kwargs):
        capture = await original_collect(page, html, **kwargs)
        from unisearch_test_plugin.fetch.builtin.content import extract_content

        observed.append(
            await page.evaluate(
                '({top:scrollY,extra:document.querySelector("#extra")?.textContent})'
            )
        )
        observed.extend(
            extract_content(e.html, URL, evidence=e).markdown for e in capture.evidence
        )
        return capture

    monkeypatch.setattr(browser_module, "collect_loaded", collect)
    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    base = "http://127.0.0.1:" + str(server.sockets[0].getsockname()[1])

    # 只给测试服务器许可，不改生产网络策略。
    async def validate(self, url):
        assert url.startswith(base)
        return url

    monkeypatch.setattr(NetworkPolicy, "validate", validate)
    async with async_playwright() as driver:
        monkeypatch.setattr(
            browser_module,
            "_find_chromium_executable",
            lambda: driver.chromium.executable_path,
        )
        provider = BuiltinParseFetchProvider(timeout=30)
        try:
            result = await provider.fetch(base + "/shell")
            assert "ARTICLE" in result.content and "LATEFOLLOWUP" in result.content, (
                observed
            )
            assert result.engine == "chromium" and result.fetch_status == "partial"
        finally:
            await provider.aclose()
            server.close()
            await server.wait_closed()
