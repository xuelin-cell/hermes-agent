"""产品插件通过真实核心注册／调度；仅外部服务边界使用合成响应。"""

from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import socket
from types import SimpleNamespace

import httpx
import pytest
import hermes_yaml as yaml
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from agent.secret_scope import set_secret_scope, reset_secret_scope
from hermes_cli.config import atomic_config_write, get_config_path, read_user_config_raw
from hermes_cli.plugins import get_plugin_manager
from tools.registry import registry
from tools import web_tools
from tools.web_result_cache import search_memo
from tools.budget_config import BudgetConfig

SOURCE = Path(__file__).resolve().parents[2] / "apps/desktop/assets/unisearch-plugin"
OWNED = "unisearch"


@contextmanager
def active(home, key="probe-a", tavily="probe-tavily"):
    """每个调用显式绑定验证Home与合成凭据，不读取实际账号。"""
    h = set_hermes_home_override(home)
    s = set_secret_scope(
        {
            "DESKTOP_MT_MAAS_API_KEY": key,
            "TAVILY_API_KEY": tavily,
            "BRAVE_SEARCH_API_KEY": "probe-brave",
        }
        if key is not None
        else {"TAVILY_API_KEY": tavily, "BRAVE_SEARCH_API_KEY": "probe-brave"},
        profile_home=home,
    )
    try:
        yield
    finally:
        reset_secret_scope(s)
        reset_hermes_home_override(h)


@pytest.fixture(autouse=True)
def network_guard(monkeypatch):
    """阻断真实出站连接；DNS边界提供确定的公网／内网答案。"""

    # 禁止探针发出真实出站连接。
    def no_connect(*args, **kwargs):
        raise AssertionError("Real network access is forbidden in this probe")

    monkeypatch.setattr(socket.socket, "connect", no_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", no_connect)

    # 为安全检查提供确定的公网或内网DNS答案。
    def dns(host, port, *args, **kwargs):
        ip = (
            "127.0.0.1" if host in {"localhost", "private.example"} else "93.184.216.34"
        )
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 443))]

    monkeypatch.setattr(socket, "getaddrinfo", dns)


@pytest.fixture
def service(monkeypatch):
    """HTTP传输与免费服务边界替身；Provider和原生缓存／救援逻辑保持真实。"""
    state = SimpleNamespace(
        calls=[], rescues=[], fail=False, content="page body", card=False
    )

    # 按目标服务协议返回合成HTTP响应。
    def respond(request):
        body = json.loads(request.content) if request.content else {}
        host = request.url.host
        endpoint = request.url.path
        state.calls.append({"host": host, "endpoint": endpoint, "payload": body})
        if state.fail:
            return httpx.Response(400, json={"error": "probe unavailable"})
        if host == "api.search.brave.com":
            return httpx.Response(
                200,
                json={
                    "web": {
                        "results": [
                            {
                                "url": "https://example.com/brave",
                                "title": "Brave native",
                                "description": "native result",
                            }
                        ]
                    }
                },
            )
        if host == "api.tavily.com":
            if endpoint.endswith("/extract"):
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {"url": u, "raw_content": state.content, "title": "native"}
                            for u in body["urls"]
                        ]
                    },
                )
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://example.com/native",
                            "title": "native",
                            "content": "native result",
                        }
                    ]
                },
            )
        if endpoint.endswith("/firecrawl"):
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "markdown": state.content,
                        "metadata": {"sourceURL": body["url"], "title": "suite fetch"},
                    },
                },
            )
        key_tag = hashlib.sha256(
            request.headers.get("authorization", "").encode()
        ).hexdigest()[:6]
        if "bocha" in endpoint:
            return httpx.Response(
                200,
                json={
                    "code": 200,
                    "data": {
                        "webPages": {
                            "value": [
                                {
                                    "name": key_tag,
                                    "url": "https://example.com/search",
                                    "summary": "suite result",
                                }
                            ]
                        }
                    },
                },
            )
        pages = [
            json.dumps({
                "url": "https://example.com/search",
                "title": key_tag,
                "content": "suite result",
            })
        ]
        if state.card:
            pages.append(
                json.dumps({
                    "vr": True,
                    "vr_category": "unknown",
                    "passage": "probe structured card",
                })
            )
        return httpx.Response(200, json={"code": 0, "Response": {"Pages": pages}})

    transport = httpx.MockTransport(respond)
    client_cls = httpx.Client
    async_cls = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "Client", lambda **kw: client_cls(transport=transport, **kw)
    )
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: async_cls(transport=transport, **kw)
    )
    monkeypatch.setattr(
        httpx, "post", lambda url, **kw: client_cls(transport=transport).post(url, **kw)
    )
    monkeypatch.setattr(
        httpx, "get", lambda url, **kw: client_cls(transport=transport).get(url, **kw)
    )
    from plugins.web import keyless_mcp

    # 仅替代免费搜索服务边界以记录原生救援决定。
    def rescue_search(origin, query, limit):
        state.rescues.append(("search", origin))
        return {
            "success": True,
            "data": {
                "web": [
                    {
                        "url": "https://example.com/rescued",
                        "title": "rescue",
                        "description": "rescue",
                    }
                ]
            },
        }

    # 仅替代免费抓取服务边界以记录原生救援决定。
    def rescue_extract(origin, urls):
        state.rescues.append(("extract", origin))
        return [{"url": u, "title": "rescue", "content": "rescued page"} for u in urls]

    monkeypatch.setattr(keyless_mcp, "search_with_failover", rescue_search)
    monkeypatch.setattr(keyless_mcp, "extract_with_failover", rescue_extract)
    return state


