"""UniSearch through real plugin discovery, dispatch and scoped on-disk configuration."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import sys

import httpx
import pytest

from agent.secret_scope import set_secret_scope, reset_secret_scope
from hermes_constants import (
    get_hermes_home,
    set_hermes_home_override,
    reset_hermes_home_override,
)

SOURCE = Path(__file__).resolve().parents[2] / "apps/desktop/assets/unisearch-plugin"


# 从产品目录加载测试包，保持真实Provider与写入逻辑。
def load_package():
    spec = importlib.util.spec_from_file_location(
        "unisearch_test_plugin",
        SOURCE / "__init__.py",
        submodule_search_locations=[str(SOURCE)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from unisearch_test_plugin import provider, configure

    return provider, configure


def allow_user_tool_override():
    """临时Home模拟用户显式授权，不绕过原生权限检查。"""
    from hermes_cli.config import (
        read_user_config_raw,
        atomic_config_write,
        get_config_path,
    )

    current = read_user_config_raw()
    current.setdefault("plugins", {}).setdefault("entries", {}).setdefault(
        "unisearch", {}
    )["allow_tool_override"] = True
    atomic_config_write(get_config_path(), current)


# 真实发现与调度往返两账号，路由或凭证变化不得复用旧结果。
def test_discovery_dispatch_and_home_route_cache(monkeypatch, tmp_path):
    """A→B→A uses each home's key; route changes invalidate the paid result."""
    from hermes_cli.plugins import discover_plugins
    from tools.registry import registry
    from tools.web_result_cache import search_memo
    from hermes_cli.config import load_config
    from model_tools import handle_function_call, get_tool_definitions

    provider_module, configure = load_package()
    homes = [tmp_path / "a", tmp_path / "b"]
    requests = []

    # 只替代外部HTTP响应，保留原生解析与调度。
    def respond(request):
        requests.append((request.headers["Authorization"], json.loads(request.content)))
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {
                    "webPages": {
                        "value": [
                            {
                                "name": request.headers["Authorization"],
                                "url": "https://example.com",
                                "summary": "source",
                            }
                        ]
                    }
                },
            },
        )

    # Discovery imports httpx's real client; only its network transport is controlled.
    original = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs),
    )
    search_memo.clear()
    for home, key in [(homes[0], "key-a"), (homes[1], "key-b"), (homes[0], "key-a")]:
        home.mkdir(exist_ok=True)
        shutil.copytree(SOURCE, home / "plugins/unisearch", dirs_exist_ok=True)
        token = set_hermes_home_override(home)
        secrets = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": key}, profile_home=home)
        try:
            configure.apply({"unisearch_backend": "bocha"})
            allow_user_tool_override()
            discover_plugins(force=True)
            definitions = get_tool_definitions(
                enabled_toolsets=["web"], quiet_mode=True
            )
            assert "web_search" in {d["function"]["name"] for d in definitions}
            result = json.loads(
                handle_function_call("web_search", {"query": "same", "limit": 5})
            )
            assert result["data"]["web"][0]["title"] == f"Bearer {key}"
            assert load_config()["web"]["search_backend"] == "unisearch"
        finally:
            reset_secret_scope(secrets)
            reset_hermes_home_override(token)
    # Force-discovery deliberately reloads plugin modules (and their in-memory memo).
    assert len(requests) == 3
    baseline_requests = len(requests)

    token = set_hermes_home_override(homes[0])
    secrets = set_secret_scope(
        {"DESKTOP_MT_MAAS_API_KEY": "key-a"}, profile_home=homes[0]
    )
    try:
        configure.apply({"unisearch_url": "https://new.example.com/search"})
        allow_user_tool_override()
        discover_plugins(force=True)
        result = json.loads(
            handle_function_call("web_search", {"query": "same", "limit": 5})
        )
        assert result["success"] and len(requests) == baseline_requests + 1
        # Cache hits may not authorize a profile with no key after credential revocation.
        reset_secret_scope(secrets)
        secrets = set_secret_scope({}, profile_home=homes[0])
        assert not json.loads(
            handle_function_call("web_search", {"query": "same", "limit": 5})
        )["success"]
    finally:
        reset_secret_scope(secrets)
        reset_hermes_home_override(token)


# 仅卡片结果仍可用，异常配置不能覆盖用户原有Provider。
def test_tencent_cards_only_errors_and_configuration_preservation(monkeypatch):
    provider_module, configure = load_package()
    configure.apply({
        "unisearch_backend": "tencent",
        "unisearch_display_name": "Enterprise Search",
    })
    from hermes_cli.config import (
        read_user_config_raw,
        atomic_config_write,
        get_config_path,
    )

    current = read_user_config_raw()
    current["web"]["extract_backend"] = "tavily"
    current["web"]["search_backend"] = "brave-free"
    atomic_config_write(get_config_path(), current)
    configure.apply(None)
    assert read_user_config_raw()["web"] == current["web"]
    with pytest.raises(ValueError):
        configure.apply({"unisearch_backend": "bad"})
    assert read_user_config_raw()["web"] == current["web"]

    settings = {"backend": "tencent"}
    secrets = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": "test-key"})
    try:
        calls = []

        # 只替代外部HTTP响应，保留原生解析与调度。
        def respond(request):
            calls.append(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "Response": {
                        "Pages": [
                            json.dumps({
                                "vr": True,
                                "vr_category": "unknown",
                                "passage": "useful answer",
                            }),
                            "bad json",
                        ]
                    }
                },
            )

        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            provider = provider_module.UniSearchProvider(
                lambda k, default=None: settings.get(k, default), client=client
            )
            result = provider.search("test", 5)
            assert result["success"] and not result["data"]["web"]
            assert result["data"]["cards"][0]["type"] == "unknown"
            assert result["data"]["card_text"]
            assert calls[0]["Mode"] == 2 and calls[0]["Cnt"] == 10
        settings["cache_enabled"] = False
        with httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(403))
        ) as client:
            provider = provider_module.UniSearchProvider(
                lambda k, default=None: settings.get(k, default), client=client
            )
            assert "403" in provider.search("test")["error"]
    finally:
        reset_secret_scope(secrets)


