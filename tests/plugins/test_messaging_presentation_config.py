"""真实配置读写、展示解析与作用域验证，不连接消息平台。"""

from importlib import import_module
from pathlib import Path

import pytest

from gateway.config import PlatformConfig
from gateway.display_config import resolve_display_setting
from hermes_cli.config import get_config_path, require_readable_config_before_write

policy = import_module("plugins.desktop-messaging.dashboard.presentation")
api = import_module("plugins.desktop-messaging.dashboard.plugin_api")


def test_quiet_config_is_idempotent_and_preserves_other_platforms_and_settings():
    """旧显式展示值被更新；模型、凭据、原生流、5G 和注释不变。"""
    path = get_config_path()
    path.write_text(
        "# user settings\nmodel: custom\nplatforms:\n  feishu:\n    token: fixture\n"
        "    home_channel: {platform: feishu, chat_id: owner}\n  uniagentgate: {enabled: true}\n"
        "display:\n  language: en\n  platforms:\n    feishu: {tool_progress: all, streaming: true}\n"
        "    uniagentgate: {tool_progress: all}\n",
        encoding="utf-8",
    )
    before = require_readable_config_before_write(path)
    assert policy.prepare_presentation({"feishu"})
    after = require_readable_config_before_write(path)
    assert after["model"] == before["model"]
    assert after["platforms"]["feishu"]["token"] == "fixture"
    assert (
        after["platforms"]["feishu"]["home_channel"]
        == before["platforms"]["feishu"]["home_channel"]
    )
    assert after["platforms"]["uniagentgate"] == before["platforms"]["uniagentgate"]
    assert (
        after["display"]["platforms"]["uniagentgate"]
        == before["display"]["platforms"]["uniagentgate"]
    )
    assert "# user settings" in path.read_text(encoding="utf-8")
    for key, value in policy.QUIET_DISPLAY.items():
        assert resolve_display_setting(after, "feishu", key) == value
    assert resolve_display_setting(after, "feishu", "streaming") is True
    parsed = PlatformConfig.from_dict(after["platforms"]["feishu"])
    assert (
        parsed.extra["notice_delivery"] == "private"
        and parsed.extra["desktop_quiet"] is True
    )
    assert parsed.gateway_restart_notification is False
    stat = path.stat().st_mtime_ns
    assert not policy.prepare_presentation({"feishu"})
    assert path.stat().st_mtime_ns == stat
    from gateway.config import Platform, load_gateway_config
    from gateway.run_shutdown import GatewayShutdownMixin
    from types import SimpleNamespace

    gateway = load_gateway_config()
    runner = SimpleNamespace(config=gateway)
    assert not GatewayShutdownMixin._restart_notification_allowed(
        runner, Platform.FEISHU
    )
    assert gateway.platforms[Platform.FEISHU].extra["desktop_quiet"] is True


@pytest.mark.parametrize(
    "content",
    ["display: broken\n", "[broken\n", "display: &shared {}\nplatforms: *shared\n"],
)
def test_invalid_or_aliased_config_is_skipped_without_raising(content):
    """损坏配置或共享别名不被覆盖，也不抛错阻断保存和启动。"""
    path = get_config_path()
    path.write_text(content, encoding="utf-8")
    assert not policy.prepare_presentation({"wecom"})
    assert path.read_text(encoding="utf-8") == content


def test_yaml_reuse_outside_display_and_platforms_is_allowed():
    """其它节的 YAML 复用不会串写消息配置，不能因此拒绝准备。"""
    path = get_config_path()
    path.write_text(
        "defaults: &defaults {retries: 2, tags: [a]}\nproviders:\n  main: *defaults\n"
        "  backup: {<<: *defaults, name: b}\n",
        encoding="utf-8",
    )
    assert policy.prepare_presentation({"wecom"})
    config = require_readable_config_before_write(path)
    assert config["platforms"]["wecom"]["extra"]["desktop_quiet"] is True
    assert config["providers"]["main"] == {"retries": 2, "tags": ["a"]}


