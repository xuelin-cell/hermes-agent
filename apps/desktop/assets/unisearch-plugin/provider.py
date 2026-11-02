"""UniSearch MaaS backend for Hermes; resolves configuration and credentials per call."""

from __future__ import annotations

import json
import time
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx
from agent.secret_scope import get_secret
from agent.web_search_provider import WebSearchProvider
from tools.url_safety import sensitive_query_param_name

from . import cache
from .common import _strip_redundant_modifiers
from .cards import _CANONICAL_EXTRACTORS, _serialize_vr_card

ENDPOINTS = {
    "bocha": "https://maas-api.ai-yuanjing.com/openapi/v1/uniclaw/general/tool/bocha_search",
    "tencent": "https://maas.ai-yuanjing.com/app/uniwork/general_search/tencent",
}


class UniSearchProvider(WebSearchProvider):
    """Search-only product provider. It never redirects failed calls to other vendors."""

    name = "unisearch"

    # 保存配置读取器及传输边界，账号凭证留到调用时解析。
    def __init__(self, config: Callable, *, client: httpx.Client | None = None):
        self._config = config
        self._client = client

    # 显示名沿当前Profile设置读取，不缓存首个账号配置。
    @property
    def display_name(self) -> str:
        return str(self._config("display_name", "") or "UniSearch")

    # 只接受已支持后端与安全服务地址，防止凭证形参数进入请求。
    def _route(self) -> tuple[str, str]:
        backend = str(self._config("backend", "tencent") or "bocha").lower()
        if backend not in ENDPOINTS:
            raise ValueError("UniSearch 后端配置无效")
        endpoint = str(self._config("url", "") or ENDPOINTS[backend])
        parsed = urlsplit(endpoint)
        if (
            (
                parsed.scheme != "https"
                and not (
                    parsed.scheme == "http"
                    and parsed.hostname in {"127.0.0.1", "localhost"}
                )
            )
            or parsed.username
            or parsed.password
            or parsed.fragment
            or sensitive_query_param_name(endpoint)
        ):
            raise ValueError("UniSearch 服务地址无效")
        return backend, endpoint

    # 凭证在调用时从当前Profile作用域读取，不保存到配置或实例。
    def _key(self) -> str:
        return get_secret("DESKTOP_MT_MAAS_API_KEY") or ""

    # 按当前Profile判断能力，不在发现阶段准备第三方运行资源。
    def is_available(self) -> bool:
        return bool(self._key())

    # 沿原生设置入口声明能力，不额外要求用户填写套餐凭证。
    def get_setup_schema(self) -> dict:
        return {
            "name": self.display_name,
            "badge": "MaaS",
            "tag": "元景账号提供搜索服务",
            "env_vars": [],
        }

    # 当前Profile内执行搜索，独立缓存且不向其他服务发送失败请求。
    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        metadata = {
            "provider": self.name,
            "provider_display_name": "UniSearch",
            "query": query,
        }
        key = self._key()
        if not key:
            return {
                **metadata,
                "success": False,
                "error": "UniSearch 缺少元景套餐凭证，请刷新套餐或重新登录。",
            }
        try:
            backend, endpoint = self._route()
        except ValueError:
            return {
                **metadata,
                "success": False,
                "error": "UniSearch 服务地址或后端配置无效，请刷新搜索配置。",
            }
        memo_key = cache.identity(self.name, backend, endpoint, key, query, limit)
        previous = cache.get(memo_key, self._config)
        if previous is not None:
            return previous
        count = min(max(int(limit), 1), 50)
        payload = (
            {"query": query, "count": count, "summary": True}
            if backend == "bocha"
            else {
                "Query": _strip_redundant_modifiers(query),
                "Mode": 2,
                "Cnt": next(n for n in (10, 20, 30, 40, 50) if n >= count),
            }
        )
        try:
            if self._client is not None:
                raw = self._request(self._client, endpoint, key, payload)
            else:
                with httpx.Client(timeout=30, follow_redirects=False) as client:
                    raw = self._request(client, endpoint, key, payload)
            result = (
                self._bocha(raw, count)
                if backend == "bocha"
                else self._tencent(raw, count)
            )
            return cache.put(memo_key, {**result, **metadata}, self._config)
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
            # HTTP exception strings contain the configured URL; keep credentials and endpoints out of errors.
            if isinstance(exc, httpx.HTTPStatusError):
                message = f"UniSearch 请求失败（HTTP {exc.response.status_code}）"
            elif isinstance(exc, httpx.TimeoutException):
                message = "UniSearch 请求超时"
            else:
                message = "UniSearch 网络或响应异常，请稍后重试"
            return {**metadata, "success": False, "error": message}

    # 只对临时网络／限流／服务故障有限重试，不跨服务兜底。
    @staticmethod
    def _request(client, endpoint, key, payload):
        for attempt in range(3):
            try:
                response = client.post(
                    endpoint,
                    headers={"Authorization": f"Bearer {key}"},
                    json=payload,
                    timeout=30,
                )
                response.raise_for_status()
                raw = response.json()
                if not isinstance(raw, dict):
                    raise ValueError("Invalid response")
                return raw
            except (
                httpx.ConnectError,
                httpx.TimeoutException,
                httpx.HTTPStatusError,
            ) as exc:
                transient = (
                    not isinstance(exc, httpx.HTTPStatusError)
                    or exc.response.status_code == 429
                    or exc.response.status_code >= 500
                )
                if not transient or attempt == 2:
                    raise
                time.sleep(2**attempt)

    # 筛选有效网页结果，保持Bocha响应字段与原生输出兼容。
    @staticmethod
    def _bocha(raw, limit):
        if raw.get("code") != 200:
            return {
                "success": False,
                "error": f"UniSearch 服务错误（{raw.get('code', '?')}）",
            }
        data = raw.get("data") or {}
        images = {
            i.get("hostPageUrl"): i
            for i in (data.get("images") or {}).get("value", [])
            if isinstance(i, dict)
        }
        hits = []
        for item in (data.get("webPages") or {}).get("value", []):
            url = item.get("url", "")
            if not _web_url(url):
                continue
            image = images.get(url, {})
            hits.append({
                "title": item.get("name", ""),
                "url": url,
                "description": item.get("summary") or item.get("snippet", ""),
                "date": item.get("datePublished"),
                "image_url": image.get("contentUrl"),
                "image_title": image.get("name"),
                "position": len(hits) + 1,
            })
        return {"success": True, "data": {"web": hits[:limit], "cards": []}}

    # 腾讯网页与结构化卡片分开规范化，异常单卡不丢失其他结果。
    @staticmethod
    def _tencent(raw, limit):
        if raw.get("code") not in (None, 0, 200):
            return {
                "success": False,
                "error": f"UniSearch 服务错误（{raw.get('code')}）",
            }
        response = raw.get("Response")
        if not isinstance(response, dict):
            raise ValueError("Missing Response")
        if response.get("Error"):
            return {
                "success": False,
                "error": "UniSearch 上游搜索失败，请检查套餐权限或稍后重试。",
            }
        hits, cards, texts = [], [], []
        for page in response.get("Pages") or []:
            try:
                item = json.loads(page)
            except (ValueError, TypeError):
                continue
            if not isinstance(item, dict):
                continue
            if item.get("vr"):
                category = item.get("vr_category")
                if not isinstance(category, str) or not category:
                    category = "unknown"
                try:
                    title, text = _serialize_vr_card({**item, "vr_category": category})
                    canonical = _CANONICAL_EXTRACTORS.get(category)
                    normalized = canonical(item) if canonical else None
                except (TypeError, ValueError, KeyError, AttributeError):
                    title, text, normalized = (
                        category,
                        str(item.get("passage") or "")[:2000],
                        None,
                    )
                texts.append({"title": title, "text": text})
                # Only UI data crosses the wire; full vendor records can exhaust the tool-result budget.
                display_data = {"_canonical": normalized} if normalized else {}
                if category == "weather" and normalized is None:
                    display_data["jsonData"] = item.get("jsonData") or {}
                cards.append({"type": category, "raw": display_data})
            elif _web_url(item.get("url")):
                hits.append({
                    "title": item.get("title", ""),
                    "url": item["url"],
                    "description": item.get("content") or item.get("passage", ""),
                    "date": item.get("date"),
                    "image_url": (item.get("images") or [None])[0],
                    "position": len(hits) + 1,
                })
        return {
            "success": True,
            "data": {"web": hits[:limit], "cards": cards, "card_text": texts},
        }


# 搜索引用仅保留无嵌入凭证的HTTP网页地址。
def _web_url(value) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and not parsed.username
        and not parsed.password
    )
