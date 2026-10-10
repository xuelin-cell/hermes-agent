"""云盘 UI 待接入期间，桌面后端不执行旧代理或清理已有预览文件。"""

from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def drive_client(monkeypatch, tmp_path):
    """加载真实无 SPA 后端，把账号 Home 和本机连接身份限制在临时目录。"""
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_SERVE_HEADLESS", "1")
    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_SESSION_TOKEN", "desktop-drive-test-token")
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_host", "127.0.0.1", raising=False)
    client = TestClient(web_server.app, base_url="http://127.0.0.1")
    yield client, home
    client.close()


@pytest.mark.parametrize("suffix, payload", [
    ("request", {"route": "/asset-spaces", "method": "GET"}),
    ("preview", {"asset_id": "asset-1", "fid": "fid-1", "name": "report.pdf"}),
])
def test_desktop_backend_rejects_old_drive_without_side_effects(drive_client, monkeypatch, suffix, payload):
    """有效本机令牌也无法调用旧云盘；无上游请求，已有缓存原样保留。"""
    client, home = drive_client
    preview_dir = home / "cache" / "drive-previews"
    preview_dir.mkdir(parents=True)
    cached = preview_dir / "existing-report.pdf"
    cached.write_bytes(b"existing preview")
    upstream = AsyncMock(return_value=httpx.Response(200, json={
        "ok": True, "result": {"accessToken": "fixture-cloud-token"},
        "data": {"download_path": "/drive/content?fid=fid-1"},
    }))
    monkeypatch.setattr(httpx.AsyncClient, "send", upstream)

    response = client.post(
        f"/api/uniwork/drive/{suffix}",
        headers={"Authorization": "Bearer desktop-drive-test-token"},
        json={"login": "fixture-login", "phone": "13800000000", **payload},
    )

    # 原版 headless GET 通配路由对未注册的 POST 返回 405。
    assert response.status_code == 405, response.text
    upstream.assert_not_awaited()
    assert list(preview_dir.iterdir()) == [cached]
    assert cached.read_bytes() == b"existing preview"