def test_language_is_set_once_and_user_choice_is_kept():
    """未设置或默认 en 时写中文；用户之后改的语言、原本选的其它语言都不覆盖。"""
    path = get_config_path()
    path.write_text("display:\n  language: en\n", encoding="utf-8")
    assert policy.prepare_presentation({"feishu"})
    config = require_readable_config_before_write(path)
    assert config["display"]["language"] == "zh"
    config["display"]["language"] = "en"
    from hermes_cli.config import atomic_config_write

    atomic_config_write(path, config)
    assert not policy.prepare_presentation({"feishu"})
    assert policy.prepare_presentation({"wecom"})
    assert require_readable_config_before_write(path)["display"]["language"] == "en"
    path.write_text("display:\n  language: ja\n", encoding="utf-8")
    policy.prepare_presentation({"feishu"})
    assert require_readable_config_before_write(path)["display"]["language"] == "ja"


@pytest.mark.asyncio
@pytest.mark.parametrize("channels", ["four", "mixed", "5g"])
async def test_host_explicit_busy_ack_is_cleared_for_managed_gateway(monkeypatch, channels):
    """宿主旧开关不能覆盖受管网关静默；混用和只有 5G 时也要生效。"""
    from hermes_cli.config import save_env_value

    catalog = [] if channels == "5g" else [{"id": "feishu", "required_env": ("FEISHU_APP_ID", "FEISHU_APP_SECRET")}]
    if channels != "four":
        catalog.append({"id": "uniagentgate", "required_env": ("FIXTURE_5G_SECRET",)})
        save_env_value("FIXTURE_5G_SECRET", "fixture")
    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: catalog)
    save_env_value("FEISHU_APP_ID", "fixture")
    save_env_value("FEISHU_APP_SECRET", "fixture")
    get_config_path().write_text(
        "display:\n  busy_ack_enabled: true\n  busy_input_mode: queue\n", encoding="utf-8"
    )
    state = await api.prepare()
    display = require_readable_config_before_write()["display"]
    assert display["busy_input_mode"] == "queue"
    assert "busy_ack_enabled" not in display
    env = api._gateway_environment(state)
    assert env["HERMES_GATEWAY_BUSY_ACK_ENABLED"] == "false"
    assert env["HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED"] == "false"


def test_config_lock_is_shared_per_profile_and_reentrant(tmp_path, monkeypatch):
    """扫码线程和桌面准备拿到同一把可重入锁；不同账号互不阻塞。"""
    first = policy.config_lock()
    assert policy.config_lock() is first
    with first:
        with policy.config_lock():
            pass
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert policy.config_lock() is not first


