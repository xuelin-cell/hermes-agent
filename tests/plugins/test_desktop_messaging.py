"""真实插件路由和临时账号配置往返；认证服务由受控传输回答。"""
import asyncio
from importlib import import_module

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from hermes_cli.config import load_env, save_env_value

api = import_module("plugins.desktop-messaging.dashboard.plugin_api")
validation = import_module("plugins.desktop-messaging.dashboard.validation")


@pytest.mark.parametrize("alive,state,credentials,enabled,expected", [
    (True, "connected", True, True, "connected"),
    (False, "connected", True, True, "gateway_stopped"),
    (True, "fatal", True, True, "fatal"),
    (True, None, True, True, "pending_restart"),
    (True, "connected", False, True, "not_configured"),
    (True, "connected", True, False, "disabled"),
])
def test_desktop_status_does_not_depend_on_backend_adapter_registration(
    monkeypatch, alive, state, credentials, enabled, expected,
):
    """配置由本账号文件确认，连通仍必须通过原版存活检查和渠道状态。"""
    from types import SimpleNamespace
    from hermes_cli.web_routers import messaging
    from hermes_constants import get_hermes_home

    if credentials:
        save_env_value("DINGTALK_CLIENT_ID", "fixture-id")
        save_env_value("DINGTALK_CLIENT_SECRET", "fixture-secret")
    api._write_platform_enabled("dingtalk", enabled)
    runtime = {"platforms": {"dingtalk": {"state": state}}, "state": "running"}
    monkeypatch.setattr(messaging, "read_runtime_status", lambda **_: runtime)
    monkeypatch.setattr(messaging, "get_runtime_status_running_pid", lambda *a, **k: 123)
    probes = []

    def liveness(**kwargs):
        """记录显式 Home，模拟原版进程归属与存活检查结果。"""
        probes.append(kwargs["profile_dir"])
        return SimpleNamespace(running=alive)

    original = messaging._platform_enablement

    def registration_missing(platform, entry, env, scoped):
        """模拟桌面进程插件未注册，网关进程仍独立运行。"""
        return original(platform, entry, env, scoped) if scoped else (enabled, False, None)

    monkeypatch.setattr(messaging, "resolve_gateway_liveness", liveness)
    monkeypatch.setattr(messaging, "_platform_enablement", registration_missing)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        response = client.get("/platforms")
    assert response.status_code == 200
    row = next(p for p in response.json()["platforms"] if p["id"] == "dingtalk")
    assert row["configured"] is credentials
    assert row["state"] == expected
    assert get_hermes_home() in probes
    assert "fixture-secret" not in response.text


@pytest.mark.parametrize("pooled", [False, True])
def test_desktop_status_reads_named_profile_not_root_credentials(monkeypatch, pooled):
    """同时核对同进程 Profile 和独立 Profile 后端，不借用默认账号凭据。"""
    from hermes_cli.profiles import create_profile
    from hermes_cli.web_routers import messaging
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    create_profile("worker")
    save_env_value("DINGTALK_CLIENT_ID", "root-id")
    save_env_value("DINGTALK_CLIENT_SECRET", "root-secret")
    monkeypatch.setattr(messaging, "read_runtime_status", lambda **_: None)
    monkeypatch.setattr(messaging, "multiplexer_liveness_for_profile", lambda *a: None)
    if pooled:
        monkeypatch.setenv("HERMES_HOME", str(home / "profiles" / "worker"))
    result = api.platform_status(None if pooled else "worker")
    row = next(p for p in result["platforms"] if p["id"] == "dingtalk")
    assert row["configured"] is False
    assert not any(p["is_set"] for p in row["env_vars"] if p["required"])


