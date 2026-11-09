"""Real local HTTP, Chromium, worker and native tool output without account state."""

import asyncio
import json
from pathlib import Path
import shutil
import socket
import time

import pytest

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from .test_unisearch import load_package, SOURCE, allow_user_tool_override


# 真实子进程只替换夹具网络边界，抓取/解析/序列化/缓存/原生整理均走生产代码。
@pytest.mark.platforms("macos")
@pytest.mark.asyncio
async def test_worker_browser_and_native_output_keep_routes_status_and_profile_scope(
    monkeypatch, tmp_path
):
    from playwright.async_api import async_playwright
    from hermes_cli.plugins import discover_plugins
    from model_tools import handle_function_call
    from agent.web_search_registry import get_provider
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from agent.tool_dispatch_helpers import make_tool_result_message

    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / "Library/Caches/ms-playwright")
    )
    async with async_playwright() as driver:
        executable = driver.chromium.executable_path
    if not Path(executable).is_file():
        pytest.skip("Installed Chromium fixture required")
    _, configure = load_package()

    slow_requests = 0

    # 每个端点返回固定内容；路由内容必须由真实浏览器运行脚本后出现。
    async def serve(reader, writer):
        nonlocal slow_requests
        request = await reader.readuntil(b"\r\n\r\n")
        target = request.split(b" ")[1].decode()
        if "/slow" in target:
            slow_requests += 1
            if slow_requests > 1:
                # 浏览器导航收不到响应，直到生产超时关闭连接；不留下后台睡眠。
                await reader.read()
                writer.close()
                await writer.wait_closed()
                return
            html = "<main><p>SLOWCANDIDATE is useful static text.</p><p>Loading...</p></main>"
        elif "/repository" in target:
            rows = ''.join(f'<tr><td><a href="/file/{i}">module{i}.py</a></td><td>Updated source module {i}</td></tr>' for i in range(80))
            html = '<main><table>'+rows+'</table><article><h1>Repository overview</h1><p>READMETOKEN is the actual project introduction with installation instructions and supported functionality.</p><p>Install the package and configure its local runtime before using this project.</p></article></main>'
        elif "/route" in target:
            html = """<html><main><p>Homepage is not the requested article.</p></main><script>
            document.querySelector('main').innerHTML='<h1>Article</h1><p>ROUTE'+location.hash.slice(2).toUpperCase()+' unique article body.</p>';
            </script></html>"""
        elif "/interactive" in target:
            html = (
                "<main><h1>Reviews</h1>"
                + "".join(
                    f"<p>STATIC{i} is a server rendered paragraph with substantial useful information and detailed context for readers.</p>"
                    for i in range(4)
                )
                + """<button type="button">Load more</button></main><script>
            document.querySelector('main').innerHTML=`<h1>Reviews</h1><p>READSTART is the first visible review.</p><section id="extra"></section><button type="button" onclick="document.querySelector('#extra').innerHTML='<p>READMORE is loaded by the real button click.</p>';this.remove()">Load more</button>`;
            </script>"""
            )
        elif "/linkswap" in target:
            html = """<main><p>Products currently available for reading.</p><a id="item" href="/item-a">View details</a><button type="button" onclick="document.querySelector('#item').href='/item-b'">Load more</button></main>"""
        elif "/login-article" in target:
            html = """<title>Login</title><article><h1>Login</h1><p>LOGINARTICLE explains how the authorization code is exchanged for a session and describes the protocol.</p><p>The application uses a short lived code to configure the session. This article gives the implementation details.</p><table><tr><td>code</td><td>Authorization code</td></tr></table></article>"""
        elif "/long-check" in target:
            html = """<title>Security check</title><main><p>Checking your browser before accessing this website. Please wait while we verify that your connection is secure.</p><div id="cf-chl-widget">Security verification in progress. JavaScript challenge is being prepared.</div></main>"""
        elif "/hidden-context" in target:
            html = """<main><p>INITIAL useful article body with stable information and enough detail to read independently.</p><p>Another paragraph describes the topic and gives practical instructions for readers.</p><section id="loading"><span>Loading...</span><span hidden>Decorative loader text</span></section><section id="extra"></section></main><script>setTimeout(()=>{document.querySelector('#loading').remove();document.querySelector('#extra').innerHTML='<p>HIDDENFOLLOWUP content arrived after loading.</p>'},1500)</script>"""
        elif "/unknown-context" in target:
            html = """<main><p>UNKNOWNINITIAL useful article body with stable information and enough detail to read independently.</p><p>Another paragraph describes the topic and gives practical instructions for readers.</p><section id="state"><span>Loading...</span><span style="display:none;display:-moz-box">Decoration</span></section><section id="extra"></section></main><script>setTimeout(()=>{document.querySelector('#state').remove();document.querySelector('#extra').innerHTML='<p>UNKNOWNFOLLOWUP content arrived after loading.</p>'},1500)</script>"""
        elif "/vendor-display" in target:
            html = """<main aria-busy="true" style="display:none;display:-webkit-box"><p>VENDORINITIAL useful article body with stable information and enough detail to read independently.</p><p>Another paragraph describes the topic and gives practical instructions for readers.</p><section id="extra"></section></main><script>setTimeout(()=>{document.querySelector('main').setAttribute('aria-busy','false');document.querySelector('#extra').innerHTML='<p>VENDORFOLLOWUP content arrived after loading.</p>'},1500)</script>"""
        elif "/invalid-style" in target:
            html = """<main><p>INVALIDSTYLE complete readable article body with stable information and enough detail for readers.</p><p>This second paragraph contains all the remaining information needed to understand this topic.</p><div aria-busy="true" style="display:none;display:bogus!important">Loading...</div></main>"""
        elif "/loading-noise" in target:
            html = """<main><h2>Loading</h2><p><strong>Loading</strong> is the first phase of resource retrieval.</p><p>NOISETOKEN complete article with enough useful information for readers to understand the topic and follow the instructions.</p><p>This second paragraph contains stable and complete information, with no dynamic content required to read the article.</p><section hidden><div aria-busy="true">Loading...</div></section><blockquote><p aria-busy="true">Loading...</p></blockquote></main>"""
        elif "/quoted-error" in target:
            html = """<title>404 Not Found</title><article><h1>404 Not Found</h1><p>QUOTEDARTICLE explains routing and response handling for missing resources, with working examples for application developers.</p><p>This documentation describes how applications choose the correct response and keep their routing configuration consistent.</p><p><code>The requested page is not available.</code> is only an example message.</p><blockquote><p>The requested page is not available.</p></blockquote></article>"""
        elif "/soft404" in target:
            html = """<title>404 Not Found</title><main><h1>404 Not Found</h1><p>The requested page is not available. The address may have changed or the page may have been removed from this website.</p><p>Please check the address and try again, or return to the home page to find another resource. Contact support if the problem persists.</p></main>"""
        elif "/scroll-later" in target:
            html = """<main role="feed"><p>SCROLLSTART already loaded content.</p><div style="height:2300px"></div><section id="extra"></section></main><script>window.loaded=false;addEventListener('scroll',()=>{if(!window.loaded && scrollY>1000){window.loaded=true;document.querySelector('#extra').innerHTML='<p>SCROLLLATER appears after crossing loaded content.</p>'}})</script>"""
        elif "/initial-busy" in target:
            html = """<div id="app" aria-busy="true" style="display:none;display:block"><main><p>WAITSTART useful initial content.</p><section id="extra"></section></main></div><script>setTimeout(()=>{document.querySelector('#app').setAttribute('aria-busy','false');document.querySelector('#extra').innerHTML='<p>WAITFINISHED content arrived while waiting.</p>'},2000)</script>"""
        elif "/blocked" in target:
            html = "<main><p>STATICCANDIDATE must not bypass a security refusal.</p><p>Loading...</p></main><script>location.href='http://127.0.0.1/forbidden';</script>"
        elif "/partial" in target:
            html = '<main><p>PARTIALTOKEN useful article text.</p><p style="display:var(--missing, none)">UNCERTAINBODY</p><p>Loading...</p></main>'
        elif "/challenge" in target:
            html = '<title>Verify you are human</title><style>.hidden{display:none}</style><main><h1>Verify you are human</h1><p>Please complete the security check.</p><section class="hidden"><p>HIDDENGATEBODY a long document paragraph giving implementation details, enough to confuse quality decisions from the raw DOM.</p><p>Additional hidden paragraph with detailed instructions and examples for application developers and advanced readers.</p></section></main>'
        else:
            html = '<base href="/docs/"><main><h1>Notice</h1><p>STATICTOKEN short notice.</p><a href="guide">Read guide</a></main>'
        body = html.encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    public = f"http://fixture.example:{port}"
    local = f"http://127.0.0.1:{port}"
    original_spawn = asyncio.create_subprocess_exec
    children = []

    # 子进程真实导入插件，仅为此本机服务器添加测试专用地址映射。
    async def spawn(*args, **kwargs):
        assert not kwargs["env"].get("DESKTOP_MT_MAAS_API_KEY")
        script = f"""
import hermes_bootstrap, importlib.util, sys, runpy
from pathlib import Path
from urllib.parse import urldefrag
root = Path(sys.argv[1]).resolve().parents[1]
spec = importlib.util.spec_from_file_location('_unisearch_worker', root/'__init__.py', submodule_search_locations=[str(root)])
pkg = importlib.util.module_from_spec(spec); sys.modules[spec.name] = pkg; spec.loader.exec_module(pkg)
from _unisearch_worker.fetch.builtin.security import NetworkPolicy
import _unisearch_worker.fetch.builtin.browser as browser
original = NetworkPolicy.validate
async def fixture_validate(self, url):
    if url.startswith({public!r}+'/'):
        return urldefrag(url.replace({public!r}, {local!r}, 1))[0]
    if url.startswith({local!r}+'/'):
        return urldefrag(url)[0]
    return await original(self, url)
NetworkPolicy.validate = fixture_validate
browser._find_chromium_executable = lambda: {executable!r}
runpy.run_path(sys.argv[1], run_name='__main__')
"""
        child = await original_spawn(args[0], "-c", script, args[3], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setenv("DESKTOP_MT_MAAS_API_KEY", "launch-secret-must-not-leak")
    # 原生URL检查仍执行，仅给受控域名提供公网DNS答复。
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *a, **kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port or 80))
        ],
    )
    counts = []
    try:
        for name in ["a", "b", "a"]:
            home = tmp_path / name
            if not home.exists():
                shutil.copytree(
                    SOURCE,
                    home / "plugins/unisearch",
                    ignore=shutil.ignore_patterns("__pycache__"),
                )
            token = set_hermes_home_override(home)
            try:
                configure.apply(None)
                allow_user_tool_override()
                discover_plugins()
                result = json.loads(
                    await asyncio.to_thread(
                        handle_function_call,
                        "web_extract",
                        {"urls": [public + "/static"]},
                    )
                )
                row = result["results"][0]
                assert (
                    "STATICTOKEN" in row["content"] and "/docs/guide" in row["content"]
                )
                assert row["fetch_status"] == "usable" and row["engine"] == "http"
                counts.append(len(children))
                if name == "b":
                    repository = json.loads(await asyncio.to_thread(
                        handle_function_call, "web_extract", {"urls": [public + "/repository"], "char_limit": 2000}
                    ))["results"][0]
                    assert "READMETOKEN" in repository["content"]
                    assert repository["fetch_status"] == "usable" and repository["engine"] == "http"
                    urls = [
                        public + "/route#/a",
                        public + "/route#/b",
                        public + "/partial",
                        public + "/challenge",
                        public + "/interactive",
                    ]
                    result = json.loads(
                        await asyncio.to_thread(
                            handle_function_call, "web_extract", {"urls": urls}
                        )
                    )
                    a, b, partial, failure, interactive = result["results"]
                    assert (
                        "READSTART" in interactive["content"]
                        and "READMORE" in interactive["content"]
                    )
                    assert interactive["fetch_status"] == "partial"
                    assert interactive["engine"] == "chromium"
                    assert interactive["browser_followup"]["needed"] is True
                    assert "ROUTEA" in a["content"] and "ROUTEB" in b["content"]
                    assert a["engine"] == b["engine"] == "chromium"
                    assert a["url"].endswith("#/a") and b["url"].endswith("#/b")
                    assert partial["fetch_status"] == "partial" and partial["reasons"]
                    assert "UNCERTAINBODY" not in partial["content"]
                    assert partial["browser_followup"]["needed"]
                    assert (
                        failure["fetch_status"] == "unavailable"
                        and failure["error"]
                        and not failure["content"]
                    )
                    # 真实工具结果经过原生包装和SQLite落盘后，仍保留质量状态。
                    payload = json.dumps(result, ensure_ascii=False)
                    db = SessionDB(home / "state.db")
                    try:
                        db.create_session("builtin-fixture", source="desktop")
                        messages = [
                            {"role": "user", "content": "Read fixture articles"},
                            {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "fetch-fixture",
                                        "type": "function",
                                        "function": {
                                            "name": "web_extract",
                                            "arguments": json.dumps({"urls": urls}),
                                        },
                                    }
                                ],
                            },
                            make_tool_result_message(
                                "web_extract", payload, "fetch-fixture"
                            ),
                        ]
                        agent = object.__new__(AIAgent)
                        agent._session_db, agent._session_db_created = db, True
                        agent.session_id, agent.platform, agent.model = (
                            "builtin-fixture",
                            "desktop",
                            "fixture",
                        )
                        agent._persist_disabled = False
                        assert (
                            agent._flush_messages_to_session_db(messages) is not False
                        )
                        saved = next(
                            row
                            for row in db.get_messages("builtin-fixture")
                            if row.get("tool_call_id") == "fetch-fixture"
                        )
                        assert (
                            payload in saved["content"]
                            and "untrusted_tool_result" in saved["content"]
                        )
                    finally:
                        db.close()
                    extra = json.loads(
                        await asyncio.to_thread(
                            handle_function_call,
                            "web_extract",
                            {
                                "urls": [
                                    public + "/linkswap",
                                    public + "/login-article",
                                    public + "/long-check",
                                    public + "/scroll-later",
                                    public + "/initial-busy",
                                ]
                            },
                        )
                    )
                    links, login_article, long_check, scrolled, waited = extra[
                        "results"
                    ]
                    assert (
                        "SCROLLLATER" in scrolled["content"]
                        and scrolled["engine"] == "chromium"
                    )
                    assert (
                        "WAITFINISHED" in waited["content"]
                        and waited["engine"] == "chromium"
                    )
                    assert "interaction_timeout" not in waited["reasons"]
                    assert (
                        waited["fetch_status"] == "partial"
                        and waited["browser_followup"]["needed"]
                    )
                    before_wait_retry = len(children)
                    await get_provider("builtin_parse").extract(
                        [public + "/initial-busy"]
                    )
                    assert len(children) == before_wait_retry + 1
                    soft = json.loads(
                        await asyncio.to_thread(
                            handle_function_call,
                            "web_extract",
                            {
                                "urls": [
                                    public + "/soft404",
                                    public + "/quoted-error",
                                    public + "/loading-noise",
                                    public + "/hidden-context",
                                    public + "/invalid-style",
                                ]
                            },
                        )
                    )["results"]
                    soft, quoted, noise, hidden_context, invalid_style = soft
                    assert "HIDDENFOLLOWUP" in hidden_context["content"]
                    assert (
                        hidden_context["engine"] == "chromium"
                        and hidden_context["fetch_status"] == "partial"
                    )
                    assert hidden_context["browser_followup"]["needed"]
                    assert "interaction_timeout" not in hidden_context["reasons"]
                    assert "INVALIDSTYLE" in invalid_style["content"]
                    assert (
                        invalid_style["engine"] == "http"
                        and invalid_style["fetch_status"] == "usable"
                    )
                    assert "browser_followup" not in invalid_style
                    assert "NOISETOKEN" in noise["content"]
                    assert (
                        noise["fetch_status"] == "usable" and noise["engine"] == "http"
                    )
                    assert "browser_followup" not in noise
                    assert "QUOTEDARTICLE" in quoted["content"]
                    assert "The requested page is not available." in quoted["content"]
                    assert (
                        quoted["fetch_status"] == "usable"
                        and quoted["engine"] == "http"
                    )
                    assert soft["fetch_status"] == "unavailable" and not soft["content"]
                    vendor = json.loads(
                        await asyncio.to_thread(
                            handle_function_call,
                            "web_extract",
                            {"urls": [public + "/vendor-display"]},
                        )
                    )["results"][0]
                    assert "VENDORFOLLOWUP" in vendor["content"]
                    assert vendor["engine"] == "chromium"
                    assert vendor["fetch_status"] == "partial"
                    assert vendor["browser_followup"]["needed"]
                    assert "interaction_timeout" not in vendor["reasons"]
                    unknown = json.loads(
                        await asyncio.to_thread(
                            handle_function_call,
                            "web_extract",
                            {"urls": [public + "/unknown-context"]},
                        )
                    )["results"][0]
                    assert "UNKNOWNFOLLOWUP" in unknown["content"]
                    assert unknown["engine"] == "chromium"
                    assert unknown["fetch_status"] == "partial"
                    assert unknown["browser_followup"]["needed"]
                    assert "interaction_timeout" not in unknown["reasons"]
                    before_unknown_retry = len(children)
                    await get_provider("builtin_parse").extract(
                        [public + "/unknown-context"]
                    )
                    assert len(children) == before_unknown_retry + 1
                    before_vendor_retry = len(children)
                    await get_provider("builtin_parse").extract(
                        [public + "/vendor-display"]
                    )
                    assert len(children) == before_vendor_retry + 1
                    before_soft_retry = len(children)
                    await get_provider("builtin_parse").extract(
                        [
                            public + "/soft404",
                            public + "/quoted-error",
                            public + "/loading-noise",
                            public + "/hidden-context",
                            public + "/invalid-style",
                        ]
                    )
                    assert len(children) == before_soft_retry + 2
                    assert (
                        "/item-a" in links["content"] and "/item-b" in links["content"]
                    )
                    assert (
                        links["fetch_status"] == "partial"
                        and links["browser_followup"]["needed"]
                    )
                    assert (
                        "LOGINARTICLE" in login_article["content"]
                        and login_article["fetch_status"] == "usable"
                    )
                    assert login_article["engine"] == "http"
                    assert (
                        long_check["fetch_status"] == "unavailable"
                        and not long_check["content"]
                    )
                    before_retry = len(children)
                    await get_provider("builtin_parse").extract(
                        [
                            public + "/login-article",
                            public + "/long-check",
                        ]
                    )
                    # 合格文章命中缓存，验证页重新取页，错误结果不能作为成功缓存。
                    assert len(children) == before_retry + 1
                    blocked = (
                        await get_provider("builtin_parse").extract(
                            [public + "/blocked"]
                        )
                    )[0]
                    assert blocked["fetch_status"] == "unavailable" and blocked[
                        "reasons"
                    ] == ["policy_blocked"]
                    assert not blocked["content"]
                    started = time.monotonic()
                    timed = (
                        await get_provider("builtin_parse").extract(
                            [public + "/slow"], deadline=started + 5
                        )
                    )[0]
                    assert "SLOWCANDIDATE" in timed["content"]
                    assert (
                        timed["fetch_status"] == "partial"
                        and "render_timeout" in timed["reasons"]
                    )
                    assert time.monotonic() - started < 8
                    count = len(children)
                    await get_provider("builtin_parse").extract([public + "/partial"])
                    assert len(children) == count + 1  # partial不能阻止下一次重新抓取。
                    finished_b = len(children)
            finally:
                reset_hermes_home_override(token)
        assert counts[:2] == [1, 2]  # A、B分别创建自身worker与缓存。
        assert (
            counts[2] == finished_b == len(children)
        )  # 回到A命中原缓存，没有额外worker。
        assert all(child.returncode is not None for child in children)
    finally:
        server.close()
        await server.wait_closed()
