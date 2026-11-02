"""Built-in web fetch provider with static HTTP and dynamic browser fallback.

The implementation is self-contained in HexAgent.  It follows an engine
waterfall similar to mature crawler designs, but does not call or embed the
AGPL-licensed Firecrawl service or source code.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import httpx


class WebAPIError(RuntimeError):
    """A fetch failed without usable content."""


from .base import FetchResult
from .builtin import (
    BrowserEngine,
    BrowserRenderError,
    ExtractedContent,
    HttpEngine,
    NetworkPolicy,
    RawPage,
    URLSecurityError,
    extract_content,
    extract_links,
    needs_browser,
)

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024


class BuiltinParseFetchProvider:
    """Fetch readable web content without an external crawling service.

    Static HTTP is attempted first. Pages that look incomplete, client-rendered
    or challenged are retried in the locally installed Playwright Chromium.
    Initial URLs, redirects and browser subresources all pass through the same
    DNS-aware SSRF policy.
    """

    name: str = "builtin_parse"

    # 两个引擎共用安全策略与总预算，避免回退重置限制。
    def __init__(
        self,
        api_key: str | None = None,  # noqa: ARG002
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        is_need_markdown: bool = False,  # noqa: ARG002
        client: httpx.AsyncClient | None = None,
        allowed_hosts: Iterable[str] | None = None,
        blocked_hosts: Iterable[str] | None = None,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        browser_concurrency: int = 2,
    ) -> None:
        """Initialize the built-in provider.

        Args:
            api_key: Ignored; the built-in provider needs no API key.
            timeout: Total fetch deadline in seconds.
            is_need_markdown: Retained for caller compatibility. Output is now
                consistently Markdown regardless of this value.
            client: Optional HTTPX client, primarily for custom transports/tests.
            allowed_hosts: Optional domain allowlist. Entries include subdomains.
                If omitted, public hosts are allowed.
            blocked_hosts: Additional denied domains. Defaults to none.
            max_response_bytes: Maximum decompressed static response size.
            browser_concurrency: Maximum simultaneous browser render contexts.
        """
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        if browser_concurrency <= 0:
            raise ValueError("browser_concurrency must be positive")

        self._timeout = timeout
        policy = NetworkPolicy(
            allowed_hosts=tuple(allowed_hosts or ()),
            blocked_hosts=tuple(blocked_hosts or ()),
        )
        self._http = HttpEngine(
            policy,
            timeout=timeout,
            max_response_bytes=max_response_bytes,
            client=client,
        )
        self._browser = BrowserEngine(
            policy,
            concurrency=browser_concurrency,
            max_response_bytes=max_response_bytes,
        )

    # 当前策略与总预算内获取页面，安全拒绝不通过其他引擎绕行。
    async def fetch(self, url: str) -> FetchResult:
        """Fetch a URL and return extracted Markdown content.

        Raises:
            WebAPIError: If the URL is unsafe or neither engine can extract
                readable content before the deadline.
        """
        started = asyncio.get_running_loop().time()
        static_page: RawPage | None = None
        static_content: ExtractedContent | None = None
        static_error: Exception | None = None

        try:
            async with asyncio.timeout(self._timeout):
                try:
                    static_page = await self._http.fetch(url)
                    static_content = extract_content(static_page.html, static_page.url)
                    if static_content.markdown and not needs_browser(
                        static_page.html, static_content
                    ):
                        return self._result(static_page, static_content)
                except URLSecurityError:
                    raise
                except (httpx.HTTPError, UnicodeError, ValueError) as exc:
                    static_error = exc
                    logger.info(
                        "Static fetch failed for %s; trying browser: %s", url, exc
                    )

                remaining = max(
                    1.0, self._timeout - (asyncio.get_running_loop().time() - started)
                )
                try:
                    browser_page = await self._browser.render(
                        url, deadline_seconds=remaining
                    )
                    browser_content = extract_content(
                        browser_page.html, browser_page.url
                    )
                    if browser_content.markdown and (
                        static_content is None
                        or browser_content.text_length >= static_content.text_length
                    ):
                        return self._result(browser_page, browser_content)
                except URLSecurityError:
                    raise
                except BrowserRenderError as exc:
                    logger.info("Browser fetch failed for %s: %s", url, exc)
                    if static_error is None:
                        static_error = exc

                if (
                    static_page is not None
                    and static_content is not None
                    and static_content.markdown
                ):
                    logger.info(
                        "Using low-confidence static content after browser fallback failed: %s",
                        url,
                    )
                    return self._result(static_page, static_content)
        except URLSecurityError as exc:
            raise WebAPIError(f"BuiltinParse blocked unsafe URL: {exc}") from exc
        except TimeoutError as exc:
            raise WebAPIError(
                f"BuiltinParse timed out after {self._timeout:g}s while fetching {url}"
            ) from exc

        detail = f": {static_error}" if static_error is not None else ""
        raise WebAPIError(
            f"BuiltinParse failed to extract readable content from {url}{detail}"
        )

    # 显式回收延迟创建的浏览器与driver，避免停止后遗留进程。
    async def aclose(self) -> None:
        """Release the lazily started browser process."""
        await self._browser.aclose()

    # robots文本仍经过相同HTTP安全策略及总时限。
    async def fetch_robots_txt(self, url: str) -> str:
        """Fetch robots.txt through the SSRF-safe static HTTP engine.

        Args:
            url: Absolute robots.txt URL.

        Returns:
            Raw robots.txt response text.

        Raises:
            WebAPIError: If the request is unsafe, times out, or fails.
        """
        try:
            async with asyncio.timeout(self._timeout):
                page = await self._http.fetch(url)
        except URLSecurityError as exc:
            raise WebAPIError(
                f"BuiltinParse blocked unsafe robots.txt URL: {exc}"
            ) from exc
        except TimeoutError as exc:
            raise WebAPIError(f"BuiltinParse timed out while fetching {url}") from exc
        except (httpx.HTTPError, UnicodeError, ValueError) as exc:
            raise WebAPIError(
                f"BuiltinParse failed to fetch robots.txt from {url}: {exc}"
            ) from exc
        return page.html

    # 统一正文、最终地址与链接结构，供外层原生工具处理。
    def _result(self, page: RawPage, content: ExtractedContent) -> FetchResult:
        logger.info(
            "BuiltinParse extracted %d characters from %s (HTTP %d)",
            content.text_length,
            page.url,
            page.status_code,
        )
        return FetchResult(
            content=content.markdown,
            url=page.url,
            title=content.title,
            provider=self.name,
            links=extract_links(page.html, page.url),
        )