@pytest.mark.parametrize("platform", ["dingtalk", "feishu", "wecom"])
def test_credentials_validate_before_writes_and_unchanged_save_skips_probe(platform, monkeypatch):
    """错误和超时不覆盖旧值；成功落盘后同值保存不重复认证。"""
    calls = []
    id_key, secret_key = api.KEYS[platform]
    save_env_value(id_key, "old-id")
    save_env_value(secret_key, "old-secret")
    app = FastAPI()
    app.include_router(api.router)

    async def reject(*args):
        """模拟认证拒绝，不输出凭据。"""
        raise HTTPException(400, detail="credentials_rejected")

    monkeypatch.setattr(api, "validate_credentials", reject)
    with TestClient(app) as client:
        body = {"env": {id_key: "new-id", secret_key: "new-secret"}}
        assert client.put(f"/platforms/{platform}", json=body).status_code == 400
        assert load_env()[secret_key] == "old-secret"
        assert not any(key in load_env() for key in api.POLICIES[platform])

        async def accept(*args):
            """记录实际交给认证边界的凭据。"""
            calls.append(args)

        monkeypatch.setattr(api, "validate_credentials", accept)
        first = client.put(f"/platforms/{platform}", json=body)
        second = client.put(f"/platforms/{platform}", json=body)
        assert first.json() == {"ok": True, "changed": True}
        assert second.json() == {"ok": True, "changed": False}
        assert calls == [(platform, "new-id", "new-secret")]
        assert all(load_env()[key] == value for key, value in api.POLICIES[platform].items())
        assert "GATEWAY_ALLOW_ALL_USERS" not in load_env()
        assert client.put(f"/platforms/{platform}", json={"env": {id_key: "third-id"}}).status_code == 400
        assert load_env()[id_key] == "new-id"
        assert client.put(f"/platforms/{platform}", json={"enabled": False}).json()["changed"]
        assert id_key not in load_env() and secret_key not in load_env()


@pytest.mark.parametrize("platform,token_key", [("dingtalk", "accessToken"), ("feishu", "tenant_access_token")])
@pytest.mark.parametrize("kind", ["ok", "reject", "timeout", "network", "malformed", "unavailable"])
def test_fixed_http_validation_classifies_failure_and_never_returns_tokens(platform, token_key, kind, monkeypatch):
    """真实 HTTPX 请求构造和解析经过受控平台响应，固定地址不会被页面改写。"""
    original = httpx.AsyncClient

    def response(request):
        """模拟平台认证响应及网络故障。"""
        assert request.url.host in {"api.dingtalk.com", "open.feishu.cn"}
        if kind == "timeout":
            raise httpx.ReadTimeout("sensitive upstream detail")
        if kind == "network":
            raise httpx.ConnectError("sensitive upstream detail")
        if kind == "malformed":
            return httpx.Response(200, text="bad")
        if kind == "unavailable":
            return httpx.Response(500)
        return httpx.Response(200, json={token_key: "PRIVATE-TOKEN"} if kind == "ok" else {"code": 40013})

    monkeypatch.setattr(validation.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(response), **kwargs))
    if kind == "ok":
        assert asyncio.run(validation.validate_credentials(platform, "id", "secret")) is None
    else:
        with pytest.raises(HTTPException) as caught:
            asyncio.run(validation.validate_credentials(platform, "id", "secret"))
        expected = {"reject": "credentials_rejected", "timeout": "validation_timeout", "network": "validation_network",
                    "malformed": "validation_response", "unavailable": "validation_unavailable"}
        assert caught.value.detail == expected[kind]


def test_real_profile_scope_a_b_a_and_fixed_key_boundary(tmp_path, monkeypatch):
    """真实配置作用域 A→B→A 往返，不写全局开关或其他账号凭据。"""
    from hermes_cli.profiles import create_profile
    from hermes_cli.web_server_profiles import _config_profile_scope

    create_profile("account-a")
    create_profile("account-b")

    async def accept(*args):
        """只替换认证边界，保留真实路由和文件读写。"""

    monkeypatch.setattr(api, "validate_credentials", accept)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        for name in ["account-a", "account-b", "account-a"]:
            result = client.put(f"/platforms/feishu?profile={name}", json={"env": {
                "FEISHU_APP_ID": name, "FEISHU_APP_SECRET": f"secret-{name}"}})
            assert result.status_code == 200, result.text
        assert client.put("/platforms/feishu", json={"env": {"GATEWAY_ALLOW_ALL_USERS": "true"}}).status_code == 400
    for name in ["account-a", "account-b"]:
        with _config_profile_scope(name):
            assert load_env()["FEISHU_APP_SECRET"] == f"secret-{name}"
            assert load_env()["FEISHU_GROUP_POLICY"] == "open"
    assert "FEISHU_APP_ID" not in load_env()