def test_real_accounts_and_profiles_keep_scoped_language_and_native_stream(
    tmp_path, monkeypatch
):
    """真实 A→B→A 及命名 Profile，中文不串到其它账号；企微流式保持原版。"""
    from agent.i18n import get_language, reset_language_cache, t
    from hermes_cli.profiles import create_profile
    from hermes_cli.web_server_profiles import _config_profile_scope

    monkeypatch.delenv("HERMES_LANGUAGE", raising=False)
    for account in ["a", "b", "a"]:
        home = tmp_path / account
        home.mkdir(exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        if account == "b":
            assert not policy.prepare_presentation({"uniagentgate"})
            assert not get_config_path().exists()
            reset_language_cache()
            assert get_language() == "en"
            continue
        if not (home / "profiles/worker").exists():
            create_profile("worker")
        with _config_profile_scope("worker"):
            policy.prepare_presentation(set(policy.PLATFORMS))
            reset_language_cache()
            assert get_language() == "zh"
            assert t("gateway.stop.no_active") != t("gateway.stop.no_active", lang="en")
            config = require_readable_config_before_write()
            assert resolve_display_setting(config, "wecom", "streaming") is True
            assert "home_channel" not in config["platforms"]["wecom"]
        assert not Path(home / "config.yaml").exists()


@pytest.mark.asyncio
async def test_mixed_gateway_keeps_busy_ack_disabled(monkeypatch):
    """增加 5G 后仍保留受管网关静默，平台配置本身保持不变。"""
    from hermes_cli.config import save_env_value

    monkeypatch.setattr(
        api,
        "_messaging_platform_catalog",
        lambda: [
            {"id": "feishu", "required_env": ("FEISHU_APP_ID", "FEISHU_APP_SECRET")},
            {"id": "uniagentgate", "required_env": ("FIXTURE_5G_SECRET",)},
        ],
    )
    save_env_value("FEISHU_APP_ID", "fixture")
    save_env_value("FEISHU_APP_SECRET", "fixture")
    state = await api.prepare()
    assert api._gateway_environment(state)["HERMES_GATEWAY_BUSY_ACK_ENABLED"] == "false"
    save_env_value("FIXTURE_5G_SECRET", "fixture")
    state = await api.prepare()
    assert api._gateway_environment(state)["HERMES_GATEWAY_BUSY_ACK_ENABLED"] == "false"


QR_CREDS = {
    "account_id": "fixture@bot",
    "token": "fixture",
    "user_id": "fixture-owner",
    "base_url": "https://fixture.invalid",
}


def test_qr_save_prepares_weixin_profile():
    """扫码只准备本 Profile，保留扫码人接收目标。"""
    from plugins.weixin_qr.dashboard.plugin_api import _apply
    from hermes_cli.config import load_env

    _apply(None, QR_CREDS)
    config = require_readable_config_before_write()
    assert config["display"]["language"] == "zh"
    assert config["platforms"]["weixin"]["enabled"] is True
    assert config["platforms"]["weixin"]["extra"]["desktop_quiet"] is True
    assert load_env()["WEIXIN_HOME_CHANNEL"] == "fixture-owner"


def test_qr_save_still_enables_weixin_when_presentation_is_skipped():
    """展示配置被拒时，已保存的凭据和启用状态照常生效，不报保存失败。"""
    from plugins.weixin_qr.dashboard.plugin_api import _apply
    from hermes_cli.config import load_env

    get_config_path().write_text("display: broken\n", encoding="utf-8")
    _apply(None, QR_CREDS)
    config = require_readable_config_before_write()
    assert config["platforms"]["weixin"]["enabled"] is True
    assert config["display"] == "broken"
    assert load_env()["WEIXIN_TOKEN"] == "fixture"


@pytest.mark.asyncio
async def test_qr_restart_uses_loaded_desktop_messaging_without_page(monkeypatch):
    """扫码后由后端走统一准备与重启；未加载或失败时让页面回退到重试。"""
    import sys
    from types import SimpleNamespace
    from plugins.weixin_qr.dashboard import plugin_api as qr

    for name in qr._DESKTOP_MESSAGING_MODULES:
        monkeypatch.delitem(sys.modules, name, raising=False)
    assert await qr._restart() == {"restart_started": False}

    async def apply_gateway():
        return {"ok": True, "name": "gateway-restart", "pid": 7}

    monkeypatch.setitem(
        sys.modules, qr._DESKTOP_MESSAGING_MODULES[0], SimpleNamespace(apply_gateway=apply_gateway)
    )
    assert await qr._restart() == {
        "restart_started": True, "restart_action": "gateway-restart", "restart_pid": 7}

    async def failing():
        raise RuntimeError("gateway_identity_unverified")

    monkeypatch.setitem(
        sys.modules, qr._DESKTOP_MESSAGING_MODULES[0], SimpleNamespace(apply_gateway=failing)
    )
    assert (await qr._restart())["restart_started"] is False


@pytest.mark.asyncio
async def test_secondary_only_platform_suppresses_host_shutdown_notice_without_enabling_host():
    """子 Profile 独有飞书也静默停机；宿主不继承其凭据、语言和启用状态。"""
    from types import SimpleNamespace
    from gateway.config import Platform, load_gateway_config
    from gateway.run_shutdown import GatewayShutdownMixin
    from hermes_cli.config import save_env_value
    from hermes_cli.profiles import create_profile
    from hermes_cli.web_server_profiles import _config_profile_scope

    create_profile("worker")
    with _config_profile_scope("worker"):
        save_env_value("FEISHU_APP_ID", "fixture")
        save_env_value("FEISHU_APP_SECRET", "fixture")
    await api.prepare()
    config = require_readable_config_before_write()
    assert config["display"] == {"memory_notifications": "off"}
    assert config["platforms"]["feishu"] == {"gateway_restart_notification": False}
    gateway = load_gateway_config()
    assert not gateway.platforms[Platform.FEISHU].enabled
    assert not GatewayShutdownMixin._restart_notification_allowed(
        SimpleNamespace(config=gateway), Platform.FEISHU
    )
