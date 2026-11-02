"""通过正式插件挂载、账号文件和原版探测验证已保存模型凭据。"""

import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import web_server, web_server_dashboard
from hermes_cli.profiles import create_profile
from hermes_cli.web_routers import config_env
from hermes_constants import get_hermes_home


@pytest.fixture
def probe(monkeypatch):
    """只替换外部模型服务的 HTTP 传输，保留正式路由与检测逻辑。"""
    requests = []

    def respond(request):
        """模拟要求 Bearer 的目录和原版传输探测，不执行真实模型。"""
        requests.append(request)
        if not request.headers.get("authorization"):
            return httpx.Response(401)
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": "deepseek-flash"}]})
        return httpx.Response(400)

    monkeypatch.setattr(
        config_env,
        "_endpoint_probe_client",
        lambda *_: httpx.AsyncClient(transport=httpx.MockTransport(respond)),
    )
    found = [
        p
        for p in web_server_dashboard._discover_dashboard_plugins()
        if p["name"] == "desktop-models"
    ]
    assert found, "桌面模型验证插件必须由正式入口发现"
    app = FastAPI()
    monkeypatch.setattr(web_server, "app", app)
    monkeypatch.setattr(web_server, "_get_dashboard_plugins", lambda: found)
    web_server_dashboard._mount_plugin_api_routes()
    with TestClient(app) as client:
        yield client, requests


def saved_profile(name, key):
    """创建隔离 Profile，按正式保存格式写配置与密钥文件。"""
    create_profile(name)
    home = get_hermes_home() / "profiles" / name
    (home / "config.yaml").write_text(
        json.dumps({
            "providers": {
                "personal": {
                    "api": "https://models.invalid/v1",
                    "key_env": "CUSTOM_TEST_KEY",
                    "default_model": "deepseek-flash",
                    "models": {"deepseek-flash": {}},
                }
            }
        }),
        encoding="utf-8",
    )
    (home / ".env").write_text(f"CUSTOM_TEST_KEY={key}\n", encoding="utf-8")
    return home


def payload(**updates):
    """构造列表测试或编辑测试共用的请求，不把已保存 Key 放回页面。"""
    return {
        "id": "personal",
        "name": "DeepSeek",
        "base_url": "https://models.invalid/v1",
        "model": "deepseek-flash",
        "api_mode": "chat_completions",
        **updates,
    }


def test_saved_credentials_follow_a_b_a_without_returning_secrets(probe):
    """同名端点按 Profile 复用自己的 Key，测试不改配置和密钥文件。"""
    client, requests = probe
    profiles = {name: saved_profile(name, f"key-{name}") for name in ("alpha", "beta")}
    snapshots = {
        str(file): file.read_bytes()
        for home in profiles.values()
        for file in (home / "config.yaml", home / ".env")
    }
    for name in ("alpha", "beta", "alpha"):
        requests.clear()
        response = client.post(
            f"/api/plugins/desktop-models/validate?profile={name}", json=payload()
        )
        assert response.status_code == 200
        assert response.json()["ok"] is True
        assert {r.headers["authorization"] for r in requests} == {f"Bearer key-{name}"}
        assert "key-alpha" not in response.text and "key-beta" not in response.text
        assert any(
            r.method == "POST" and r.url.path == "/v1/chat/completions"
            for r in requests
        )
    assert snapshots == {
        str(file): file.read_bytes()
        for home in profiles.values()
        for file in (home / "config.yaml", home / ".env")
    }


def test_new_key_wins_and_can_test_an_edited_url_without_saving(probe):
    """用户填写的新 Key 用于草稿测试，原 Key 不被覆盖。"""
    client, requests = probe
    home = saved_profile("alpha", "stored-key")
    response = client.post(
        "/api/plugins/desktop-models/validate?profile=alpha",
        json=payload(api_key="draft-key", base_url="https://new-models.invalid/v1"),
    )
    assert response.json()["ok"] is True
    assert {r.headers["authorization"] for r in requests} == {"Bearer draft-key"}
    assert {r.url.host for r in requests} == {"new-models.invalid"}
    assert "stored-key" in (home / ".env").read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "updates",
    [
        {"base_url": "https://other.invalid/v1"},
        {"base_url": "https://models.invalid/different/v1"},
        {"base_url": "http://models.invalid/v1"},
        {"id": "missing"},
    ],
)
def test_saved_key_is_not_sent_to_another_target_or_provider(probe, updates):
    """更换地址或不存在的端点不能借用任何已保存凭据。"""
    client, requests = probe
    saved_profile("alpha", "stored-key")
    response = client.post(
        "/api/plugins/desktop-models/validate?profile=alpha", json=payload(**updates)
    )
    assert response.status_code == 400
    assert not requests
    assert "stored-key" not in response.text


def test_invalid_key_remains_a_failure_and_does_not_echo_secret(probe, monkeypatch):
    """实际认证拒绝仍展示失败，不能把接口可达冒充认证成功。"""
    client, _ = probe
    saved_profile("alpha", "bad-key")
    monkeypatch.setattr(
        config_env,
        "_endpoint_probe_client",
        lambda *_: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(401))
        ),
    )
    response = client.post(
        "/api/plugins/desktop-models/validate?profile=alpha", json=payload()
    )
    assert response.json()["ok"] is False
    assert "bad-key" not in response.text
