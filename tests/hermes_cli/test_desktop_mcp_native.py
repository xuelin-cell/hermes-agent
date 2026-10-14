"""桌面 MCP 原生复用验证：真实 REST、WS 重载和 stdio 工具，不调用模型。"""

import json
from pathlib import Path
import sys

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def native_client(tmp_path, monkeypatch):
    """隔离 Home 与本机状态，仅连接当前测试进程的原生应用。"""
    root = tmp_path / "home"
    root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "roaming"))
    from hermes_cli import profiles
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: root)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: root / "profiles")
    client = TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    try:
        yield client, root, _SESSION_TOKEN
    finally:
        shutdown_mcp_servers()
        client.close()


def server_entry(marker: str, enabled: bool = True) -> dict:
    """使用固定测试解释器运行 stdio 服务，不依赖 PATH 或外部程序。"""
    return {
        "command": sys.executable,
        "args": [str(Path(__file__).with_name("mcp_stdio.fixture.py")), marker],
        "enabled": enabled, "connect_timeout": 10, "tool_timeout": 10,
        "sampling": {"enabled": False}, "elicitation": {"enabled": False},
    }


def save(client, servers: dict, profile: str = "default") -> None:
    """调用桌面使用的完整替换接口，验证保存由后端执行。"""
    response = client.put("/api/mcp/servers", params={"profile": profile}, json={"servers": servers})
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True


def reload_via_ws(ws, request_id: int) -> None:
    """通过真实 WS RPC 重载，跳过通知直到收到对应完成响应。"""
    ws.send_json({"jsonrpc": "2.0", "id": request_id, "method": "reload.mcp", "params": {"confirm": True}})
    for _ in range(100):
        payload = ws.receive_json()
        if payload.get("id") == request_id:
            assert "error" not in payload, payload
            assert payload["result"]["status"] == "reloaded", payload
            return
    pytest.fail("WS 未返回对应重载响应")


def call_marker() -> str:
    """经过原版模型工具分发器调用实际 MCP，不直接伪造工具结果。"""
    from model_tools import handle_function_call
    from tools.registry import registry

    matches = [item for item in registry.get_all_tool_names() if "native_fixture" in item and "echo_marker" in item]
    assert len(matches) == 1, matches
    name = matches[0]
    result = json.loads(handle_function_call(name, {}, task_id="desktop-mcp-fixture"))
    assert "error" not in result, result
    return result["result"]


def test_native_save_reload_disable_remove_and_call(native_client):
    """保存、编辑、启禁用和删除真实影响工具，保存与重载仍为分离操作。"""
    client, root, token = native_client
    from tools.registry import registry

    entry = server_entry("first-marker")
    save(client, {"native_fixture": entry})
    probe = client.post("/api/mcp/servers/native_fixture/test").json()
    assert probe["ok"] is True, probe
    assert any(tool["name"] == "echo_marker" for tool in probe["tools"])
    with client.websocket_connect(f"/api/ws?token={token}") as ws:
        reload_via_ws(ws, 1)
        assert call_marker() == "first-marker"
        save(client, {"native_fixture": server_entry("edited-marker")})
        reload_via_ws(ws, 2)
        assert call_marker() == "edited-marker"
        save(client, {"native_fixture": server_entry("edited-marker", enabled=False)})
        reload_via_ws(ws, 3)
        assert not any("native_fixture" in name for name in registry.get_all_tool_names())
        save(client, {"native_fixture": server_entry("edited-marker")})
        reload_via_ws(ws, 4)
        assert call_marker() == "edited-marker"
        save(client, {})
        reload_via_ws(ws, 5)
        assert not any("native_fixture" in name for name in registry.get_all_tool_names())
    assert client.get("/api/mcp/servers").json()["servers"] == []
    assert (root / "config.yaml").is_file()


def test_native_profile_config_probe_and_call_are_isolated(native_client):
    """同名服务在两个 Profile 中分别保存和执行，A→B→A 结果保持归属。"""
    client, root, _ = native_client
    from hermes_cli.web_server_profiles import _config_profile_scope
    from tools.mcp_tool_discovery import discover_mcp_tools

    for profile in ("work", "other"):
        home = root / "profiles" / profile
        home.mkdir(parents=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
        (home / ".env").write_text("", encoding="utf-8")
        save(client, {"native_fixture": server_entry(profile)}, profile)
    for profile in ("work", "other", "work"):
        response = client.post("/api/mcp/servers/native_fixture/test", params={"profile": profile})
        assert response.status_code == 200, response.text
        assert response.json()["ok"] is True, response.json()
        with _config_profile_scope(profile):
            discover_mcp_tools()
            assert call_marker() == profile
    save(client, {}, "work")
    assert client.get("/api/mcp/servers", params={"profile": "work"}).json()["servers"] == []
    assert len(client.get("/api/mcp/servers", params={"profile": "other"}).json()["servers"]) == 1
    assert client.get("/api/mcp/servers", params={"profile": "default"}).json()["servers"] == []
