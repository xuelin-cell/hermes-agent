"""Adapters for native web_extract; credentials stay in the served profile."""

from __future__ import annotations
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import httpx
from agent.secret_scope import get_secret
from agent.web_search_provider import WebSearchProvider
from hermes_constants import get_hermes_home
from .. import cache
from .validation import validate_url

UNICRAWL_URL = (
    "https://maas-api.ai-yuanjing.com/openapi/v1/uniclaw/general/tool/firecrawl"
)


class FetchProvider(WebSearchProvider):
    # 注入按Profile读取的配置与传输，发现阶段不启动抓取资源。
    def __init__(self, config, *, client=None):
        self._config = config
        self._client = client

    # 抓取后端不参与搜索选择，避免错误路由。
    def supports_search(self):
        return False

    # 声明抓取能力，复用现有web_extract入口。
    def supports_extract(self):
        return True

    # 各URL独立返回结果，取消继续传播，失败不进入原生救援。
    async def extract(self, urls, **kwargs):
        # Native wrapper supplies a shared total deadline; each worker is reaped on cancel.
        semaphore = asyncio.Semaphore(2)

        # 单页先校验地址与凭证，再访问隔离缓存或实际服务。
        async def one(url):
            async with semaphore:
                error = validate_url(url)
                if error:
                    return self._error(url, "抓取地址不安全或格式无效")
                key = self._key()
                if self.name == "unicrawl" and not key:
                    return self._error(
                        url, "UniCrawl 缺少元景套餐凭证，请刷新套餐或重新登录。"
                    )
                memo_key = cache.identity(
                    self.name, UNICRAWL_URL if key else "", key, url
                )
                previous = cache.get(memo_key, self._config)
                if previous is not None:
                    return previous["data"]
                try:
                    value = await self._fetch(url, key)
                    value["metadata"] = {
                        **value.get("metadata", {}),
                        "provider": self.name,
                    }
                    cache.put(memo_key, {"success": True, "data": value}, self._config)
                    return value
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if isinstance(exc, httpx.HTTPStatusError):
                        message = f"{self.display_name} 请求失败（HTTP {exc.response.status_code}）"
                    else:
                        message = f"{self.display_name} 抓取失败，请检查网页是否可访问或稍后重试。"
                    return self._error(url, message)

        return await asyncio.gather(*(one(url) for url in urls))

    # 本机抓取默认不取凭证，远端实现才读取当前Profile秘密。
    def _key(self):
        return ""

    # 错误结果保留URL顺序及后端身份，不附带原始异常或凭证。
    def _error(self, url, message):
        return {
            "url": url,
            "title": "",
            "content": "",
            "error": message,
            "metadata": {"provider": self.name},
        }


class BuiltinParseProvider(FetchProvider):
    name = "builtin_parse"
    display_name = "BuiltinCrawl"

    # 发现阶段不导入第三方解析器或启动浏览器。
    def is_available(self):
        # Third-party imports are lazy in a profile-scoped worker, never at discovery time.
        return True

    # 剥离凭证的Profile子进程运行本机解析，取消时回收。
    async def _fetch(self, url, key):
        from tools.environments.local import served_profile_child_env

        env = served_profile_child_env(
            target_home=get_hermes_home(), inherit_credentials=False
        )
        env.pop("DESKTOP_MT_MAAS_API_KEY", None)
        import hermes_constants

        # The PM bootstrap selects this profile's dependency environment before any engine imports.
        runner = "import hermes_bootstrap, runpy, sys; runpy.run_path(sys.argv[1], run_name='__main__')"
        child = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            runner,
            str(Path(__file__).with_name("worker.py")),
            cwd=str(Path(hermes_constants.__file__).resolve().parent),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        request = {
            "url": url,
            "allowed_hosts": self._config("fetch_allowed_hosts", []),
            "blocked_hosts": self._config("fetch_blocked_hosts", []),
        }
        try:
            stdout, _ = await asyncio.wait_for(
                child.communicate(json.dumps(request).encode()), timeout=115
            )
            if child.returncode or len(stdout) > 15 * 1024 * 1024:
                raise ValueError("worker failed")
            value = json.loads(stdout)
            if not isinstance(value, dict) or not value.get("content"):
                raise ValueError("empty worker result")
            return value
        finally:
            if child.returncode is None:
                # Let the worker close Chromium before a bounded hard stop.
                child.terminate()
                try:
                    await asyncio.wait_for(child.wait(), timeout=3)
                except TimeoutError:
                    child.kill()
                    await child.wait()


class UniCrawlProvider(FetchProvider):
    name = "unicrawl"
    display_name = "UniCrawl"

    # 凭证在调用时从当前Profile作用域读取，不保存到配置或实例。
    def _key(self):
        return get_secret("DESKTOP_MT_MAAS_API_KEY") or ""

    # 按当前Profile判断能力，不在发现阶段准备第三方运行资源。
    def is_available(self):
        return bool(self._key())

    # 远端请求禁自动重定向及继承代理，凭证仅用于请求头。
    async def _fetch(self, url, key):
        # No credential is put into the configured endpoint, arguments or returned metadata.
        if self._client is not None:
            return await self._request(self._client, url, key)
        async with httpx.AsyncClient(
            timeout=30, follow_redirects=False, trust_env=False
        ) as client:
            return await self._request(client, url, key)

    # 只对临时网络／限流／服务故障有限重试，不跨服务兜底。
    async def _request(self, client, url, key):
        for attempt in range(3):
            try:
                response = await client.post(
                    UNICRAWL_URL,
                    headers={"Authorization": f"Bearer {key}"},
                    json={
                        "url": url,
                        "onlyMainContent": False,
                        "maxAge": 172800000,
                        "formats": ["markdown"],
                    },
                )
                response.raise_for_status()
                raw = response.json()
                if raw.get("success") is False:
                    raise ValueError("upstream rejected")
                data = raw.get("data") or {}
                text = raw.get("content") or data.get("markdown")
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("empty upstream result")
                metadata = raw.get("metadata") or data.get("metadata") or {}
                from .markdown import strip_links_and_images

                return {
                    "url": metadata.get("sourceURL") or url,
                    "title": metadata.get("title", ""),
                    "content": strip_links_and_images(text),
                    "raw_content": text,
                }
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
                await asyncio.sleep(2**attempt)
