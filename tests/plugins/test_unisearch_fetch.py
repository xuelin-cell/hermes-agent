"""Native dispatch/config boundaries, not vendor-only stubs."""

import asyncio
import json
from pathlib import Path
import shutil
import sys
import httpx
import pytest
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from agent.secret_scope import set_secret_scope, reset_secret_scope
from .test_unisearch import load_package, SOURCE, allow_user_tool_override

load_package()
from unisearch_test_plugin.fetch.providers import UniCrawlProvider, BuiltinParseProvider


# 远端抓取按账号与凭证隔离，轮换／撤销后重新鉴权。
@pytest.mark.asyncio
async def test_unicrawl_scope_cache_rotation_revocation_and_payload(tmp_path):
    settings = {}
    calls = []

    # 只替代外部HTTP响应，保留原生解析与调度。
    def respond(request):
        calls.append((request.headers["authorization"], json.loads(request.content)))
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "markdown": "# Main\n[link](https://example.com)\n![img](https://example.com/x.png)",
                    "metadata": {"title": "Main"},
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = UniCrawlProvider(lambda k, d=None: settings.get(k, d), client=client)
        for name, key in [
            ("a", "fake-a"),
            ("b", "fake-b"),
            ("a", "fake-a"),
            ("a", "fake-new"),
            ("a", ""),
        ]:
            home = tmp_path / name
            home.mkdir(exist_ok=True)
            ht = set_hermes_home_override(home)
            st = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": key}, profile_home=home)
            try:
                value = (await provider.extract(["https://example.com/article"]))[0]
                if key:
                    assert (
                        value["metadata"]["provider"] == "unicrawl"
                        and value["title"] == "Main"
                    )
                    assert (
                        "[link]" not in value["content"]
                        and "![img]" not in value["content"]
                    )
                else:
                    assert value["error"] and not value["content"]
            finally:
                reset_secret_scope(st)
                reset_hermes_home_override(ht)
    assert [c[0] for c in calls] == [
        "Bearer fake-a",
        "Bearer fake-b",
        "Bearer fake-new",
    ]
    assert calls[0][1] == {
        "url": "https://example.com/article",
        "onlyMainContent": False,
        "maxAge": 172800000,
        "formats": ["markdown"],
    }


# 临时故障可有限重试，单页失败和私网拒绝保持独立。
@pytest.mark.asyncio
async def test_unicrawl_partial_errors_retry_and_private_urls(monkeypatch):
    from unisearch_test_plugin import cache

    settings = {"cache_enabled": False}
    attempts = []

    # 省去测试退避等待，重试次数与状态判断仍执行真实逻辑。
    async def no_wait(delay):
        pass

    monkeypatch.setattr(asyncio, "sleep", no_wait)

    # 只替代外部HTTP响应，保留原生解析与调度。
    def respond(request):
        attempts.append(request)
        if len(attempts) < 3:
            return httpx.Response(429)
        if json.loads(request.content)["url"].endswith("forbidden"):
            return httpx.Response(403)
        return httpx.Response(200, json={"content": "Readable article"})

    st = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": "fake-key"})
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = UniCrawlProvider(
                lambda k, d=None: settings.get(k, d), client=client
            )
            result = await provider.extract(["https://example.com/article"])
            assert result[0]["content"] == "Readable article" and len(attempts) == 3
            result = await provider.extract(
                [
                    "https://example.com/forbidden",
                    "http://127.0.0.1/admin",
                ]
            )
            assert "403" in result[0]["error"] and result[1]["error"]
            assert len(attempts) == 4
            assert "fake-key" not in json.dumps(result)
    finally:
        reset_secret_scope(st)


# 两个抓取后端沿原生入口调度，不误走搜索逻辑。
@pytest.mark.parametrize("fetch_backend", ["builtin_parse", "unicrawl"])
def test_native_extract_dispatch_and_default_do_not_fall_into_search(
    monkeypatch, tmp_path, fetch_backend
):
    from hermes_cli.plugins import discover_plugins
    from hermes_cli.config import load_config
    import socket

    # 只控制外部 DNS 答案，保留原生 URL 安全检查与调度。
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *a, **kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port or 443))
        ],
    )
    from model_tools import handle_function_call

    _, configure = load_package()
    shutil.copytree(SOURCE, tmp_path / "plugins/unisearch")
    ht = set_hermes_home_override(tmp_path)
    st = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": "fake-key"})
    try:
        configure.apply(None)
        assert load_config()["web"]["extract_backend"] == "builtin_parse"
        configure.apply({"fetch_provider": fetch_backend})
        allow_user_tool_override()
        discover_plugins(force=True)
        from agent.web_search_registry import get_provider

        selected = get_provider(fetch_backend)
        calls = []

        # 当前策略与总预算内获取页面，安全拒绝不通过其他引擎绕行。
        async def fetch(url, key):
            calls.append((url, key))
            return {
                "url": url,
                "title": "Article",
                "content": "Real provider/native tool wrapper boundary works.",
                **(
                    {"fetch_status": "usable", "engine": "http", "reasons": []}
                    if fetch_backend == "builtin_parse"
                    else {}
                ),
            }

        monkeypatch.setattr(selected, "_fetch", fetch)
        value = json.loads(
            handle_function_call(
                "web_extract", {"urls": ["https://example.com/article"]}
            )
        )
        assert value["provider"] == fetch_backend, value
        assert value["results"][0]["content"] and not value["results"][0]["error"]
        assert len(calls) == 1
        assert "search-only" not in json.dumps(value)
        assert load_config()["web"]["search_backend"] == "unisearch"
    finally:
        reset_secret_scope(st)
        reset_hermes_home_override(ht)


