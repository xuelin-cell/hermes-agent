"""阶段二真实配置与原生进程检查；不连接真实消息平台或调用模型。"""
import asyncio
from importlib import import_module
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from types import SimpleNamespace
from urllib.request import urlopen

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from hermes_cli.config import load_env, remove_env_value, save_env_value

api = import_module("plugins.desktop-messaging.dashboard.plugin_api")


def test_restore_scans_real_accounts_a_b_a_and_preserves_parked_profiles(tmp_path, monkeypatch):
    """真实 A→B→A 配置隔离；无配置跳过、启动、复用与旧规则补写各走正确动作。"""
    from hermes_cli import web_server_gateway
    from hermes_cli.profiles import create_profile
    from hermes_cli.web_server_profiles import _config_profile_scope

    actions = []
    running = False

    def spawn(command, name, *, env_overrides):
        """只替换网关动作，配置和受管 Profile 枚举保持真实。"""
        actions.append((os.environ["HERMES_HOME"], command, name))
        assert env_overrides == {"HERMES_GATEWAY_INSTALL_START_ON_LOGIN": "0",
                                 "HERMES_GATEWAY_BUSY_ACK_ENABLED": "false",
            "HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED": "false"}
        return SimpleNamespace(pid=123)

    monkeypatch.setattr(web_server_gateway, "_spawn_hermes_action", spawn)
    monkeypatch.setattr(web_server_gateway, "_has_own_gateway", lambda home: home.name == "independent")
    monkeypatch.setattr(api, "_owned_gateway", lambda: running)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        for account in ["a", "b", "a"]:
            home = tmp_path / account
            home.mkdir(exist_ok=True)
            monkeypatch.setenv("HERMES_HOME", str(home))
            if account == "a" and not (home / "profiles").exists():
                assert client.post("/restore").json()["configured"] is False
                assert not actions
                for name in ["worker", "parked", "standalone", "independent"]:
                    create_profile(name)
                    with _config_profile_scope(name):
                        save_env_value("FEISHU_APP_ID", account)
                        save_env_value("FEISHU_APP_SECRET", "fixture-key")
                (home / "profiles/parked/gateway.parked").touch()
                (home / "profiles/standalone/config.yaml").write_text("gateway:\n  standalone: true\n", encoding="utf-8")
            if account == "b":
                assert client.post("/restore").json()["configured"] is False
                assert not load_env()
                continue
            result = client.post("/restore")
            assert result.status_code == 200, result.text
            assert result.json()["profiles"] == ["worker"]
            assert result.json()["name"] == ("gateway-start" if not running else None)
            running = True
            with _config_profile_scope("worker"):
                assert load_env()["FEISHU_GROUP_POLICY"] == "open"
                assert "GATEWAY_ALLOW_ALL_USERS" not in load_env()
            with _config_profile_scope("parked"):
                assert "FEISHU_GROUP_POLICY" not in load_env()
            with _config_profile_scope("independent"):
                assert "FEISHU_GROUP_POLICY" not in load_env()
        assert len(actions) == 1
        with _config_profile_scope("worker"):
            remove_env_value("FEISHU_GROUP_POLICY")
        assert client.post("/restore").json()["name"] == "gateway-stop"
        assert actions[-1][1][-2:] == ["gateway", "stop"]
        running = False
        assert client.post("/restore").json()["name"] == "gateway-start"
        assert actions[-1][1][-2:] == ["gateway", "run"]
        running = True
        assert client.post("/restore").json()["name"] is None
        # 配置未再变化但连接仍失败时，明确重试必须真的重连，不能只复用旧进程。
        assert client.post("/restore?restart=true").json()["name"] == "gateway-stop"
        assert actions[-1][1][-2:] == ["gateway", "stop"]


def test_ambiguous_gateway_refuses_restore_without_leaking_details(monkeypatch):
    """归属不明不启动也不复用，固定错误不包含底层敏感细节。"""
    from hermes_cli import web_server_gateway

    save_env_value("FEISHU_APP_ID", "fixture-id")
    save_env_value("FEISHU_APP_SECRET", "fixture-key")

    def reject():
        """模拟原版身份检查失败，不操作任何系统进程。"""
        raise RuntimeError("PRIVATE-DETAIL")

    def unexpected(*args):
        """禁止在归属失败之后启动任何动作。"""
        pytest.fail("must not spawn")

    monkeypatch.setattr(api, "_owned_gateway", reject)
    monkeypatch.setattr(web_server_gateway, "_spawn_hermes_action", unexpected)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        response = client.post("/restore")
        assert response.status_code == 409
        assert response.json() == {"detail": "gateway_identity_unverified"}
        assert "PRIVATE" not in response.text