# 未绑定明确账号Home时必须在写入前拒绝。
def test_bootstrap_refuses_unbound_home_before_writing(tmp_path):
    import os
    import subprocess

    expected, wrong = tmp_path / "expected", tmp_path / "wrong"
    expected.mkdir()
    wrong.mkdir()
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "HERMES_HOME": str(wrong),
        "PYTHONPATH": str(SOURCE.parents[3]),
    }
    process = subprocess.run(
        [sys.executable, str(SOURCE / "configure.py"), str(expected)],
        env=env,
        input="null",
        text=True,
        capture_output=True,
    )
    assert process.returncode != 0
    assert "Explicit account Home" in process.stderr
    assert (
        not (expected / "config.yaml").exists() and not (wrong / "config.yaml").exists()
    )


# 单进程自然切换Profile时不依赖强制重载恢复隔离。
def test_native_multiprofile_dispatch_without_force_reload(monkeypatch, tmp_path):
    """One process alternates homes, including a keyless B after A has cached a paid result."""
    from hermes_cli.plugins import discover_plugins
    from model_tools import handle_function_call

    _, configure = load_package()
    original = httpx.Client
    calls = []

    # 只替代外部HTTP响应，保留原生解析与调度。
    def respond(request):
        auth = request.headers["authorization"]
        calls.append(auth)
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {
                    "webPages": {
                        "value": [{"name": auth, "url": "https://example.com"}]
                    }
                },
            },
        )

    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kw: original(transport=httpx.MockTransport(respond), **kw),
    )
    for name, key in [("a", "fake-a"), ("b", "fake-b"), ("a", "fake-a"), ("b", "")]:
        home = tmp_path / name
        home.mkdir(exist_ok=True)
        shutil.copytree(SOURCE, home / "plugins/unisearch", dirs_exist_ok=True)
        ht = set_hermes_home_override(home)
        st = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": key}, profile_home=home)
        try:
            configure.apply({"unisearch_backend": "bocha"})
            allow_user_tool_override()
            discover_plugins()
            result = json.loads(
                handle_function_call("web_search", {"query": "shared query"})
            )
            if key:
                assert result["data"]["web"][0]["title"] == "Bearer " + key
            else:
                assert not result.get("success")
        finally:
            reset_secret_scope(st)
            reset_hermes_home_override(ht)
    assert calls[:2] == ["Bearer fake-a", "Bearer fake-b"]


@pytest.mark.parametrize(
    "query",
    [
        "?api_key=fixture-secret",
        "?API%5FKEY=fixture-secret",
        "?%2561pi_key=fixture-secret",
        "?access_token=fixture-secret",
        "?password=fixture-secret",
        "?x-amz-signature=fixture-secret",
    ],
)
def test_service_url_secrets_rejected_atomically_and_before_transport(
    monkeypatch, query
):
    """写入入口及已有设置的执行入口均拒绝凭证形参数，保留其他Provider与原配置。"""
    module, configure = load_package()
    from hermes_cli.config import (
        read_user_config_raw,
        atomic_config_write,
        get_config_path,
    )

    configure.apply(None)
    before = get_config_path().read_bytes()
    with pytest.raises(ValueError, match="Invalid UniSearch URL"):
        configure.apply({
            "unisearch_backend": "bocha",
            "unisearch_url": "https://example.invalid/search" + query,
        })
    assert get_config_path().read_bytes() == before
    calls = []
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: calls.append(request))
    ) as client:
        provider = module.UniSearchProvider(
            lambda key, default=None: {
                "url": "https://example.invalid/search" + query
            }.get(key, default),
            client=client,
        )
        scope = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": "synthetic-maas"})
        try:
            value = provider.search("fixture")
        finally:
            reset_secret_scope(scope)
    assert value["success"] is False and not calls
    assert "fixture-secret" not in json.dumps(
        value
    ) and "synthetic-maas" not in json.dumps(value)


def test_service_url_keeps_business_query_parameters():
    """普通地区／业务key与空值参数继续兼容，不扩大秘密参数拦截范围。"""
    _, configure = load_package()
    from hermes_cli.config import read_user_config_raw

    url = "https://example.invalid/search?region=cn&key=page&code=reference&token="
    configure.apply({"unisearch_url": url})
    assert (
        read_user_config_raw()["plugins"]["entries"]["unisearch"]["settings"]["url"]
        == url
    )


def test_session_setup_leaves_search_alone_without_the_maas_key(tmp_path):
    """会话开始时的默认配置：有 key 的档案切到 UniSearch；没有 key 的（企业版实例、还没登录）
    保持 Hermes 自己的搜索选择，不切到一条用不了的路。"""
    _, configure = load_package()
    from hermes_cli.config import read_user_config_raw

    for key, expected in (("", None), ("maas-key", "unisearch")):
        home = tmp_path / (key or "no-key")
        home.mkdir()
        token = set_hermes_home_override(home)
        scope = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": key} if key else {}, profile_home=home)
        try:
            configure.apply(None)
            assert read_user_config_raw()["web"].get("search_backend") == expected
        finally:
            reset_secret_scope(scope)
            reset_hermes_home_override(token)
