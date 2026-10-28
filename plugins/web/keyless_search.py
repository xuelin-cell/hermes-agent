"""匿名搜索专用的失败分类与尝试预算，不改变抓取和付费请求。"""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math
import time


SEARCH_BUDGET_SECONDS = 30.0
ATTEMPT_TIMEOUT_SECONDS = 8.0
_deadline: ContextVar[float | None] = ContextVar("keyless_search_deadline", default=None)
_ACCESS_MARKERS = (
    "can't be used without an api key", "cannot be used without an api key",
    "keyless_access_not_available", "anonymous keyless access is unavailable",
    "api key is required", "missing api key",
)
_POLICY_MARKERS = ("blocked_by_policy", "blocked by website policy", "scrape_prompt_injection_detected", "unsupported_site")


class SearchFailure(RuntimeError):
    """服务故障携带内部分类，避免轮换依赖完整错误文案。"""

    def __init__(self, message: str, category: str = "", retry_after: float = 0.0):
        """只保存安全摘要及有限切换所需信息，不保存请求凭据。"""
        super().__init__(message)
        self.category = category
        self.retry_after = retry_after


@contextmanager
def search_budget():
    """为当前同步搜索绑定预算，退出后恢复原上下文。"""
    deadline = time.monotonic() + SEARCH_BUDGET_SECONDS
    outer = _deadline.get()
    token = _deadline.set(min(outer, deadline) if outer is not None else deadline)
    try:
        yield
    finally:
        _deadline.reset(token)


def budget_expired() -> bool:
    """预算耗尽后不再发起下一次请求。"""
    deadline = _deadline.get()
    return deadline is not None and time.monotonic() >= deadline


def request_timeout(default: float) -> float:
    """只收紧匿名搜索的网络等待，保留其他调用的原超时。"""
    deadline = _deadline.get()
    if deadline is None:
        return default
    return max(0.001, min(default, ATTEMPT_TIMEOUT_SECONDS, deadline - time.monotonic()))


def _retry_after(value: str) -> float:
    """兼容秒数和 HTTP 日期；无效值使用一分钟避让。"""
    try:
        delay = float(value)
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            delay = (date - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return 60.0
    return max(0.0, delay) if math.isfinite(delay) else 60.0


def response_error(response) -> SearchFailure:
    """区分服务端匿名拒绝和网站策略拒绝，不向结果透传响应正文。"""
    status = response.status_code
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    body = str(payload.get("error", "")) if isinstance(payload, dict) else ""
    body = body.lower()
    if any(marker in body for marker in _POLICY_MARKERS) or (isinstance(payload, dict) and payload.get("blocked_by_policy")):
        return SearchFailure(f"HTTP {status}: blocked by website policy")
    if status == 429:
        return SearchFailure("HTTP 429: free search rate limit", "rate_limit", _retry_after(response.headers.get("Retry-After", "")))
    if status == 401 or (status == 403 and any(marker in body for marker in _ACCESS_MARKERS)):
        return SearchFailure(f"HTTP {status}: anonymous search access unavailable", "access", 300.0)
    if status in (500, 502, 503, 504):
        return SearchFailure(f"HTTP {status}: search service temporarily unavailable", "server", 30.0)
    return SearchFailure(f"HTTP {status}: search request rejected")


def failed_result(result: dict, exc: Exception, *, rate_limited: bool = False) -> dict:
    """在搜索内部保留异常分类；外部协议由轮换入口统一还原。"""
    if _deadline.get() is None:
        return result
    import httpx
    import requests

    failure = None
    current = exc
    while current is not None:
        if isinstance(current, SearchFailure):
            failure = current
            break
        if "certificate_verify_failed" in str(current).lower() or "certificate verify failed" in str(current).lower():
            failure = SearchFailure("TLS certificate verification failed")
            break
        if isinstance(current, (requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                                httpx.NetworkError, httpx.TimeoutException, httpx.ProxyError, httpx.RemoteProtocolError)):
            failure = SearchFailure("Search network connection failed or timed out", "network", 30.0)
            break
        current = current.__cause__
    if failure is None and rate_limited:
        failure = SearchFailure("Free search rate limit", "rate_limit", 60.0)
    if failure is not None:
        result["error"] = str(failure)
        result["_keyless_failure"] = (failure.category, failure.retry_after)
    return result