@pytest.mark.platforms("windows")
def test_profile_junction_cannot_write_another_account_policies(tmp_path):
    """真实目录联接越界时，在读取和补写外部账号配置前拒绝。"""
    home = Path(os.environ["HERMES_HOME"])
    external = tmp_path / "outside-account"
    external.mkdir()
    (external / "config.yaml").write_text("{}\n", encoding="utf-8")
    env_file = external / ".env"
    original = "FEISHU_APP_ID=fixture-id\nFEISHU_APP_SECRET=fixture-key\n"
    env_file.write_text(original, encoding="utf-8")
    profiles = home / "profiles"
    profiles.mkdir(exist_ok=True)
    subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(profiles / "linked"), str(external)],
                   capture_output=True, check=True)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        assert client.post("/restore").status_code == 409
    assert env_file.read_text(encoding="utf-8") == original


@pytest.mark.platforms("windows")
@pytest.mark.live_system_guard_bypass
def test_owned_gateway_reuses_real_runtime_and_rejects_live_foreign_home(tmp_path, monkeypatch):
    """实际 run／restart 均将静默开关传入网关，核对归属、健康与复用。"""
    from hermes_cli import web_server_gateway
    import psutil

    monkeypatch.setenv("PYTHONUNBUFFERED", "1")
    home = Path(os.environ["HERMES_HOME"])
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    (home / "config.yaml").write_text(
        f"platforms:\n  api_server:\n    enabled: true\n    extra:\n      host: 127.0.0.1\n      port: {port}\n"
        "      key: fixture-only-test-key-not-a-real-credential\n", encoding="utf-8")
    # 原版目录把 API server 标为无必填凭据，作用域检查不会将它视作已配渠道。
    # 仅替换这一项测试元数据，以本机 API 代替真实 IM；进程与启动／归属链保持真实。
    catalog = api._messaging_platform_catalog()
    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: tuple(
        {**entry, "required_env": ("API_SERVER_KEY",)} if entry["id"] == "api_server" else entry for entry in catalog))
    save_env_value("API_SERVER_KEY", "fixture-only-test-key-not-a-real-credential")
    action_logs = tmp_path / "actions"
    monkeypatch.setattr(web_server_gateway, "_ACTION_LOG_DIR", action_logs)
    assert asyncio.run(api.restore_gateway())["name"] == "gateway-start"
    proc = web_server_gateway._ACTION_PROCS["gateway-start"]
    log = action_logs / web_server_gateway._ACTION_LOG_FILES["gateway-start"]
    actions = [proc]

    def wait_gateway(previous_pid=None):
        """等待临时 Home 的新网关就绪，检查实际进程而非动作包装器的环境。"""
        # Windows restart 还要完成排空、系统启动项检查及再次启动，给完整动作独立预算。
        deadline = time.monotonic() + (120 if previous_pid is not None else 60)
        while time.monotonic() < deadline:
            try:
                identity = json.loads((home / "gateway.pid").read_text())
                state = json.loads((home / "gateway_state.json").read_text())
                if identity["pid"] != previous_pid and state.get("gateway_state") == "running" and api._owned_gateway():
                    process = psutil.Process(identity["pid"])
                    env = process.environ()
                    assert Path(env["HERMES_HOME"]).resolve() == home.resolve()
                    assert env["HERMES_GATEWAY_BUSY_ACK_ENABLED"] == "false"
                    assert env["HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED"] == "false"
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        if response.status == 200:
                            return identity
            except (OSError, ValueError, psutil.NoSuchProcess):
                pass
            time.sleep(0.2)
        logs = [log, home / "logs/gateway-stdio.log", home / "logs/gateway.log"]
        detail = "\n".join(f"{p.name}:\n{p.read_text(encoding='utf-8', errors='replace')[-4000:]}" for p in logs if p.exists())
        detail += f"\naction exit codes: {[p.poll() for p in actions]}"
        pytest.fail("isolated gateway health timed out\n" + detail)

    try:
        identity = wait_gateway()
        assert asyncio.run(api.restore_gateway())["name"] is None
        assert json.loads((home / "gateway.pid").read_text())["pid"] == identity["pid"]
        assert asyncio.run(api.apply_gateway())["name"] == "gateway-restart"
        actions.append(web_server_gateway._ACTION_PROCS["gateway-restart"])
        log = action_logs / web_server_gateway._ACTION_LOG_FILES["gateway-restart"]
        identity = wait_gateway(identity["pid"])
        # 真实进程仍活着，但请求的账号根已不同，不能借用它的状态。
        other = tmp_path / "other-account"
        other.mkdir()
        monkeypatch.setenv("HERMES_HOME", str(other))
        assert not api._owned_gateway()
        assert psutil.pid_exists(identity["pid"])
    finally:
        monkeypatch.setenv("HERMES_HOME", str(home))
        # restart 可能另起脱离动作包装器的进程，只清理已确认归属本测试 Home 的网关。
        if api._owned_gateway():
            pid = json.loads((home / "gateway.pid").read_text())["pid"]
            isolated = psutil.Process(pid)
            assert Path(isolated.environ()["HERMES_HOME"]).resolve() == home.resolve()
            if isolated.is_running():
                subprocess.run(["taskkill.exe", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=15, check=False)
        for action in actions:
            if action.poll() is None:
                subprocess.run(["taskkill.exe", "/PID", str(action.pid), "/T", "/F"], capture_output=True, timeout=15, check=False)
            action.wait(timeout=15)
