"""Built-in web fetch provider with static HTTP and dynamic browser fallback.

The implementation is self-contained in HexAgent.  It follows an engine
waterfall similar to mature crawler designs, but does not call or embed the
AGPL-licensed Firecrawl service or source code.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import replace
from collections import Counter
from typing import TYPE_CHECKING

import httpx


from .base import FetchResult
from .builtin.quality import Assessment, BuiltinResult, assess, candidate_rank
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


class WebAPIError(RuntimeError):
    """A fetch failed without usable content."""

    # 只向跨进程结果传稳定原因码，不暴露底层异常细节。
    def __init__(self, message: str, *, reason: str = "extract_failed"):
        super().__init__(message)
        self.reason = reason


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
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout
        candidate = None
        failure_reason = "render_unavailable"
        unavailable_reason = ""
        try:
            async with asyncio.timeout(self._timeout):
                try:
                    page = await self._http.fetch(url)
                    content = extract_content(
                        page.html,
                        page.url,
                        evidence=page.evidence[0] if page.evidence else None,
                    )
                    assessment = assess(page, content, requested_url=url, engine="http")
                    if assessment.status == "unavailable":
                        unavailable_reason = assessment.reasons[0]
                    if assessment.status != "unavailable":
                        candidate = (page, content, assessment, "http")
                        if assessment.status == "usable" and not needs_browser(
                            page.html, content, dynamic_only=True
                        ):
                            return self._result(*candidate)
                        # 只有目录而无加载证据时保留partial，让任务按需续读，避免盲目渲染。
                        if assessment.reasons in {
                            ("pagination_remaining",),
                            ("repository_overview_unverified",),
                        } and not needs_browser(page.html, content, dynamic_only=True):
                            return self._result(*candidate)
                        if assessment.status == "usable":
                            assessment = Assessment(
                                "partial",
                                ("dynamic_content_pending",),
                                assessment.structure,
                            )
                            candidate = (page, content, assessment, "http")
                except URLSecurityError:
                    raise
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code in {404, 410}:
                        raise WebAPIError(
                            "Page is unavailable", reason="http_error"
                        ) from exc
                except (httpx.HTTPError, UnicodeError, ValueError):
                    pass  # 普通取页失败仍可在同一预算内尝试浏览器。

                # 给结果序列化和资源清理留余量，局部渲染不能耗尽总预算。
                reserve = min(1.0, self._timeout * 0.1)
                remaining = deadline - loop.time() - reserve
                if remaining > 0:
                    try:
                        async with asyncio.timeout(remaining):
                            page = await self._browser.render(
                                url, deadline_seconds=remaining
                            )
                            page, content, assessment, progressed = (
                                self._rendered_candidate(page, url)
                            )
                            if assessment.status != "unavailable":
                                rendered = (page, content, assessment, "chromium")
                                if (
                                    candidate is None
                                    or progressed
                                    or (
                                        page.evidence
                                        and "visibility_unresolved"
                                        in candidate[2].reasons
                                    )
                                    or candidate_rank(assessment, content)
                                    > candidate_rank(candidate[2], candidate[1])
                                ):
                                    candidate = rendered
                                elif page.interaction_reasons:
                                    (
                                        saved_page,
                                        saved_content,
                                        saved_assessment,
                                        saved_engine,
                                    ) = candidate
                                    candidate = (
                                        saved_page,
                                        saved_content,
                                        Assessment(
                                            "partial",
                                            tuple(
                                                dict.fromkeys(
                                                    (
                                                        *saved_assessment.reasons,
                                                        *page.interaction_reasons,
                                                    )
                                                )
                                            ),
                                            saved_assessment.structure,
                                        ),
                                        saved_engine,
                                    )
                                return self._result(*candidate)
                            # 浏览器已推翻静态未知证据时，不能再返回那份疑似正文。
                            if (
                                candidate is not None
                                and page.evidence
                                and "visibility_unresolved" in candidate[2].reasons
                            ):
                                candidate = None
                            unavailable_reason = assessment.reasons[0]
                            failure_reason = "render_no_usable_content"
                    except URLSecurityError:
                        raise
                    except TimeoutError:
                        failure_reason = "render_timeout"
                    except BrowserRenderError:
                        failure_reason = "render_unavailable"
                else:
                    failure_reason = "budget_exhausted"
                if candidate is not None:
                    page, content, assessment, engine = candidate
                    assessment = Assessment(
                        "partial",
                        tuple(dict.fromkeys((*assessment.reasons, failure_reason))),
                        assessment.structure,
                    )
                    return self._result(page, content, assessment, engine)
        except URLSecurityError as exc:
            raise WebAPIError(
                f"BuiltinParse blocked unsafe URL: {exc}", reason="policy_blocked"
            ) from exc
        except TimeoutError as exc:
            raise WebAPIError(
                f"BuiltinParse timed out after {self._timeout:g}s while fetching {url}"
            ) from exc
        raise WebAPIError(
            f"BuiltinParse failed to extract readable content from {url} ({failure_reason})",
            reason=unavailable_reason or failure_reason,
        )

    # 显式回收延迟创建的浏览器与driver，避免停止后遗留进程。
    async def aclose(self) -> None:
        """Release the lazily started browser process."""
        await self._browser.aclose()

    # 逐份评估真实采样；交互新增内容优先保留，不用交互前DOM给合并正文打分。
    def _rendered_candidate(self, page: RawPage, requested_url: str):
        snapshots = page.snapshots or (page.html,)
        valid = []
        for index, html in enumerate(snapshots):
            sample = extract_content(
                html, page.url, evidence=page.evidence[index] if page.evidence else None
            )
            assessment = assess(
                replace(page, html=html),
                sample,
                requested_url=requested_url,
                engine="chromium",
            )
            if assessment.status != "unavailable":
                valid.append((index, html, sample, assessment))
        if not valid:
            sample = extract_content(
                snapshots[-1],
                page.url,
                evidence=page.evidence[-1] if page.evidence else None,
            )
            assessment = assess(
                replace(page, html=snapshots[-1]),
                sample,
                requested_url=requested_url,
                engine="chromium",
            )
            return page, sample, assessment, False
        blocks, seen = [], Counter()
        for _, _, sample, _ in valid:
            occurrences = Counter()
            for block in re.split(r"\n{2,}", sample.markdown):
                fingerprint = re.sub(r"\s+", " ", block).strip()
                occurrences[fingerprint] += 1
                if fingerprint and occurrences[fingerprint] > seen[fingerprint]:
                    blocks.append(block)
            seen |= occurrences
        text = "\n\n".join(blocks)
        content = ExtractedContent(text, valid[-1][2].title, len(text))
        reasons = list(
            dict.fromkeys(reason for _, _, _, a in valid for reason in a.reasons)
        )
        if valid[-1][0] != len(snapshots) - 1:
            reasons.append("render_no_usable_content")
        assessment = Assessment(
            "partial" if reasons else "usable",
            tuple(reasons),
            max(a.structure for _, _, _, a in valid),
        )
        first = valid[0]
        # 只有确实观察到有效正文或链接变化，才跳过旧候选的结构排序。
        progressed = (first[0] > 0 and first[3].structure > 0) or any(
            a.structure > 0
            and (
                sample.markdown != first[2].markdown
                or extract_links(sample.evidence.html, page.url)
                != extract_links(first[2].evidence.html, page.url)
            )
            for _, html, sample, a in valid[1:]
        )
        captured = replace(
            page,
            html=valid[-1][1],
            snapshots=tuple(sample.evidence.html for _, _, sample, _ in valid),
            evidence=tuple(sample.evidence for _, _, sample, _ in valid),
        )
        return captured, content, assessment, progressed

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
    def _result(
        self,
        page: RawPage,
        content: ExtractedContent,
        assessment: Assessment,
        engine: str,
    ) -> BuiltinResult:
        logger.info(
            "BuiltinParse extracted %d characters from %s (HTTP %d)",
            content.text_length,
            page.url,
            page.status_code,
        )
        return BuiltinResult(
            fetch_status=assessment.status,
            engine=engine,
            reasons=assessment.reasons,
            content=content.markdown,
            url=page.url,
            title=content.title,
            provider=self.name,
            links=tuple(
                dict.fromkeys(
                    link
                    for html in (
                        tuple(e.html for e in page.evidence) or (content.evidence.html,)
                    )
                    for link in extract_links(html, page.url)
                )
            ),
        )