@pytest.mark.parametrize("code", [0, 40013])
def test_wecom_real_websocket_handshake_and_cleanup(code, monkeypatch):
    """本机 WebSocket 服务实际完成订阅握手，成功或拒绝后连接均关闭。"""
    from aiohttp import web
    from plugins.platforms.wecom import adapter as wecom

    async def scenario():
        """使用临时端口执行原版握手和清理，不访问真实企业微信。"""
        closed = asyncio.Event()

        async def subscribe(request):
            """只回答订阅帧，不投递业务消息。"""
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            body = await ws.receive_json()
            assert body["cmd"] == "aibot_subscribe"
            await ws.send_json({"headers": body["headers"], "errcode": code})
            async for _ in ws:
                pass
            closed.set()
            return ws

        app = web.Application()
        app.router.add_get("/ws", subscribe)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        monkeypatch.setattr(wecom, "DEFAULT_WS_URL", f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/ws")
        try:
            if code:
                with pytest.raises(HTTPException, match="credentials_rejected"):
                    await validation.validate_credentials("wecom", "bot", "secret")
            else:
                await validation.validate_credentials("wecom", "bot", "secret")
            await asyncio.wait_for(closed.wait(), 3)
        finally:
            await runner.cleanup()

    asyncio.run(scenario())


def test_prepare_and_apply_stop_empty_gateway_and_restart_configured_profiles(monkeypatch):
    """真实扫描和配置读取决定停止或重启，不借用别的账号环境。"""
    from types import SimpleNamespace
    from hermes_cli import web_server_gateway

    actions = []

    def spawn(command, name, *, env_overrides):
        """捕获原版动作边界，防止测试影响真实用户网关。"""
        actions.append((command, name))
        assert env_overrides == ({"HERMES_GATEWAY_INSTALL_START_ON_LOGIN": "0"} if name == "gateway-stop" else {
            "HERMES_GATEWAY_INSTALL_START_ON_LOGIN": "0", "HERMES_GATEWAY_BUSY_ACK_ENABLED": "false",
            "HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED": "false"})
        return SimpleNamespace(pid=123)

    monkeypatch.setattr(web_server_gateway, "_spawn_hermes_action", spawn)
    assert asyncio.run(api.apply_gateway())["name"] == "gateway-stop"
    save_env_value("FEISHU_APP_ID", "saved-id")
    save_env_value("FEISHU_APP_SECRET", "saved-secret")
    assert asyncio.run(api.apply_gateway())["name"] == "gateway-restart"
    assert load_env()["FEISHU_GROUP_POLICY"] == "open"
    assert actions[-1][0][-2:] == ["gateway", "restart"]


def test_plugin_is_discovered_and_mounted_through_native_dashboard(monkeypatch):
    """通过正式发现及挂载入口导入路由，避免仅手工挂载测试通过。"""
    from hermes_cli import web_server, web_server_dashboard

    found = [p for p in web_server_dashboard._discover_dashboard_plugins() if p["name"] == "desktop-messaging"]
    assert found
    app = FastAPI()
    monkeypatch.setattr(web_server, "app", app)
    monkeypatch.setattr(web_server, "_get_dashboard_plugins", lambda: found)
    web_server_dashboard._mount_plugin_api_routes()
    with TestClient(app) as client:
        assert client.post("/api/plugins/desktop-messaging/prepare").json()["configured"] is False
        result = client.put("/api/plugins/desktop-messaging/platforms/feishu", json={"env": {"ARBITRARY_KEY": "x"}})
        assert result.status_code == 400


@pytest.mark.parametrize("platform", ["dingtalk", "feishu", "wecom"])
def test_native_admission_allows_first_dm_and_group_but_does_not_open_wechat(platform):
    """真实网关授权与平台入站规则放行首次消息，微信仍保持默认拒绝。"""
    from types import SimpleNamespace
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource
    from hermes_cli.web_server_profiles import _config_profile_scope

    api._write_policies(platform)
    with _config_profile_scope(None):
        runner = object.__new__(GatewayRunner)
        runner.config = GatewayConfig()
        runner.adapters = {}
        runner.pairing_store = None
        for chat_type in ["dm", "group"]:
            source = SessionSource(platform=Platform(platform), chat_id="chat", chat_type=chat_type, user_id="new-user")
            assert runner._is_user_authorized(source)
        wx = SessionSource(platform=Platform.WEIXIN, chat_id="wx-chat", chat_type="dm", user_id="stranger")
        assert not runner._is_user_authorized(wx)
        if platform == "wecom":
            from plugins.platforms.wecom.adapter import WeComAdapter
            adapter = WeComAdapter(PlatformConfig())
            assert adapter._is_dm_intake_allowed("new-user")
            assert adapter._is_group_allowed("new-group", "new-user")
        if platform == "feishu":
            from plugins.platforms.feishu.adapter import FeishuAdapter
            adapter = FeishuAdapter(PlatformConfig())
            sender = SimpleNamespace(sender_type="user", sender_id=SimpleNamespace(open_id="new-user"))
            for chat_type in ["p2p", "group"]:
                message = SimpleNamespace(chat_type=chat_type, chat_id="new-group", content='{"text":"@_all hello"}')
                assert adapter._admit(sender, message) is None
