from __future__ import annotations
from .test_unisearch import load_package

load_package()

from dataclasses import dataclass

import httpx
import pytest

from unisearch_test_plugin.fetch.builtin_parse import WebAPIError
from unisearch_test_plugin.fetch.builtin.browser import BrowserRenderError
from unisearch_test_plugin.fetch.builtin.http import RawPage
from unisearch_test_plugin.fetch.builtin_parse import BuiltinParseFetchProvider

_STATIC_HTML = """
<html><head><title>Static article</title></head><body><article>
<h1>Static article</h1><p>This is a substantial first paragraph containing useful article text for readers and extraction.</p>
<p>This is a second substantial paragraph with enough detail to pass the static content quality evaluation.</p>
</article></body></html>
"""
_SHELL_HTML = '<html><head><title>App</title></head><body><div id="root"></div><script src="app.js"></script></body></html>'
_RENDERED_HTML = """
<html><head><title>Rendered article</title></head><body><main>
<h1>Rendered article</h1><p>The browser rendered this dynamic article after client-side JavaScript completed loading.</p>
<p>The resulting DOM now contains a second useful paragraph that static HTTP could not observe.</p>
<a href="/rendered-next">Next rendered page</a>
</main></body></html>
"""


@dataclass
class _FakeHttpEngine:
    page: RawPage
    calls: int = 0

    # 返回夹具页面，验证真实Provider的静态优先行为。
    async def fetch(self, url: str) -> RawPage:
        del url
        self.calls += 1
        return self.page


@dataclass
class _FakeBrowserEngine:
    page: RawPage
    calls: int = 0
    error: BrowserRenderError | None = None

    # 记录浏览器补抓并按夹具返回页面或失败。
    async def render(self, url: str, *, deadline_seconds: float) -> RawPage:
        del url, deadline_seconds
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.page

    # 夹具不启动浏览器，关闭保持与真实引擎接口一致。
    async def aclose(self) -> None:
        return None


# 已有可读静态正文时不启动浏览器。
@pytest.mark.asyncio
async def test_provider_returns_static_content_without_starting_browser() -> None:
    provider = BuiltinParseFetchProvider(timeout=5)
    http_engine = _FakeHttpEngine(
        RawPage(_STATIC_HTML, "https://example.com/article", 200, {})
    )
    browser_engine = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/article", 200, {})
    )
    provider._http = http_engine
    provider._browser = browser_engine

    result = await provider.fetch("https://example.com/article")

    assert result.title == "Static article"
    assert "substantial first paragraph" in result.content
    assert http_engine.calls == 1
    assert browser_engine.calls == 0


# robots通过安全HTTP链路返回原文本。
@pytest.mark.asyncio
async def test_provider_fetches_robots_as_raw_static_text() -> None:
    provider = BuiltinParseFetchProvider(timeout=5)
    http_engine = _FakeHttpEngine(
        RawPage(
            "User-agent: *\nDisallow: /private",
            "https://example.com/robots.txt",
            200,
            {},
        )
    )
    browser_engine = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/robots.txt", 200, {})
    )
    provider._http = http_engine
    provider._browser = browser_engine

    content = await provider.fetch_robots_txt("https://example.com/robots.txt")

    assert "Disallow: /private" in content
    assert http_engine.calls == 1
    assert browser_engine.calls == 0


# 动态页面可由浏览器补回正文及最终链接。
@pytest.mark.asyncio
async def test_provider_uses_browser_for_client_rendered_shell() -> None:
    provider = BuiltinParseFetchProvider(timeout=5)
    http_engine = _FakeHttpEngine(
        RawPage(_SHELL_HTML, "https://example.com/app", 200, {})
    )
    browser_engine = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/app", 200, {})
    )
    provider._http = http_engine
    provider._browser = browser_engine

    result = await provider.fetch("https://example.com/app")

    assert result.title == "Rendered article"
    assert "browser rendered this dynamic article" in result.content.lower()
    assert result.links == ("https://example.com/rendered-next",)
    assert browser_engine.calls == 1


