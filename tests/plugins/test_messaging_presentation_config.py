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
def test_invalid_or_aliased_config_is_not_overwritten(content):
    """不把损坏配置或共享别名当空对象覆盖。"""
    path = get_config_path()
    path.write_text(content, encoding="utf-8")
    with pytest.raises((ValueError, RuntimeError)):
        policy.prepare_presentation({"wecom"})
    assert path.read_text(encoding="utf-8") == content


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
async def test_mixed_gateway_does_not_disable_other_platform_busy_ack(monkeypatch):
    """共用进程含范围外平台时不使用全局静默，纯四平台才设置。"""
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
    assert "HERMES_GATEWAY_BUSY_ACK_ENABLED" not in api._gateway_environment(state)


def test_qr_save_prepares_weixin_and_leaves_restart_to_shared_desktop_flow():
    """扫码只准备本 Profile，保留扫码人接收目标，再由既有桌面串行接线重启。"""
    from plugins.weixin_qr.dashboard.plugin_api import _apply, _restart
    from hermes_cli.config import load_env

    _apply(
        None,
        {
            "account_id": "fixture@bot",
            "token": "fixture",
            "user_id": "fixture-owner",
            "base_url": "https://fixture.invalid",
        },
    )
    config = require_readable_config_before_write()
    assert config["display"]["language"] == "zh"
    assert config["platforms"]["weixin"]["extra"]["desktop_quiet"] is True
    assert load_env()["WEIXIN_HOME_CHANNEL"] == "fixture-owner"
    assert _restart(None) == {"restart_started": False}


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
    assert "display" not in config
    assert config["platforms"]["feishu"] == {"gateway_restart_notification": False}
    gateway = load_gateway_config()
    assert not gateway.platforms[Platform.FEISHU].enabled
    assert not GatewayShutdownMixin._restart_notification_allowed(
        SimpleNamespace(config=gateway), Platform.FEISHU
    )
