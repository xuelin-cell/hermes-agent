"""免费搜索在真实请求边界上的失败切换，不访问外网或模型。"""

import httpx
import pytest
import requests

from plugins.web import keyless_mcp as ring
from plugins.web import keyless_search as policy


@pytest.fixture
def routing(monkeypatch):
    """固定轮换顺序，禁止测试意外访问未声明的搜索服务。"""
    monkeypatch.setattr(ring, "_vendor_pinned", lambda name: True)
    monkeypatch.setattr(ring, "provider_tier", lambda name: "auto")
    monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False)
    calls = []
    for vendor in ring._KEYLESS_RING:
        monkeypatch.setitem(
            ring._KEYLESS_SEARCHERS, vendor,
            lambda query, limit, vendor=vendor: calls.append(vendor) or {
                "success": True, "data": {"web": [{"url": f"https://{vendor}.example"}]},
            },
        )
    return calls


@pytest.mark.parametrize("failure", ["anonymous_denied", "timeout", "server_error"])
def test_firecrawl_failure_uses_next_service(monkeypatch, routing, failure):
    """匿名拒绝、读取超时及服务故障不能掩盖其他免费服务的成功结果。"""
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "firecrawl", ring.firecrawl_search_keyless)
    if failure == "timeout":
        monkeypatch.setattr(httpx, "post", lambda *a, **kw: (_ for _ in ()).throw(httpx.ReadTimeout("slow")))
    else:
        status = 403 if failure == "anonymous_denied" else 503
        message = "Your IP looks like a VPN or proxy; Firecrawl can't be used without an API key from here."
        response = httpx.Response(
            status, json={"error": message if status == 403 else "unavailable"},
            request=httpx.Request("POST", "https://api.firecrawl.dev/v2/search"),
        )
        monkeypatch.setattr(httpx, "post", lambda *a, **kw: response)
    result = ring.search_with_failover("firecrawl", "query", 2)
    assert result["success"] is True
    assert result["data"]["served_by"] == "keenable"
    assert routing == ["keenable"]
    assert set(result) == {"success", "data"}


def test_mcp_proxy_failure_uses_next_service(monkeypatch, routing):
    """MCP 包装后的代理异常仍保留可切换分类。"""
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "exa", ring.exa_search_keyless)
    monkeypatch.setattr(requests, "post", lambda *a, **kw: (_ for _ in ()).throw(requests.exceptions.ProxyError("offline")))
    result = ring.search_with_failover("exa", "query")
    assert result["success"] is True
    assert routing == ["parallel"]


@pytest.mark.parametrize("status, message", [
    (400, "invalid query"), (403, "forbidden"),
    (403, "blocked by website policy; anonymous keyless access is unavailable"),
])
def test_invalid_or_policy_denial_does_not_fan_out(monkeypatch, routing, status, message):
    """参数、未知权限与网站策略错误保留原失败，不扩大访问范围。"""
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "firecrawl", ring.firecrawl_search_keyless)
    response = httpx.Response(
        status, json={"error": message},
        request=httpx.Request("POST", "https://api.firecrawl.dev/v2/search"),
    )
    monkeypatch.setattr(httpx, "post", lambda *a, **kw: response)
    result = ring.search_with_failover("firecrawl", "query")
    assert result["success"] is False
    assert routing == []
    assert set(result) == {"success", "error"}


def test_certificate_verification_failure_is_not_bypassed(monkeypatch, routing):
    """保留证书校验失败，不降级 TLS 或把它当成普通连接中断。"""
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "exa", ring.exa_search_keyless)
    monkeypatch.setattr(requests, "post", lambda *a, **kw: (_ for _ in ()).throw(
        requests.exceptions.SSLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"),
    ))
    result = ring.search_with_failover("exa", "query")
    assert result["success"] is False
    assert "certificate verification failed" in result["error"]
    assert routing == []


@pytest.mark.parametrize("stop", ["cancel", "budget"])
def test_cancel_or_spent_budget_stops_further_attempts(monkeypatch, routing, stop):
    """第一家返回时已取消或预算耗尽，不再访问下一家。"""
    clock = [100.0]
    cancelled = [False]
    monkeypatch.setattr(policy.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: cancelled[0])

    def first(query, limit):
        """模拟请求期间消耗时间或收到取消。"""
        routing.append("exa")
        assert 0 < policy.request_timeout(60) <= policy.ATTEMPT_TIMEOUT_SECONDS
        clock[0] += policy.SEARCH_BUDGET_SECONDS
        cancelled[0] = stop == "cancel"
        return {"success": False, "error": "rate limit"}

    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "exa", first)
    result = ring.search_with_failover("exa", "query")
    assert result["success"] is False
    assert routing == ["exa"]
    assert ("Interrupted" if stop == "cancel" else "budget exhausted") in result["error"]
    assert policy.request_timeout(60) == 60


def test_all_services_fail_once_without_false_success(monkeypatch, routing):
    """四家实际适配器均连接失败时，只各试一次并返回失败摘要。"""
    requests_seen = []

    def requests_fail(url, **kwargs):
        """记录适配器真实传出的超时并拒绝外网连接。"""
        requests_seen.append((url, kwargs["timeout"]))
        raise requests.exceptions.ConnectionError("offline")

    def httpx_fail(url, **kwargs):
        """Firecrawl 也经过正式匿名请求入口，保留默认 TLS 验证。"""
        requests_seen.append((url, kwargs["timeout"]))
        assert "verify" not in kwargs
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(requests, "post", requests_fail)
    monkeypatch.setattr(httpx, "post", httpx_fail)
    for vendor in ring._KEYLESS_RING:
        monkeypatch.setitem(ring._KEYLESS_SEARCHERS, vendor, getattr(ring, f"{vendor}_search_keyless"))
    result = ring.search_with_failover("exa", "query")
    assert result["success"] is False
    assert set(result) == {"success", "error"}
    assert len(requests_seen) == len({url for url, _timeout in requests_seen}) == 4
    assert all(0 < timeout <= policy.ATTEMPT_TIMEOUT_SECONDS for _url, timeout in requests_seen)
    assert all(vendor in result["error"] for vendor in ring._KEYLESS_RING)
