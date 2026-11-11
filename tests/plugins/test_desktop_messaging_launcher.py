"""桌面网关入口与原版进程协议检查，不连接真实消息平台。"""
from importlib import import_module
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

api = import_module("plugins.desktop-messaging.dashboard.plugin_api")
ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "plugins/desktop-messaging/desktop-gateway.py"


@pytest.mark.parametrize("outcome,code", [(True, 0), (False, 1), (SystemExit(None), 0),
                                         (SystemExit(7), 7), (SystemExit("error"), 1),
                                         (KeyboardInterrupt(), 0)])
def test_launcher_injects_single_profile_config_and_keeps_shutdown_contract(outcome, code, tmp_path, monkeypatch):
    """执行搬到资源目录的真实脚本；保留配置与 Runner 选模逻辑，替换外部副作用。"""
    from gateway import run
    from hermes_cli import _startup_fast, _subprocess_compat, boot_bootstrap, gateway, gateway_migrate
    from pm.paths import install_root

    # 不启动网络、数据库或安全工具安装，但仍执行原版构造器的配置选择。
    for name in ("_init_runtime_settings", "_init_session_store", "_init_lifecycle_state",
                 "_init_runtime_caches", "_init_startup_checks", "_init_session_db",
                 "_init_registries_and_clocks"):
        monkeypatch.setattr(run.GatewayRunner, name, lambda self: None)
    migration = Mock(side_effect=AssertionError("must not preflight profiles"))
    monkeypatch.setattr(gateway_migrate, "build_migration_plan", migration)
    # 与原版命令行入口一致：先关系统版本查询弹窗，再规范主目录写法。
    early = []
    monkeypatch.setattr(_subprocess_compat, "suppress_platform_ver_console", lambda: early.append("ver"))
    monkeypatch.setattr(_startup_fast, "normalize_hermes_home_env", lambda: early.append("home"))
    bootstrap = Mock()
    monkeypatch.setattr(boot_bootstrap, "maybe_run_boot_bootstrap", bootstrap)
    steps = []
    import hermes_startup_watchdog
    monkeypatch.setattr(hermes_startup_watchdog, "arm_startup_watchdog", lambda: steps.append("arm"))
    monkeypatch.setattr(gateway, "_windows_gateway_should_absorb_console_controls", lambda: True)
    monkeypatch.setattr(gateway, "_absorb_windows_console_controls", lambda: steps.append("console"))
    monkeypatch.setattr(gateway, "_apply_startup_watchdog_config", lambda: steps.append("watchdog"))
    monkeypatch.setattr(gateway, "_respawn_storm_backoff", lambda: steps.append("backoff"))
    exit_gateway = Mock()
    monkeypatch.setattr(run, "_exit_after_graceful_shutdown", exit_gateway)

    async def start(*, config):
        """检查真实配置注入后直接构造单助手网关，再返回受控退出结果。"""
        assert config.multiplex_profiles is False
        assert run.GatewayRunner(config).config is config
        assert sys.path[0] == str(ROOT)
        assert all(key not in os.environ for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"))
        steps.append("start")
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(run, "start_gateway", start)
    packaged = tmp_path / "resources/python-plugins/desktop-messaging/desktop-gateway.py"
    packaged.parent.mkdir(parents=True)
    shutil.copyfile(SCRIPT, packaged)
    monkeypatch.setattr(sys, "argv", [str(packaged), str(ROOT)])
    monkeypatch.setattr(sys, "path", list(sys.path))
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        monkeypatch.setenv(key, "untrusted-inherited-path")
    runpy.run_path(str(packaged), run_name="__main__")
    bootstrap.assert_called_once_with(install_root())
    assert early == ["ver", "home"]
    migration.assert_not_called()
    exit_gateway.assert_called_once_with(code)
    # 看门狗先于导入网关模块布防，再按配置调整，与原版命令行入口顺序一致。
    assert steps == ["arm", "console", "watchdog", "backoff", "start"]


def test_command_is_recognized_with_windows_spaces():
    """原版 PID 检查及退出归属解析都识别带空格的脚本命令。"""
    from gateway.status import gateway_spawn_intent_subcommand, looks_like_gateway_command_line

    argv = [r"C:\Program Files\UniWork\python.exe", "-I",
            r"C:\Program Files\UniWork\resources\python-plugins\desktop-messaging\desktop-gateway.py",
            r"C:\Program Files\UniWork\backend"]
    command = subprocess.list2cmdline(argv)
    assert looks_like_gateway_command_line(command)
    assert gateway_spawn_intent_subcommand(command) == "run"


@pytest.mark.parametrize("stored_python", [False, True])
def test_spawn_keeps_account_environment_logs_and_action_registry(tmp_path, monkeypatch, stored_python):
    """实际生成环境和日志，仅替换 Popen；资源根与代码根保持不同。"""
    from hermes_cli import _launchers, web_server, web_server_gateway as actions
    from hermes_cli._subprocess_compat import windows_detach_flags

    root = tmp_path / "backend"
    plugin_api = tmp_path / "resources/python-plugins/desktop-messaging/dashboard/plugin_api.py"
    monkeypatch.setattr(web_server, "PROJECT_ROOT", root)
    monkeypatch.setattr(api, "__file__", str(plugin_api))
    python = tmp_path / "runtime/python.exe" if stored_python else None
    monkeypatch.setattr(_launchers, "resolve_store_python", lambda location: python if location == root else pytest.fail("wrong root"))
    monkeypatch.setattr(actions, "_ACTION_LOG_DIR", tmp_path / "actions")
    for name in ("_ACTION_RESULTS", "_ACTION_COMMANDS", "_ACTION_PROCS", "_ACTION_IDS"):
        monkeypatch.setattr(actions, name, {"gateway-start": "stale"})
    logs = []

    def spawn(command, **kwargs):
        """验证启动参数及真实日志句柄，不启动系统进程。"""
        assert command == [str(python or Path(sys.executable)), "-I",
                           str(plugin_api.parents[1] / "desktop-gateway.py"), str(root)]
        assert kwargs["cwd"] == str(root)
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert kwargs["stderr"] == subprocess.STDOUT
        assert Path(kwargs["env"]["HERMES_HOME"]).resolve() == Path(os.environ["HERMES_HOME"]).resolve()
        assert all(kwargs["env"][key] == value for key, value in env.items())
        assert kwargs["creationflags"] == windows_detach_flags() if sys.platform == "win32" else kwargs["start_new_session"]
        logs.append(kwargs["stdout"])
        return SimpleNamespace(pid=123)

    monkeypatch.setattr(subprocess, "Popen", spawn)
    env = api._gateway_environment({"configured": True})
    assert env == {"HERMES_GATEWAY_INSTALL_START_ON_LOGIN": "0",
                   "HERMES_GATEWAY_BUSY_ACK_ENABLED": "false",
                   "HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED": "false",
                   "HERMES_GATEWAY_ADAPTER_DISCONNECT_TIMEOUT": "1"}
    proc = api._spawn_desktop_gateway(env)
    assert actions._ACTION_RESULTS == {}
    assert actions._ACTION_IDS == {}
    assert actions._ACTION_COMMANDS["gateway-start"] == ("-p", "default", "gateway", "run")
    assert actions._ACTION_PROCS["gateway-start"] is proc
    assert logs[0].closed
    assert "=== gateway-start started " in Path(logs[0].name).read_text(encoding="utf-8")
    api._spawn_desktop_gateway({**env, "HERMES_ACTION_ID": "fixture-action"})
    assert actions._ACTION_IDS["gateway-start"] == "fixture-action"


def test_spawn_refuses_foreign_home_before_starting(monkeypatch, tmp_path):
    """主助手环境被错误指向另一账号时，拒绝创建任何进程。"""
    from hermes_cli import web_server_gateway

    monkeypatch.setattr(web_server_gateway, "_profile_action_environment",
                        lambda *args: {"HERMES_HOME": str(tmp_path / "other-account")})
    spawn = Mock(side_effect=AssertionError("must not spawn"))
    monkeypatch.setattr(subprocess, "Popen", spawn)
    with pytest.raises(RuntimeError, match="gateway_identity_unverified"):
        api._spawn_desktop_gateway({})
    spawn.assert_not_called()