# 真实子进程继承目标Home，不能携带启动账号的凭证。
@pytest.mark.asyncio
async def test_builtin_worker_environment_uses_served_home_without_launch_credentials(
    monkeypatch, tmp_path
):
    home = tmp_path / "b"
    home.mkdir()
    monkeypatch.setenv("DESKTOP_MT_MAAS_API_KEY", "launch-fake-a")
    ht = set_hermes_home_override(home)
    st = set_secret_scope({}, profile_home=home)
    original_spawn = asyncio.create_subprocess_exec
    captured = []

    # 真实子进程只读取测试环境，验证跨进程账号与凭证边界。
    async def spawn(*args, **kwargs):
        captured.append(kwargs["env"])
        # A real child proves the environment that crossed the process boundary.
        script = "import os,json; print(json.dumps({'url':'https://example.com','content':os.environ['HERMES_HOME'],'fetch_status':'usable','engine':'http','reasons':[],'metadata':{'key':os.environ.get('DESKTOP_MT_MAAS_API_KEY','')}}))"
        return await original_spawn(sys.executable, "-c", script, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    try:
        value = await BuiltinParseProvider(lambda k, d=None: d)._fetch(
            "https://example.com", ""
        )
        assert value["content"] == str(home) and not value["metadata"]["key"]
        assert captured[0]["HERMES_HOME"] == str(home)
    finally:
        reset_secret_scope(st)
        reset_hermes_home_override(ht)


# 真实HTTP与无窗口浏览器补抓保留内网页面请求拦截。
@pytest.mark.skipif(sys.platform != "darwin", reason="macOS native Chromium fixture")
@pytest.mark.asyncio
async def test_real_http_then_headless_browser_dynamic_fallback_and_subresource_guard(
    monkeypatch,
):
    from unisearch_test_plugin.fetch.builtin_parse import BuiltinParseFetchProvider
    from unisearch_test_plugin.fetch.builtin.http import HttpEngine
    from unisearch_test_plugin.fetch.builtin.browser import BrowserEngine
    from unisearch_test_plugin.fetch.builtin.security import NetworkPolicy
    import os, pwd

    browser_cache = (
        Path(pwd.getpwuid(os.getuid()).pw_dir) / "Library/Caches/ms-playwright"
    )
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(browser_cache))
    # 测试浏览器通过Playwright公开路径取得，再交给Hermes原生显式覆盖入口。
    from playwright.async_api import async_playwright

    async with async_playwright() as driver:
        monkeypatch.setenv(
            "AGENT_BROWSER_EXECUTABLE_PATH", driver.chromium.executable_path
        )

    # 本机夹具只提供静态或动态页面，不访问真实站点。
    async def page(reader, writer):
        request = await reader.readuntil(b"\r\n\r\n")
        path = request.split(b" ")[1]
        if path == b"/static":
            html = (
                "<html><title>Static</title><article><h1>Static</h1><p>"
                + "A substantial readable article with enough useful details. " * 20
                + "</p></article></html>"
            )
        else:
            html = """<html><body><div id="root"></div><script>setTimeout(()=>{document.querySelector('#root').innerHTML='<article><h1>Dynamic</h1><p>DYNAMIC_RENDER_TOKEN</p></article>';fetch('http://127.0.0.1:9/private').catch(()=>{document.body.innerHTML+='<p>PRIVATE_REQUEST_BLOCKED</p>'})},150)</script></body></html>"""
        body = html.encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(page, "127.0.0.1", 0)
    base = "http://127.0.0.1:" + str(server.sockets[0].getsockname()[1])

    class FixturePolicy(NetworkPolicy):
        # 域名白名单不放宽私网禁令，解析到任一非公网地址即拒绝。
        async def validate(self, url):
            # Test-only local server exception; all other URLs use production policy.
            if url.startswith(base + "/"):
                return url
            return await super().validate(url)

    policy = FixturePolicy()
    provider = BuiltinParseFetchProvider(timeout=20)
    provider._http = HttpEngine(policy, timeout=20, max_response_bytes=1024 * 1024)
    provider._browser = BrowserEngine(policy)
    try:
        static = await provider.fetch(base + "/static")
        assert static.title == "Static" and "substantial readable" in static.content
        dynamic = await provider.fetch(base + "/dynamic")
        assert "DYNAMICRENDERTOKEN" in dynamic.content.replace("\\", "").replace(
            "_", ""
        )
        assert "PRIVATEREQUESTBLOCKED" in (
            await provider._browser.render(base + "/dynamic", deadline_seconds=10)
        ).html.replace("_", "")
    finally:
        await provider.aclose()
        server.close()
        await server.wait_closed()


# PM能从发行候选读取依赖声明，无需改核心发现逻辑。
def test_pm_resolves_bundled_candidate_declarations_without_core_changes():
    from pm.publication import candidate_members
    from pm.plugin_declarations import read_python_declaration

    members = candidate_members([SOURCE])
    assert SOURCE in members
    specs = read_python_declaration(SOURCE).requirements
    assert any(s.startswith("playwright") for s in specs)
    assert any(s.startswith("trafilatura") for s in specs)
