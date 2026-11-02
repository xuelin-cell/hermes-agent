"""Bounded asynchronous HTTP engine for static web pages."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING
from urllib.parse import urljoin

import chardet
import httpx

if TYPE_CHECKING:
    from collections.abc import Mapping

    from .security import NetworkPolicy

DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_SUPPORTED_CONTENT_TYPES = (
    "text/",
    "application/xhtml+xml",
    "application/xml",
    "application/json",
)
_META_CHARSET = re.compile(rb"<meta[^>]+charset=[\"']?\s*([\w.-]+)", re.IGNORECASE)


class ResponseTooLargeError(ValueError):
    """Raised when a response exceeds the configured byte limit."""


@dataclass(frozen=True, slots=True)
class RawPage:
    """Raw page returned by an HTTP or browser engine."""

    html: str
    url: str
    status_code: int
    headers: Mapping[str, str]


class HttpEngine:
    """Fetch pages with manual, policy-checked redirects and streaming limits."""

    # 注入统一网络策略与资源预算，测试可替换传输边界。
    def __init__(
        self,
        policy: NetworkPolicy,
        *,
        timeout: float,
        max_response_bytes: int,
        max_redirects: int = 5,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        """Initialize request policy and resource bounds."""
        self._policy = policy
        self._timeout = timeout
        self._max_response_bytes = max_response_bytes
        self._max_redirects = max_redirects
        self._client = client

    # 当前策略与总预算内获取页面，安全拒绝不通过其他引擎绕行。
    async def fetch(self, url: str) -> RawPage:
        """Fetch one static page."""
        if self._client is not None:
            return await self._fetch_with_client(self._client, url)
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=httpx.Timeout(self._timeout),
            trust_env=False,
        ) as client:
            return await self._fetch_with_client(client, url)

    # 每次跳转重新校验目标，流式读取限制响应大小。
    async def _fetch_with_client(self, client: httpx.AsyncClient, url: str) -> RawPage:
        current_url = url
        headers = {
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        }

        for redirect_number in range(self._max_redirects + 1):
            current_url = await self._policy.validate(current_url)
            async with client.stream(
                "GET", current_url, headers=headers, follow_redirects=False
            ) as response:
                if response.status_code in _REDIRECT_CODES:
                    location = response.headers.get("location")
                    if location is None:
                        response.raise_for_status()
                    if redirect_number == self._max_redirects:
                        message = "Maximum redirect count exceeded"
                        raise httpx.TooManyRedirects(message, request=response.request)
                    current_url = urljoin(current_url, location)
                    continue

                response.raise_for_status()
                self._validate_headers(response)
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > self._max_response_bytes:
                        message = self._size_error()
                        raise ResponseTooLargeError(message)
                return RawPage(
                    html=_decode(bytes(body), response),
                    url=str(response.url),
                    status_code=response.status_code,
                    headers=dict(response.headers),
                )

        message = "redirect loop must return or raise"
        raise AssertionError(message)

    # 响应类型与大小先检查，再开始读取正文。
    def _validate_headers(self, response: httpx.Response) -> None:
        content_length = response.headers.get("content-length")
        if content_length is not None:
            try:
                parsed_length = int(content_length)
            except ValueError:
                parsed_length = 0
            if parsed_length > self._max_response_bytes:
                raise ResponseTooLargeError(self._size_error())

        content_type = response.headers.get("content-type", "").lower()
        if content_type and not content_type.startswith(_SUPPORTED_CONTENT_TYPES):
            message = f"Unsupported web content type: {content_type.split(';', 1)[0]}"
            raise ValueError(message)

    # 返回固定大小限制提示，不附带响应或凭证。
    def _size_error(self) -> str:
        return f"Web response exceeds the {self._max_response_bytes // (1024 * 1024)}MB download limit."


# 优先沿响应与页面字符集解码，兼容未声明编码的网页。
def _decode(body: bytes, response: httpx.Response) -> str:
    charset = response.charset_encoding
    if charset is None:
        match = _META_CHARSET.search(body[:4096])
        if match is not None:
            charset = match.group(1).decode("ascii", errors="ignore")
    if charset is None:
        detected = chardet.detect(body).get("encoding")
        charset = detected if isinstance(detected, str) else "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")