# 结果全文不应因片段拼接出现重叠重复。
@pytest.mark.asyncio
async def test_provider_returns_whole_content_without_overlap_duplication() -> None:
    provider = BuiltinParseFetchProvider(timeout=5)
    provider._http = _FakeHttpEngine(
        RawPage(_STATIC_HTML, "https://example.com/article", 200, {})
    )
    provider._browser = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/article", 200, {})
    )

    result = await provider.fetch("https://example.com/article")

    assert result.content.count("substantial first paragraph") == 1
    assert "\n\n---\n\n" not in result.content


# 浏览器失败但有可用静态正文时保留已有内容。
@pytest.mark.asyncio
async def test_provider_returns_static_content_when_browser_fallback_fails() -> None:
    provider = BuiltinParseFetchProvider(timeout=5)
    short_html = "<html><head><title>Short</title></head><body><main>Useful short static content.</main></body></html>"
    provider._http = _FakeHttpEngine(
        RawPage(short_html, "https://example.com/short", 200, {})
    )
    provider._browser = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/short", 200, {}),
        error=BrowserRenderError("Chromium unavailable"),
    )

    result = await provider.fetch("https://example.com/short")

    assert result.title == "Short"
    assert "Useful short static content" in result.content


# 静态网络错误可进入本机浏览器回退。
@pytest.mark.asyncio
async def test_provider_attempts_browser_after_static_network_error() -> None:
    class _FailingHttpEngine:
        # 当前策略与总预算内获取页面，安全拒绝不通过其他引擎绕行。
        async def fetch(self, url: str) -> RawPage:
            request = httpx.Request("GET", url)
            message = "connection refused"
            raise httpx.ConnectError(message, request=request)

    provider = BuiltinParseFetchProvider(timeout=5)
    browser = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/app", 200, {})
    )
    provider._http = _FailingHttpEngine()
    provider._browser = browser

    result = await provider.fetch("https://example.com/app")

    assert result.title == "Rendered article"
    assert browser.calls == 1


# 两个引擎均失败时明确报错，不生成虚假正文。
@pytest.mark.asyncio
async def test_provider_raises_when_static_and_browser_engines_fail() -> None:
    class _FailingHttpEngine:
        # 当前策略与总预算内获取页面，安全拒绝不通过其他引擎绕行。
        async def fetch(self, url: str) -> RawPage:
            request = httpx.Request("GET", url)
            message = "connection refused"
            raise httpx.ConnectError(message, request=request)

    provider = BuiltinParseFetchProvider(timeout=5)
    provider._http = _FailingHttpEngine()
    provider._browser = _FakeBrowserEngine(
        RawPage(_RENDERED_HTML, "https://example.com/app", 200, {}),
        error=BrowserRenderError("Chromium unavailable"),
    )

    with pytest.raises(WebAPIError, match="failed to extract readable content"):
        await provider.fetch("https://example.com/app")


def test_browser_resource_uses_native_resolver_only(monkeypatch, tmp_path):
    """原生解析器返回的明确资源可用；无选择时不再扫描旧目录或借用其他浏览器。"""
    from unisearch_test_plugin.fetch.builtin.browser import _find_chromium_executable
    import hermes_cli.browser_runtime as runtime

    executable = tmp_path / "native-chromium"
    executable.write_text("fixture", encoding="utf-8")
    monkeypatch.setattr(runtime, "chromium_executable", lambda: str(executable))
    assert _find_chromium_executable() == str(executable)
    monkeypatch.setattr(runtime, "chromium_executable", lambda: None)
    assert _find_chromium_executable() is None


@pytest.mark.asyncio
async def test_missing_native_browser_does_not_launch_implicit_playwright_cache(
    monkeypatch,
):
    """资源未准备时明确失败并释放driver，不让Playwright隐式选择另一份浏览器。"""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    import playwright.async_api
    import unisearch_test_plugin.fetch.builtin.browser as module

    driver = SimpleNamespace(
        chromium=SimpleNamespace(launch=AsyncMock()), stop=AsyncMock()
    )
    monkeypatch.setattr(
        playwright.async_api,
        "async_playwright",
        lambda: SimpleNamespace(start=AsyncMock(return_value=driver)),
    )
    monkeypatch.setattr(module, "_find_chromium_executable", lambda: None)
    engine = module.BrowserEngine(None)
    with pytest.raises(BrowserRenderError):
        await engine._get_browser()
    driver.chromium.launch.assert_not_called()
    driver.stop.assert_awaited_once()
