"""Reusable Playwright engine for JavaScript-rendered pages."""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import TYPE_CHECKING

from .http import DEFAULT_USER_AGENT, RawPage
from .security import NetworkPolicy, URLSecurityError
from .urls import navigation_url
from .interaction import collect_loaded, _READING_STATE, Capture
from .evidence import PageEvidence

if TYPE_CHECKING:
    from playwright.async_api import Browser, Page, Playwright, Request, Route

_BLOCKED_RESOURCE_TYPES = frozenset({"font", "media", "image"})
_SAFE_INLINE_SCHEMES = ("about:", "blob:", "data:")
_HTTP_ERROR_STATUS = 400
_STABLE_CHECKS_REQUIRED = 2
_BROWSER_CONTENT_TYPES = ("text/", "application/xhtml+xml")


class BrowserRenderError(RuntimeError):
    """Raised when Chromium cannot render a requested page."""


class BrowserEngine:
    """Render pages in a shared Chromium process with isolated contexts."""

    # 只建立并发控制，浏览器延迟到实际需要时启动。
    def __init__(
        self,
        policy: NetworkPolicy,
        *,
        concurrency: int = 2,
        max_response_bytes: int = 10 * 1024 * 1024,
    ) -> None:
        """Initialize the engine without starting Chromium."""
        self._policy = policy
        self._max_response_bytes = max_response_bytes
        self._semaphore = asyncio.Semaphore(concurrency)
        self._start_lock = asyncio.Lock()
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None

    # 浏览器上下文隔离，页面HTTP请求继续经过同一安全策略。
    async def render(self, url: str, *, deadline_seconds: float) -> RawPage:
        """Render a page, checking every browser network request against policy."""
        from playwright.async_api import Error as PlaywrightError

        url = navigation_url(await self._policy.validate(url), url)
        navigation_error = None
        reading = False
        interaction_blocked = False
        deadline = asyncio.get_running_loop().time() + deadline_seconds
        try:
            async with self._semaphore:
                browser = await self._get_browser()
                context = await browser.new_context(
                    user_agent=DEFAULT_USER_AGENT,
                    service_workers="block",
                    accept_downloads=False,
                    java_script_enabled=True,
                )
                page = await context.new_page()
                timeout_ms = max(1_000, int(deadline_seconds * 1_000))
                page.set_default_timeout(timeout_ms)
                page.set_default_navigation_timeout(timeout_ms)

                # 页面子请求仍需校验目标，阻断内网及无关大资源。
                async def guard_request(route: Route, request: Request) -> None:
                    nonlocal navigation_error, interaction_blocked
                    # 自动阅读阶段不提交数据、不跳页或打开新页；复杂动作交还原生浏览器工具。
                    if reading and request.method not in {"GET", "HEAD"}:
                        interaction_blocked = True
                        await route.abort("blockedbyclient")
                        return
                    if request.resource_type in _BLOCKED_RESOURCE_TYPES:
                        await route.abort("blockedbyclient")
                        return
                    if request.url.startswith(_SAFE_INLINE_SCHEMES):
                        await route.continue_()
                        return
                    try:
                        await self._policy.validate(request.url)
                    except URLSecurityError as exc:
                        if (
                            request.is_navigation_request()
                            and request.frame == page.main_frame
                        ):
                            navigation_error = exc
                        await route.abort("blockedbyclient")
                        return
                    if reading and request.is_navigation_request():
                        interaction_blocked = True
                        await route.abort("blockedbyclient")
                        return
                    await route.continue_()

                await context.route("**/*", guard_request)
                # 自动阅读不接受网页要求的确认或弹窗。
                page.on("dialog", lambda dialog: dialog.dismiss())
                try:
                    response = await page.goto(
                        url, wait_until="domcontentloaded", timeout=timeout_ms
                    )
                    if response is None:
                        message = "Navigation did not return a response"
                        raise PlaywrightError(message)
                    if response.status >= _HTTP_ERROR_STATUS:
                        message = f"Browser navigation returned HTTP {response.status}"
                        raise PlaywrightError(message)

                    final_url = navigation_url(
                        await self._policy.validate(page.url), page.url
                    )
                    if navigation_error is not None:
                        raise navigation_error
                    headers = await response.all_headers()
                    self._validate_response_headers(headers)
                    initial = await page.evaluate(_READING_STATE)
                    html = initial["html"]
                    if (
                        max(len(html.encode("utf-8")), initial["rawBytes"])
                        > self._max_response_bytes
                    ):
                        message = (
                            "Rendered page exceeds the configured response size limit"
                        )
                        raise BrowserRenderError(message)
                    # 内容已就绪时不等networkidle；仅空壳/薄正文使用原有有界等待。
                    from .content import extract_content
                    from .quality import assess

                    evidence = PageEvidence(
                        html,
                        "browser_computed",
                        initial["busy"],
                        folded=initial["folded"],
                    )
                    content = extract_content(html, final_url, evidence=evidence)
                    assessment = assess(
                        RawPage(html, final_url, response.status, headers),
                        content,
                        requested_url=url,
                        engine="chromium",
                    )
                    if not initial["busy"] and any(
                        reason in {"empty_content", "thin_content"}
                        for reason in assessment.reasons
                    ):
                        await self._wait_until_stable(
                            page,
                            deadline_seconds=min(
                                max(
                                    0.01,
                                    deadline - asyncio.get_running_loop().time() - 0.5,
                                ),
                                8.0,
                            ),
                        )
                    reading = True
                    remaining = deadline - asyncio.get_running_loop().time() - 0.5
                    if not initial["busy"] and (
                        assessment.status == "usable"
                        or assessment.reasons
                        in {("pagination_remaining",), ("repository_overview_unverified",), ("access_page",)}
                    ):
                        capture = Capture((html,), (), (evidence,))
                    else:
                        capture = await collect_loaded(
                            page,
                            html,
                            budget_seconds=min(12.0, max(0.01, remaining)),
                            max_bytes=self._max_response_bytes,
                        )
                    if navigation_error is not None:
                        raise navigation_error
                    reasons = capture.reasons
                    if interaction_blocked:
                        reasons = (*reasons, "interaction_blocked")
                    return RawPage(
                        html=capture.snapshots[0] if capture.snapshots else html,
                        url=final_url,
                        status_code=response.status,
                        headers=headers,
                        snapshots=capture.snapshots,
                        evidence=capture.evidence or (evidence,),
                        interaction_reasons=tuple(dict.fromkeys(reasons)),
                    )
                finally:
                    await context.close()
        except URLSecurityError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # Playwright exposes backend-specific failure classes.
            # 主页面跳转被拒绝必须保持安全失败，不能伪装成普通渲染故障。
            if navigation_error is not None:
                raise navigation_error from exc
            message = f"Chromium render failed: {exc}"
            raise BrowserRenderError(message) from exc

    # 显式回收延迟创建的浏览器与driver，避免停止后遗留进程。
    async def aclose(self) -> None:
        """Close the shared browser process, if it was started."""
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    # 只使用原生解析出的浏览器，启动失败时释放driver。
    async def _get_browser(self) -> Browser:
        if self._browser is not None and self._browser.is_connected():
            return self._browser
        async with self._start_lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None
                self._browser = None
            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()
            try:
                executable = _find_chromium_executable()
                if executable is None:
                    raise BrowserRenderError("网页渲染组件暂不可用，请稍后重试。")
                self._browser = await self._playwright.chromium.launch(
                    headless=True, executable_path=executable
                )
            except Exception:
                await self._playwright.stop()
                self._playwright = None
                raise
            return self._browser

    # 在读取正文前拒绝不支持的类型或超出预算的响应。
    def _validate_response_headers(self, headers: dict[str, str]) -> None:
        content_type = headers.get("content-type", "").lower()
        if content_type and not content_type.startswith(_BROWSER_CONTENT_TYPES):
            message = (
                f"Unsupported browser content type: {content_type.split(';', 1)[0]}"
            )
            raise BrowserRenderError(message)
        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                parsed_length = int(content_length)
            except ValueError:
                parsed_length = 0
            if parsed_length > self._max_response_bytes:
                message = "Rendered page exceeds the configured response size limit"
                raise BrowserRenderError(message)

    # 有限等待页面稳定，避免动态页面无限加载。
    @staticmethod
    async def _wait_until_stable(page: Page, *, deadline_seconds: float) -> None:
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError

        with contextlib.suppress(PlaywrightTimeoutError):
            await page.wait_for_load_state(
                "networkidle", timeout=max(500, int(deadline_seconds * 500))
            )

        deadline = asyncio.get_running_loop().time() + deadline_seconds
        previous: tuple[int, int] | None = None
        stable_checks = 0
        while asyncio.get_running_loop().time() < deadline:
            current_values = await page.evaluate(
                "() => [document.body?.innerText.length || 0, document.body?.scrollHeight || 0]"
            )
            current = (int(current_values[0]), int(current_values[1]))
            if current == previous:
                stable_checks += 1
                if stable_checks >= _STABLE_CHECKS_REQUIRED:
                    return
            else:
                stable_checks = 0
                previous = current
            await asyncio.sleep(0.25)


def _find_chromium_executable() -> str | None:
    """复用 Hermes 的只读 Chromium 解析，不扫描平台目录或触发安装。"""
    from hermes_cli.browser_runtime import chromium_executable

    executable = chromium_executable()
    return str(executable) if executable and Path(executable).is_file() else None
