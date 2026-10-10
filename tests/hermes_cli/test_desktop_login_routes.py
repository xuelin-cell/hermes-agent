"""桌面登录只走 Electron；真实后端不再提供第二套 MaaS 登录代理。"""

from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def desktop_client(monkeypatch, tmp_path):
    """加载真实无 SPA 后端，仅固定本机连接身份，不绕过鉴权中间件。"""
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_SERVE_HEADLESS", "1")
    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_SESSION_TOKEN", "desktop-route-test-token")
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_host", "127.0.0.1", raising=False)
    client = TestClient(web_server.app, base_url="http://127.0.0.1")
    yield client
    client.close()


def test_desktop_backend_does_not_proxy_maas_login(desktop_client, monkeypatch):
    """已授权请求也找不到旧登录接口，且不会向 MaaS 发送请求。"""
    upstream = AsyncMock(return_value=httpx.Response(200, json={"code": 0}))
    monkeypatch.setattr(httpx.AsyncClient, "request", upstream)
    headers = {"Authorization": "Bearer desktop-route-test-token"}
    requests = [
        ("GET", "captcha", {}),
        ("POST", "send-code", {"json": {
            "phone": "13800000000", "captchaCode": "abcd", "captchaId": "fixture",
        }}),
        ("POST", "sms-login", {"json": {
            "phone": "13800000000", "smsCode": "123456",
        }}),
    ]
    for method, suffix, options in requests:
        response = desktop_client.request(
            method, f"/api/uniwork/auth/{suffix}", headers=headers, **options,
        )
        # 原版 headless GET 通配路由使未注册的 POST 返回 405，不为清理改变它。
        assert response.status_code == (404 if method == "GET" else 405), (suffix, response.text)
    upstream.assert_not_awaited()


def test_desktop_backend_keeps_its_session_token_gate(desktop_client):
    """清理登录代理不开放账号接口，正确本机连接令牌仍可读取 Profiles。"""
    assert desktop_client.get("/api/profiles").status_code == 401
    response = desktop_client.get(
        "/api/profiles", headers={"Authorization": "Bearer desktop-route-test-token"},
    )
    assert response.status_code == 200, response.text
    assert any(profile["is_default"] for profile in response.json()["profiles"])