@pytest.fixture
def homes(tmp_path):
    """通过真实PluginManager加载验证副本，而非伪造ctx或registry。"""
    created = []

    # 为用例准备临时Home、显式授权及真实插件加载。
    def make(
        name="a", search="unisearch", extract="builtin_parse", allow=True, flags=True
    ):
        home = tmp_path / name
        home.mkdir(exist_ok=True)
        shutil.copytree(SOURCE, home / "plugins/unisearch", dirs_exist_ok=True)
        cfg = {
            "plugins": {
                "enabled": ["unisearch"],
                "entries": {
                    "unisearch": {
                        "allow_tool_override": allow,
                        "settings": {"backend": "tencent"},
                    }
                },
            },
            "web": {"search_backend": search, "extract_backend": extract},
        }
        if flags is not None:
            cfg["web"].update(cache_enabled=flags, keyless_rescue=flags)
        (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
        with active(home):
            search_memo.clear()
            manager = get_plugin_manager()
            manager.discover_and_load(force=True)
            loaded = manager._plugins.get("unisearch")
            if loaded and loaded.enabled:
                from hermes_cli.plugins import PluginContext

                ctx = PluginContext(manifest=loaded.manifest, manager=manager)

                # 通过公开钩子注册测试策略，不读取或改写插件源码。
                def before_tool(tool_name, **kwargs):
                    """让原生前置钩子消费合成阻止决定。"""
                    if ctx.get_config("probe_block_tools", False):
                        return {"action": "block", "message": "blocked by probe hook"}

                ctx.register_hook("pre_tool_call", before_tool)
        created.append(home)
        return home

    yield make
    for home in reversed(created):
        with active(home):
            get_plugin_manager().unload()


def invoke(home, name, args, **context):
    """执行原生模型工具入口；没有模型API调用。"""
    from model_tools import handle_function_call

    with active(home, **context):
        return json.loads(handle_function_call(name, args))


def mutate(home, fn):
    """测试配置变更走原生锁／原子写入口。"""
    with active(home):
        cfg = read_user_config_raw()
        fn(cfg)
        atomic_config_write(get_config_path(), cfg)


def test_override_preserves_native_metadata_and_budgets(homes):
    """覆盖项保留原生完整注册契约，模型预算放大或缩小时仍遵守原上限。"""
    fixed = homes()
    original = registry.snapshot_registration("web_search")
    cap = original.max_result_size_chars
    assert cap is not None and cap > 0
    with active(fixed):
        entry = registry.get_entry("web_search")
        assert entry is not original
        for attr in (
            "schema",
            "toolset",
            "check_fn",
            "requires_env",
            "is_async",
            "description",
            "emoji",
            "max_result_size_chars",
            "dynamic_schema_overrides",
        ):
            assert getattr(entry, attr) == getattr(original, attr)
        assert (
            BudgetConfig(default_result_size=cap * 2).resolve_threshold("web_search")
            == cap
        )
        assert (
            BudgetConfig(default_result_size=cap // 4).resolve_threshold("web_search")
            == cap // 4
        )
    assert original.max_result_size_chars == cap


# 验证用户插件未经授权时保留原生注册。
def test_missing_override_grant_rejected_and_native_left_intact(homes):
    home = homes(allow=False)
    with active(home):
        assert registry.get_entry("web_search") is registry.snapshot_registration(
            "web_search"
        )
        assert registry.get_entry("web_extract") is registry.snapshot_registration(
            "web_extract"
        )


# 验证加载、调用及重载不改写原生开关。
@pytest.mark.parametrize("flags", [True, False, None])
def test_load_dispatch_and_reload_never_changes_native_switches(homes, service, flags):
    home = homes(flags=flags)
    before = (home / "config.yaml").read_bytes()
    assert invoke(home, "web_search", {"query": "suite policy"})["success"]
    with active(home):
        get_plugin_manager().discover_and_load(force=True)
    assert (home / "config.yaml").read_bytes() == before


# 验证同Profile的套件搜索和原生抓取分别命中各自缓存。
def test_mixed_unisearch_and_native_tavily_extract_keep_both_caches(homes, service):
    home = homes(search="unisearch", extract="tavily")
    for _ in range(2):
        assert invoke(home, "web_search", {"query": "mixed suite"})["success"]
        assert (
            invoke(home, "web_extract", {"urls": ["https://example.com/mixed"]})[
                "results"
            ][0]["content"]
            == "page body"
        )
    assert len([c for c in service.calls if c["host"] == "api.tavily.com"]) == 1
    assert len([c for c in service.calls if c["host"] != "api.tavily.com"]) == 1
    assert list((home / "cache/web").glob("*.md"))


# 验证原生搜索与内置抓取混用时仍保留原生搜索缓存。
def test_native_tavily_search_and_builtin_fetch_keep_native_search_cache(
    homes, service
):
    home = homes(search="tavily", extract="builtin_parse")
    from agent.web_search_registry import get_provider

    with active(home):
        provider = get_provider("builtin_parse")

        # 以合成页面替代外部抓取传输。
        async def local_fetch(url, key):
            return {
                "url": url,
                "title": "builtin",
                "content": "local content",
                "fetch_status": "usable",
                "engine": "http",
                "reasons": [],
            }

        provider._fetch = local_fetch
    for _ in range(2):
        assert invoke(home, "web_search", {"query": "native mixed"})["success"]
        assert (
            invoke(home, "web_extract", {"urls": ["https://example.com/local"]})[
                "results"
            ][0]["content"]
            == "local content"
        )
    assert len(service.calls) == 1


# 验证原生搜索失败仍遵守原来的救援开关。
@pytest.mark.parametrize("flags", [True, False])
def test_native_search_failure_rescue_obeys_its_original_setting(homes, service, flags):
    home = homes(search="tavily", extract="builtin_parse", flags=flags)
    service.fail = True
    result = invoke(home, "web_search", {"query": "native failure"})
    assert bool(service.rescues) == flags
    assert bool(result["success"]) == flags


# 验证套件搜索及抓取失败不会换用其他免费服务。
@pytest.mark.parametrize("extract", ["builtin_parse", "unicrawl"])
def test_owned_failures_never_enter_native_rescue(homes, service, extract):
    home = homes(extract=extract)
    service.fail = True
    assert not invoke(home, "web_search", {"query": "owned failure"})["success"]
    if extract == "builtin_parse":
        from agent.web_search_registry import get_provider

        with active(home):
            # 模拟外部抓取失败，保留Provider错误处理。
            async def fail_fetch(url, key):
                raise ValueError("synthetic worker failure")

            get_provider(extract)._fetch = fail_fetch
    result = invoke(home, "web_extract", {"urls": ["https://example.com/failure"]})
    assert result["results"][0]["error"]
    assert service.rescues == []


# 验证其他Provider的原生抓取失败仍能救援。
def test_native_extract_failure_retains_rescue(homes, service):
    home = homes(extract="tavily")
    service.fail = True
    result = invoke(
        home, "web_extract", {"urls": ["https://example.com/native-failure"]}
    )
    assert service.rescues == [("extract", "tavily")]
    assert result["results"][0]["content"] == "rescued page"


# 验证账号往返与并行Profile不会串用套件结果。
def test_a_b_a_and_parallel_profiles_do_not_share_owned_results(homes, service):
    a = homes("a")
    b = homes("b")
    args = {"query": "same across profiles"}
    ra = invoke(a, "web_search", args, key="probe-a")
    rb = invoke(b, "web_search", args, key="probe-b")
    ra2 = invoke(a, "web_search", args, key="probe-a")
    assert ra == ra2 and ra != rb and len(service.calls) == 2
    with ThreadPoolExecutor(max_workers=2) as pool:
        parallel = list(
            pool.map(
                lambda item: invoke(
                    item[0], "web_search", {"query": "concurrent"}, key=item[1]
                ),
                [(a, "probe-a"), (b, "probe-b")],
            )
        )
    assert parallel[0] != parallel[1]


# 验证凭证轮换或撤销后不会命中过期身份缓存。
def test_key_rotation_and_revocation_cannot_hit_native_outer_cache(homes, service):
    home = homes()
    args = {"query": "rotation"}
    a = invoke(home, "web_search", args, key="probe-a")
    b = invoke(home, "web_search", args, key="probe-b")
    revoked = invoke(home, "web_search", args, key=None)
    assert (
        a != b
        and len(service.calls) == 2
        and not revoked["success"]
        and not service.rescues
    )


# 验证切换搜索服务和地址时缓存身份随之变化。
def test_search_route_and_endpoint_changes_do_not_reuse_old_result(homes, service):
    home = homes()
    args = {"query": "route change"}
    assert invoke(home, "web_search", args)["success"]
    mutate(
        home,
        lambda c: c["plugins"]["entries"]["unisearch"]["settings"].update(
            backend="bocha"
        ),
    )
    assert invoke(home, "web_search", args)["success"]
    mutate(
        home,
        lambda c: c["plugins"]["entries"]["unisearch"]["settings"].update(
            url="https://probe.example/bocha_search"
        ),
    )
    assert invoke(home, "web_search", args)["success"]
    assert len(service.calls) == 3


# 验证秘密URL和内网目标在请求前拦截。
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/private",
        "https://private.example/",
        "https://example.com/?token=sk-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    ],
)
def test_url_safety_blocks_before_transport(homes, service, url):
    home = homes(extract="unicrawl")
    result = invoke(home, "web_extract", {"urls": [url]})
    assert result.get("error") or result["results"][0]["error"]
    assert service.calls == [] and service.rescues == []


# 验证已有缓存不能绕过新的网站访问策略。
def test_policy_change_blocks_even_when_owned_cache_is_warm(homes, service):
    home = homes(extract="unicrawl")
    args = {"urls": ["https://example.com/policy"]}
    assert invoke(home, "web_extract", args)["results"][0]["content"] == "page body"
    mutate(
        home,
        lambda c: c.update(
            security={
                "website_blocklist": {"enabled": True, "domains": ["example.com"]}
            }
        ),
    )
    result = invoke(home, "web_extract", args)
    assert result["results"][0]["blocked_by_policy"] is True and len(service.calls) == 1


# 验证五网址上限、结果顺序和长文完整落盘。
def test_extract_max_five_order_errors_and_fulltext_truncation(homes, service):
    home = homes(extract="unicrawl")
    service.content = "line of content\n" * 1500
    urls = ["https://example.com/" + str(i) for i in range(7)]
    result = invoke(home, "web_extract", {"urls": urls, "char_limit": 2000})
    assert [r["url"] for r in result["results"]] == urls[:5]
    assert len(service.calls) == 5
    assert all(len(r["content"]) < 6000 for r in result["results"])
    assert len(list((home / "cache/web").glob("*.md"))) == 5


# 验证单页失败与整批超时不触发跨服务救援。
def test_extract_partial_failure_and_timeout(homes, service):
    home = homes(extract="builtin_parse")
    from agent.web_search_registry import get_provider

    with active(home):
        # 模拟成功、失败或等待中的外部页面。
        async def fetch(url, key):
            if url.endswith("/bad"):
                raise ValueError("synthetic failure")
            if url.endswith("/slow"):
                await asyncio.sleep(1)
            return {
                "url": url,
                "title": "ok",
                "content": "ok",
                "fetch_status": "usable",
                "engine": "http",
                "reasons": [],
            }

        get_provider("builtin_parse")._fetch = fetch
    result = invoke(
        home,
        "web_extract",
        {"urls": ["https://example.com/ok", "https://example.com/bad"]},
    )
    assert not result["results"][0]["error"] and result["results"][1]["error"]
    mutate(home, lambda c: c["web"].update(extract_timeout=0.01))
    result = invoke(home, "web_extract", {"urls": ["https://example.com/slow"]})
    assert "timed out" in result["results"][0]["error"]
    assert not service.rescues


# 验证卸载只恢复所属Profile，其他Profile继续工作。
def test_reload_unload_restores_native_without_touching_other_profile(homes, service):
    a = homes("a")
    b = homes("b")
    original = registry.snapshot_registration("web_search")
    with active(a):
        first = registry.get_entry("web_search")
        get_plugin_manager().discover_and_load(force=True)
        assert registry.get_entry("web_search") is not first
        assert get_plugin_manager().unload("unisearch")
        assert registry.get_entry("web_search") is original
    assert invoke(b, "web_search", {"query": "still active"})["success"]
    # 已明确选择但已卸载的后端遵守原生严格选择错误，不悄悄换另一家。
    result = invoke(a, "web_search", {"query": "disabled selection"})
    assert not result["success"]


# 验证不抢占另一插件已拥有的同名网页工具。
def test_competing_override_not_silently_displaced(homes, service):
    home = homes()
    with active(home):
        manager = get_plugin_manager()
        manager.unload("unisearch")
        competing = home / "plugins/aaa_competing"
        competing.mkdir()
        (competing / "plugin.yaml").write_text(
            "name: aaa_competing\n", encoding="utf-8"
        )
        (competing / "__init__.py").write_text(
            'def register(ctx):\n from tools.registry import registry\n old=registry.get_entry("web_search")\n ctx.register_tool(name="web_search",toolset="web",schema=old.schema,handler=lambda args,**kw:"{\\"competing\\":true}",override=True)\n',
            encoding="utf-8",
        )
        cfg = read_user_config_raw()
        cfg["plugins"]["enabled"].insert(0, "aaa_competing")
        cfg["plugins"]["entries"]["aaa_competing"] = {"allow_tool_override": True}
        atomic_config_write(get_config_path(), cfg)
        manager.discover_and_load(force=True)
        assert json.loads(registry.dispatch("web_search", {})) == {"competing": True}


# 验证原生作用域、前置钩子和guardrail在请求前生效。
@pytest.mark.parametrize("mode", ["scope", "hook", "guard", "allow"])
def test_real_agent_policy_pipeline_precedes_adapter_dispatch(homes, service, mode):
    home = homes()
    if mode == "hook":
        mutate(
            home,
            lambda c: c["plugins"]["entries"]["unisearch"]["settings"].update(
                probe_block_tools=True
            ),
        )
    from agent.tool_executor import _run_agent_tool_execution_middleware

    agent = SimpleNamespace(
        session_id="probe-session",
        quiet_mode=True,
        verbose_logging=False,
        tool_progress_callback=None,
        tool_start_callback=None,
        _checkpoint_mgr=SimpleNamespace(enabled=False),
        _touch_activity=lambda *args: None,
        _post_tool_call_hook=lambda **kw: None,
        _tool_guardrails=SimpleNamespace(
            before_call=lambda *args: SimpleNamespace(
                allows_execution=mode != "guard", message="probe guard block"
            )
        ),
        _guardrail_block_result=lambda decision: json.dumps({
            "error": decision.message
        }),
    )
    with active(home):
        state = _run_agent_tool_execution_middleware(
            agent,
            function_name="web_search",
            function_args={"query": "agent gate"},
            effective_task_id="probe-task",
            tool_call_id="probe-call",
            scope_block="probe scope block" if mode == "scope" else None,
            execute=lambda args: registry.dispatch("web_search", args),
        )
    body = json.loads(state.result)
    assert state.blocked == (mode != "allow")
    assert len(service.calls) == (1 if mode == "allow" else 0)
    if mode != "allow":
        assert "block" in body["error"]


# 验证真实模型工具入口的前置钩子可以阻止适配调用。
def test_native_model_entry_pre_hook_blocks_adapter(homes, service):
    home = homes()
    mutate(
        home,
        lambda c: c["plugins"]["entries"]["unisearch"]["settings"].update(
            probe_block_tools=True
        ),
    )
    result = invoke(home, "web_search", {"query": "prehook block"})
    assert "blocked by probe hook" in result["error"]
    assert service.calls == []


# 验证用户原本关闭的原生缓存继续关闭。
def test_native_cache_disabled_setting_remains_effective(homes, service):
    home = homes(search="tavily", extract="tavily", flags=False)
    for _ in range(2):
        assert invoke(home, "web_search", {"query": "uncached native"})["success"]
        assert (
            invoke(home, "web_extract", {"urls": ["https://example.com/uncached"]})[
                "results"
            ][0]["content"]
            == "page body"
        )
    assert len(service.calls) == 4


# 验证取消传播到抓取任务并结束等待。
def test_cancellation_reaches_fetch_tasks(homes, service):
    home = homes(extract="builtin_parse")
    state = {"cancelled": False}
    from agent.web_search_registry import get_provider

    with active(home):
        # 模拟成功、失败或等待中的外部页面。
        async def fetch(url, key):
            try:
                await asyncio.sleep(5)
            finally:
                state["cancelled"] = True

        get_provider("builtin_parse")._fetch = fetch

        # 在当前验证事件循环中执行并清理任务。
        async def run():
            task = asyncio.create_task(
                registry.get_entry("web_extract").handler({
                    "urls": ["https://example.com/cancel"]
                })
            )
            await asyncio.sleep(0.03)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(run())
    assert state["cancelled"] and service.rescues == []


# 验证抓取凭证变更与撤销时重新校验身份。
def test_fetch_credential_rotation_and_revocation(homes, service):
    home = homes(extract="unicrawl")
    args = {"urls": ["https://example.com/rotate"]}
    assert not invoke(home, "web_extract", args, key="probe-a")["results"][0]["error"]
    assert not invoke(home, "web_extract", args, key="probe-b")["results"][0]["error"]
    assert invoke(home, "web_extract", args, key=None)["results"][0]["error"]
    assert len(service.calls) == 2 and service.rescues == []


# 验证工具名称、schema和可见数量不因适配改变。
def test_schema_and_tool_visibility_unchanged(homes, service):
    home = homes()
    from model_tools import get_tool_definitions

    with active(home):
        definitions = get_tool_definitions(enabled_toolsets=["web"], quiet_mode=True)
        names = [d["function"]["name"] for d in definitions]
        assert names.count("web_search") == names.count("web_extract") == 1
        assert "unisearch" not in names
        for name in ("web_search", "web_extract"):
            assert (
                registry.get_schema(name) == registry.snapshot_registration(name).schema
            )


# 验证内联图片字节不会进入模型工具正文。
def test_raw_base64_is_stripped_before_model_result(homes, service):
    home = homes(extract="unicrawl")
    service.content = "text ![pic](data:image/png;base64," + "A" * 1500 + ") end"
    result = invoke(home, "web_extract", {"urls": ["https://example.com/base64"]})
    assert "data:image" not in result["results"][0]["content"]


# 验证启动及会话、工具钩子均不覆盖原生策略。
@pytest.mark.parametrize("flags", [True, False, None])
def test_bootstrap_session_hooks_and_tool_hooks_preserve_native_flags(
    homes, service, flags
):
    home = homes(flags=flags)
    import importlib
    from agent.web_search_registry import get_provider
    from hermes_cli.lifecycle import invoke_hook

    with active(home):
        provider = get_provider("unisearch")
        package = provider.__class__.__module__.rsplit(".", 1)[0]
        configure = importlib.import_module(package + ".configure")
        before = deepcopy(read_user_config_raw()["web"])
        configure.apply(None)
        invoke_hook("on_session_start", session_id="probe-session")
        assert read_user_config_raw()["web"] == before
    invoke(home, "web_search", {"query": "bootstrap + hooks"})
    with active(home):
        assert read_user_config_raw()["web"] == before


# 验证结构化卡片、文本及后台身份经过原生入口后仍保留。
def test_search_card_payload_and_backend_identity_survive_native_entry(homes, service):
    home = homes()
    service.card = True
    result = invoke(home, "web_search", {"query": "structured cards"})
    assert (
        result["provider"] == "unisearch"
        and result["data"]["cards"][0]["type"] == "unknown"
    )
    assert result["data"]["card_text"] and result["data"]["web"]


# 验证并行混合调用不会临时改写共享配置。
def test_no_per_call_shared_config_writes_during_parallel_mixed_calls(homes, service):
    home = homes(search="unisearch", extract="tavily")
    before = (home / "config.yaml").read_bytes()
    with ThreadPoolExecutor(max_workers=2) as pool:
        calls = [
            pool.submit(invoke, home, "web_search", {"query": "parallel mixed"}),
            pool.submit(
                invoke, home, "web_extract", {"urls": ["https://example.com/parallel"]}
            ),
        ]
        assert all(f.result().get("success", True) for f in calls)
    assert (home / "config.yaml").read_bytes() == before


# 验证Brave与BuiltinCrawl混用时保留原生搜索缓存。
def test_brave_search_and_builtin_fetch_mix_preserves_brave_native_cache(
    homes, service
):
    home = homes(search="brave-free", extract="builtin_parse")
    from agent.web_search_registry import get_provider

    with active(home):
        # 以合成页面替代外部抓取传输。
        async def local_fetch(url, key):
            return {
                "url": url,
                "title": "local",
                "content": "local",
                "fetch_status": "usable",
                "engine": "http",
                "reasons": [],
            }

        get_provider("builtin_parse")._fetch = local_fetch
    for _ in range(2):
        result = invoke(home, "web_search", {"query": "Brave mixed"})
        assert result["success"] and result["data"]["web"][0]["title"] == "Brave native"
        assert (
            invoke(home, "web_extract", {"urls": ["https://example.com/local"]})[
                "results"
            ][0]["content"]
            == "local"
        )
    assert len(service.calls) == 1


# 验证用户关闭的原生抓取救援不会被插件重新开启。
def test_native_extract_rescue_false_is_not_overridden(homes, service):
    home = homes(extract="tavily", flags=False)
    service.fail = True
    result = invoke(home, "web_extract", {"urls": ["https://example.com/no-rescue"]})
    assert result["results"][0]["error"] and service.rescues == []


# 验证确认启动后的真实抓取子进程能被取消回收。
def test_real_worker_process_is_reaped_when_cancelled(homes, service, monkeypatch):
    home = homes(extract="builtin_parse")
    spawned = []
    original_spawn = asyncio.create_subprocess_exec

    # 在当前验证事件循环中执行并清理任务。
    async def run():
        ready = asyncio.Event()

        # 创建真实无网络子进程并通知启动完成。
        async def controlled_worker(*args, **kwargs):
            # 仅替换外部worker入口；真实进程启动后取消，避免依赖机器启动耗时。
            import sys

            process = await original_spawn(
                sys.executable, "-c", "import time; time.sleep(30)", **kwargs
            )
            spawned.append((process, kwargs["env"]))
            asyncio.get_running_loop().call_soon(ready.set)
            return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", controlled_worker)
        task = asyncio.create_task(
            registry.get_entry("web_extract").handler({
                "urls": ["https://example.com/worker-cancel"]
            })
        )
        try:
            await asyncio.wait_for(ready.wait(), timeout=5)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    with active(home):
        asyncio.run(run())
    assert len(spawned) == 1
    process, env = spawned[0]
    assert process.returncode is not None
    assert env["HERMES_HOME"] == str(home) and "DESKTOP_MT_MAAS_API_KEY" not in env


# 验证纯原生配置保留搜索、抓取缓存及开关缺省语义。
@pytest.mark.parametrize("flags", [True, False, None])
def test_pure_native_pair_preserves_flags_and_both_native_caches(homes, service, flags):
    home = homes(search="tavily", extract="tavily", flags=flags)
    before = (home / "config.yaml").read_bytes()
    for _ in range(2):
        assert invoke(home, "web_search", {"query": "native only"})["success"]
        assert (
            invoke(home, "web_extract", {"urls": ["https://example.com/native-only"]})[
                "results"
            ][0]["content"]
            == "page body"
        )
    assert len(service.calls) == (4 if flags is False else 2)
    assert (home / "config.yaml").read_bytes() == before


# 验证逆序卸载不覆盖新插件，也不复活已卸载处理函数。
def test_unload_out_of_order_preserves_newer_plugin_and_then_native(homes, service):
    home = homes()
    with active(home):
        manager = get_plugin_manager()
        competing = home / "plugins/zzz_competing"
        competing.mkdir()
        (competing / "plugin.yaml").write_text(
            "name: zzz_competing\n", encoding="utf-8"
        )
        (competing / "__init__.py").write_text(
            'def register(ctx):\n from tools.registry import registry\n old=registry.get_entry("web_search")\n ctx.register_tool(name="web_search",toolset="web",schema=old.schema,handler=lambda args,**kw:"{\\"newer\\":true}",override=True)\n',
            encoding="utf-8",
        )
        cfg = read_user_config_raw()
        cfg["plugins"]["enabled"].append("zzz_competing")
        cfg["plugins"]["entries"]["zzz_competing"] = {"allow_tool_override": True}
        atomic_config_write(get_config_path(), cfg)
        manager.discover_and_load(force=True)
        assert json.loads(registry.dispatch("web_search", {})) == {"newer": True}
        manager.unload("unisearch")
        assert json.loads(registry.dispatch("web_search", {})) == {"newer": True}
        manager.unload("zzz_competing")
        assert registry.get_entry("web_search") is registry.snapshot_registration(
            "web_search"
        )


@pytest.mark.parametrize("snapshot", [True, False])
def test_legacy_snapshot_does_not_guess_or_overwrite_native_policy(
    homes, service, snapshot
):
    """旧快照没有完整写入归属，不能据此猜测恢复两个原生开关。"""
    home = homes(flags=False)
    mutate(
        home,
        lambda c: c["plugins"]["entries"]["unisearch"]["settings"].update(
            cache_enabled=snapshot, native_keyless_rescue=snapshot
        ),
    )
    with active(home):
        from hermes_cli.lifecycle import invoke_hook

        invoke_hook("on_session_start", session_id="legacy-session")
    invoke(home, "web_search", {"query": "legacy policy"})
    with active(home):
        web = read_user_config_raw()["web"]
        assert web["cache_enabled"] is False and web["keyless_rescue"] is False


def test_bundled_desktop_path_uses_native_trust_without_self_grant(
    tmp_path, monkeypatch, service
):
    """实际发行根保留原生Provider，并按原生内置信任加载，不自写授权。"""
    import subprocess

    repository = SOURCE.parents[3]
    out = tmp_path / "build"
    subprocess.run(
        [
            "node",
            str(repository / "apps/desktop/scripts/stage-python-plugins.mjs"),
            "--source",
            str(repository),
            "--out",
            str(out),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    home = tmp_path / "account"
    home.mkdir()
    cfg = {
        "plugins": {
            "enabled": ["unisearch"],
            "entries": {"unisearch": {"settings": {"backend": "tencent"}}},
        },
        "web": {
            "search_backend": "unisearch",
            "extract_backend": "tavily",
            "cache_enabled": True,
            "keyless_rescue": True,
        },
    }
    (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(out / "python-plugins"))
    with active(home):
        manager = get_plugin_manager()
        manager.discover_and_load(force=True)
        try:
            assert manager._plugins["unisearch"].manifest.source == "bundled"
            assert invoke(home, "web_search", {"query": "bundled path"})["success"]
            assert (
                invoke(home, "web_extract", {"urls": ["https://example.com/bundled"]})[
                    "results"
                ][0]["content"]
                == "page body"
            )
            assert (
                "allow_tool_override"
                not in read_user_config_raw()["plugins"]["entries"]["unisearch"]
            )
            assert read_user_config_raw()["web"] == cfg["web"]
        finally:
            manager.unload()


def test_reload_publishes_complete_metadata_to_concurrent_readers(homes):
    """并发读者不能看到已发布但尚未补齐结果预算的注册对象。"""
    home = homes()
    with active(home):
        manager = get_plugin_manager()
    cap = registry.snapshot_registration("web_search").max_result_size_chars

    def reload():
        """在同一Profile中重载插件，复用原生替换协调器。"""
        with active(home):
            for _ in range(8):
                manager.discover_and_load(force=True)

    def read():
        """读取注册预算，既允许全局原项也允许已完整发布的覆盖项。"""
        with active(home):
            for _ in range(300):
                assert registry.get_entry("web_search").max_result_size_chars == cap

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(reload), pool.submit(read)]
        for future in pending:
            future.result(timeout=30)


@pytest.mark.parametrize("native_cache", [True, False])
@pytest.mark.parametrize("owned_cache", [True, False])
def test_owned_and_native_cache_settings_are_independent(
    homes, service, native_cache, owned_cache
):
    """套件与原生缓存的四种开关组合分别生效，不互相覆盖。"""
    home = homes(search="unisearch", extract="tavily", flags=native_cache)
    mutate(
        home,
        lambda c: c["plugins"]["entries"]["unisearch"]["settings"].update(
            cache_enabled=owned_cache
        ),
    )
    for _ in range(2):
        assert invoke(home, "web_search", {"query": "independent settings"})["success"]
        assert (
            invoke(home, "web_extract", {"urls": ["https://example.com/independent"]})[
                "results"
            ][0]["content"]
            == "page body"
        )
    suite_calls = [c for c in service.calls if c["host"] != "api.tavily.com"]
    native_calls = [c for c in service.calls if c["host"] == "api.tavily.com"]
    assert len(suite_calls) == (1 if owned_cache else 2)
    assert len(native_calls) == (1 if native_cache else 2)
    with active(home):
        current = read_user_config_raw()
        assert current["web"]["cache_enabled"] is native_cache
        assert (
            current["plugins"]["entries"]["unisearch"]["settings"]["cache_enabled"]
            is owned_cache
        )


# 相同URL的不同结果按位置回传；原生截断、落盘和二进制拒绝后状态仍真实。
def test_builtin_status_survives_native_output_processing(homes, service):
    from agent.web_search_registry import get_provider

    home = homes(extract="builtin_parse")
    calls = []
    text = "Useful article with many details.\n" * 200
    with active(home):
        # 模拟worker协议，原生工具注册、合并、截断和状态恢复执行真实路径。
        async def fetch(url, key):
            calls.append(url)
            if url.endswith("/denied"):
                return {
                    "url": url,
                    "content": "",
                    "error": "No usable body",
                    "fetch_status": "unavailable",
                    "reasons": ["access_page"],
                }
            return {
                "url": url,
                "title": "Article",
                "content": "SQLite format 3\0binary"
                if url.endswith("/binary")
                else text,
                "fetch_status": "partial" if len(calls) == 1 else "usable",
                "engine": "http" if len(calls) == 1 else "chromium",
                "reasons": ["render_timeout"] if len(calls) == 1 else [],
            }

        get_provider("builtin_parse")._fetch = fetch
    same = "https://example.com/same"
    result = invoke(
        home,
        "web_extract",
        {
            "urls": [
                same,
                same,
                "https://example.com/binary",
                "https://example.com/denied",
                "not-a-url",
            ],
            "char_limit": 2000,
        },
    )
    partial, usable, binary, denied, invalid = result["results"]
    assert partial["url"] == usable["url"] == same
    assert (
        partial["fetch_status"] == "partial"
        and partial["engine"] == "http"
        and partial["reasons"] == ["render_timeout"]
    )
    assert usable["fetch_status"] == "usable" and usable["engine"] == "chromium"
    assert all("TRUNCATED" in row["content"] for row in (partial, usable))
    assert any(p.read_text() == text for p in (home / "cache/web").glob("*.md"))
    assert binary["fetch_status"] == "unavailable" and binary["reasons"] == [
        "output_unavailable"
    ]
    assert denied["fetch_status"] == "unavailable" and denied["reasons"] == [
        "access_page"
    ]
    assert invalid["fetch_status"] == "unavailable" and invalid["error"]
    assert not service.rescues


# 在真实插件启停与抓取前后，其他已注册工具的schema、handler和调度结果保持一致。
def test_builtin_followup_leaves_unrelated_tool_registration_and_calls_intact(
    homes, service, tmp_path
):
    from agent.web_search_registry import get_provider
    from tools.mcp_tool_schema import _convert_mcp_schema
    from tools import file_tools

    name = "mcp__reading_fixture__echo"
    schema = _convert_mcp_schema(
        "reading_fixture",
        SimpleNamespace(
            name="echo",
            description="Return the supplied text",
            inputSchema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        ),
    )
    calls = []

    # 外部工具传输边界替身；注册、schema解析和原生调度走真实路径。
    def echo(args, **kwargs):
        calls.append(args.copy())
        return json.dumps({"echo": args["text"]})

    assert registry.get_entry(name) is None
    registry.register(
        name=name,
        toolset="mcp-reading_fixture",
        schema=schema,
        handler=echo,
        check_fn=lambda: True,
    )
    original = registry.get_entry(name)
    ordinary = registry.get_entry("read_file")
    source = tmp_path / "ordinary.txt"
    source.write_text("UNCHANGED_FILE_TOOL")
    before_schema = deepcopy(registry.get_schema(name))
    before_read = registry.dispatch("read_file", {"path": str(source)})
    assert "UNCHANGED_FILE_TOOL" in json.loads(before_read)["content"]
    try:
        home = homes()
        with active(home):
            # 合成worker响应触发新增提示，随后继续调用外部及文件工具。
            async def fetch(url, key):
                return {
                    "url": url,
                    "content": "Partial article body",
                    "fetch_status": "partial",
                    "engine": "chromium",
                    "reasons": ["interaction_scope_limited"],
                }

            get_provider("builtin_parse")._fetch = fetch
        result = invoke(home, "web_extract", {"urls": ["https://example.com/reading"]})
        assert result["results"][0]["browser_followup"]["needed"] is True
        for loaded in (True, False):
            with active(home):
                if not loaded:
                    get_plugin_manager().unload()
                assert registry.get_entry(name) is original
                assert registry.get_entry("read_file") is ordinary
                assert registry.get_schema(name) == before_schema
                assert json.loads(
                    registry.dispatch(name, {"text": "UNCHANGED_MCP"})
                ) == {"echo": "UNCHANGED_MCP"}
                # 文件更新后应重新读取；不把原生重复读取去重误判为插件影响。
                marker = f"UNCHANGED_FILE_TOOL_{loaded}"
                source.write_text(marker)
                assert (
                    marker
                    in json.loads(
                        registry.dispatch("read_file", {"path": str(source)})
                    )["content"]
                )
        assert calls == [{"text": "UNCHANGED_MCP"}] * 2
    finally:
        registry.deregister(name)


# 实际注册工具保留新正文缺口原因和按需续读提示，不触发原生救援。
@pytest.mark.parametrize("reason", ["main_content_missing", "repository_overview_unverified"])
def test_builtin_article_reason_survives_registered_tool(homes, service, reason):
    from agent.web_search_registry import get_provider
    home = homes(extract="builtin_parse")
    with active(home):
        async def fetch(url, key):
            return {"url":url,"content":"Repository files are available; overview is not verified.","fetch_status":"partial","engine":"http","reasons":[reason]}
        get_provider("builtin_parse")._fetch = fetch
    row = invoke(home,"web_extract",{"urls":["https://github.com/example/project"]})["results"][0]
    assert row["fetch_status"] == "partial" and reason in row["reasons"]
    assert row["browser_followup"]["needed"]
    assert not service.rescues
