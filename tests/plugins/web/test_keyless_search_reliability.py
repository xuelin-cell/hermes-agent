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
    monkeypatch.setattr(policy, "_cooldowns", {})
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


def test_rejected_service_temporarily_skipped_per_home(monkeypatch, routing, tmp_path):
    """A 的拒绝只暂避 A；回到 A 复用暂避，到期后自动恢复尝试。"""
    clock = [100.0]
    rejected = []
    monkeypatch.setattr(policy.time, "monotonic", lambda: clock[0])
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "firecrawl", ring.firecrawl_search_keyless)

    def deny(*args, **kwargs):
        """返回真实记录中的匿名访问拒绝结构，统计是否重复访问。"""
        rejected.append(1)
        return httpx.Response(
            403, json={"error": "Firecrawl can't be used without an API key from here."},
            request=httpx.Request("POST", "https://api.firecrawl.dev/v2/search"),
        )

    monkeypatch.setattr(httpx, "post", deny)
    for home in ("A", "A", "B", "A"):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / home))
        assert ring.search_with_failover("firecrawl", "query")["success"] is True
    assert len(rejected) == 2
    clock[0] += 301
    assert ring.search_with_failover("firecrawl", "query")["success"] is True
    assert len(rejected) == 3


@pytest.mark.parametrize("retry_after, delay", [("17", 17), ("invalid", 60), ("http-date", 120)])
def test_retry_after_controls_recovery_probe(monkeypatch, routing, retry_after, delay):
    """限流等待兼容秒数、HTTP 日期和无效头，期间不重复请求。"""
    from datetime import datetime, timedelta, timezone
    from email.utils import format_datetime

    clock = [100.0]
    seen = []
    monkeypatch.setattr(policy.time, "monotonic", lambda: clock[0])
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "exa", ring.exa_search_keyless)
    if retry_after == "http-date":
        retry_after = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=delay), usegmt=True)
    response = requests.Response()
    response.status_code = 429
    response.headers.update({"Content-Type": "application/json", "Retry-After": retry_after})
    response._content = b'{"error":"too many requests"}'

    def limited(*args, **kwargs):
        """真实 MCP HTTP 错误经过异常包装后仍携带等待时间。"""
        seen.append(1)
        return response

    monkeypatch.setattr(requests, "post", limited)
    assert ring.search_with_failover("exa", "q")["success"] is True
    clock[0] += delay - 3
    assert ring.search_with_failover("exa", "q")["success"] is True
    assert len(seen) == 1
    clock[0] += 4
    assert ring.search_with_failover("exa", "q")["success"] is True
    assert len(seen) == 2


def test_concurrent_probe_and_late_completion_preserve_new_failure(monkeypatch, routing):
    """到期并发只放行一次，迟到成功不能覆盖随后登记的新故障。"""
    from concurrent.futures import ThreadPoolExecutor
    import threading

    clock = [100.0]
    monkeypatch.setattr(policy.time, "monotonic", lambda: clock[0])
    old = policy.claim_service("exa")
    policy.finish_service(old, 1)
    clock[0] += 2
    barrier = threading.Barrier(8)

    def claim(_index):
        """让多个线程同时争取同一个恢复探测。"""
        barrier.wait(timeout=10)
        return policy.claim_service("exa")

    with ThreadPoolExecutor(max_workers=8) as pool:
        tickets = [ticket for ticket in pool.map(claim, range(8)) if ticket is not None]
    assert len(tickets) == 1
    policy.finish_service(old, None)
    assert policy.claim_service("exa") is None
    policy.finish_service(old, 30)
    policy.finish_service(tickets[0], None)
    assert policy.claim_service("exa") is None
    clock[0] += 31
    recovered = policy.claim_service("exa")
    assert recovered is not None
    policy.finish_service(recovered, None)
    assert policy.claim_service("exa") is not None


def test_mcp_policy_error_is_not_misread_as_rate_limit(monkeypatch, routing):
    """MCP 文本同时提到网站策略和限流时，也不能换源绕过策略。"""
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "exa", ring.exa_search_keyless)
    response = requests.Response()
    response.status_code = 200
    response.headers["Content-Type"] = "application/json"
    response._content = b'{"result":{"isError":true,"content":[{"text":"blocked by website policy: rate limit"}]}}'
    monkeypatch.setattr(requests, "post", lambda *a, **kw: response)
    result = ring.search_with_failover("exa", "q")
    assert result["success"] is False
    assert "website policy" in result["error"]
    assert routing == []


def test_local_http_provider_failover_and_cooldown(monkeypatch, routing):
    """真实 HTTP 往返确认拒绝、备用成功、重复请求避让及正常结果格式。"""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import json
    import threading

    from plugins.web.firecrawl.provider import FirecrawlWebSearchProvider, _KeylessFirecrawlClient

    seen = []

    class Handler(BaseHTTPRequestHandler):
        """只接收独立回环端口上的受控测试请求。"""

        def do_POST(self):
            """按服务路径模拟匿名拒绝和搜索结果，不依赖外网。"""
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert payload["query"] == "query"
            seen.append(self.path)
            if self.path.startswith("/firecrawl/"):
                status, body = 403, {"error": "Firecrawl can't be used without an API key from here."}
            else:
                status, body = 200, {"results": [{"url": "https://result.example", "title": "Result", "snippet": "Found"}]}
            content = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, *args):
            """测试服务器不向控制台输出原始请求。"""

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    address = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setattr("plugins.web.firecrawl.provider._KeylessFirecrawlClient", lambda: _KeylessFirecrawlClient(address + "/firecrawl"))
    monkeypatch.setattr(ring, "KEENABLE_API_URL", address + "/keenable")
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "firecrawl", ring.firecrawl_search_keyless)
    monkeypatch.setitem(ring._KEYLESS_SEARCHERS, "keenable", ring.keenable_search_keyless)
    try:
        provider = FirecrawlWebSearchProvider()
        for _ in range(2):
            result = provider.search("query", 1)
            assert result["success"] is True
            assert result["data"]["web"][0]["url"] == "https://result.example"
            assert result["data"]["served_by"] == "keenable"
            assert set(result) == {"success", "data"}
        assert seen == ["/firecrawl/v2/search", "/keenable/v1/search/public", "/keenable/v1/search/public"]
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
