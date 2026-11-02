from __future__ import annotations
from .test_unisearch import load_package

load_package()

import httpx
import pytest

from unisearch_test_plugin.fetch.builtin.http import HttpEngine, ResponseTooLargeError
from unisearch_test_plugin.fetch.builtin.security import NetworkPolicy, URLSecurityError


# 提供确定的公网DNS答案，避免测试依赖外网。
async def _public_resolver(hostname: str, port: int) -> tuple[str, ...]:
    del hostname, port
    return ("93.184.216.34",)


# 逐跳校验同时保持重定向与字符集解码能力。
@pytest.mark.asyncio
async def test_http_engine_follows_checked_redirect_and_decodes_charset() -> None:
    # 合成响应覆盖网络边界，实际HTTP引擎与限制保持真实。
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/article"})
        body = "标题与正文".encode("gb18030")
        return httpx.Response(
            200, content=body, headers={"content-type": "text/html; charset=gb18030"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = HttpEngine(
            NetworkPolicy(resolver=_public_resolver),
            timeout=5,
            max_response_bytes=1024,
            client=client,
        )
        page = await engine.fetch("https://example.com/start")

    assert page.url == "https://example.com/article"
    assert page.html == "标题与正文"


# 跳转目标在发出下一请求前就必须校验。
@pytest.mark.asyncio
async def test_http_engine_validates_redirect_before_requesting_target() -> None:
    requested: list[str] = []

    # 合成响应覆盖网络边界，实际HTTP引擎与限制保持真实。
    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = HttpEngine(
            NetworkPolicy(resolver=_public_resolver),
            timeout=5,
            max_response_bytes=1024,
            client=client,
        )
        with pytest.raises(URLSecurityError):
            await engine.fetch("https://example.com/start")

    assert requested == ["https://example.com/start"]


# 流式正文超限后立即停止，不读取完整大响应。
@pytest.mark.asyncio
async def test_http_engine_stops_stream_over_size_limit() -> None:
    # 合成响应覆盖网络边界，实际HTTP引擎与限制保持真实。
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200, content=b"x" * 20, headers={"content-type": "text/html"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = HttpEngine(
            NetworkPolicy(resolver=_public_resolver),
            timeout=5,
            max_response_bytes=10,
            client=client,
        )
        with pytest.raises(ResponseTooLargeError):
            await engine.fetch("https://example.com/")


# 声明大小超限时不开始读取正文。
@pytest.mark.asyncio
async def test_http_engine_rejects_declared_oversized_response_before_reading() -> None:
    # 合成响应覆盖网络边界，实际HTTP引擎与限制保持真实。
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            content=b"small",
            headers={"content-type": "text/html", "content-length": "1000"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = HttpEngine(
            NetworkPolicy(resolver=_public_resolver),
            timeout=5,
            max_response_bytes=100,
            client=client,
        )
        with pytest.raises(ResponseTooLargeError):
            await engine.fetch("https://example.com/")


# 不支持的二进制响应不能作为网页正文。
@pytest.mark.asyncio
async def test_http_engine_rejects_unsupported_binary_content() -> None:
    # 合成响应覆盖网络边界，实际HTTP引擎与限制保持真实。
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200, content=b"%PDF", headers={"content-type": "application/pdf"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = HttpEngine(
            NetworkPolicy(resolver=_public_resolver),
            timeout=5,
            max_response_bytes=1024,
            client=client,
        )
        with pytest.raises(ValueError, match="Unsupported web content type"):
            await engine.fetch("https://example.com/file.pdf")


# 响应头缺编码时仍能识别页面内声明。
@pytest.mark.asyncio
async def test_http_engine_decodes_charset_from_meta_tag() -> None:
    expected = "中文元数据编码正文"

    # 合成响应覆盖网络边界，实际HTTP引擎与限制保持真实。
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        body = f'<html><head><meta charset="gb18030"></head><body>{expected}</body></html>'.encode(
            "gb18030"
        )
        return httpx.Response(200, content=body, headers={"content-type": "text/html"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = HttpEngine(
            NetworkPolicy(resolver=_public_resolver),
            timeout=5,
            max_response_bytes=1024,
            client=client,
        )
        page = await engine.fetch("https://example.com/chinese")

    assert expected in page.html
