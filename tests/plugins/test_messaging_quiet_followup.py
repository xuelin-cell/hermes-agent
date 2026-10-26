"""第二轮展示回归：真实 Profile 配置、忙碌处理及语言目录，不连接外部平台。"""

from collections import Counter
from importlib import import_module
import json
from pathlib import Path
import re
from string import Formatter
from unittest.mock import MagicMock

import pytest

import hermes_yaml as yaml
from hermes_cli.config import atomic_config_write, get_config_path, require_readable_config_before_write

api = import_module("plugins.desktop-messaging.dashboard.plugin_api")
MARKER = "memory_notifications_initialized"


@pytest.mark.asyncio
@pytest.mark.parametrize("initial,expected", [(None, "off"), ("on", "off"), (True, "off"),
                                             ("off", "off"), (False, False), ("verbose", "verbose")])
async def test_memory_default_is_prepared_once_without_messaging(initial, expected, monkeypatch):
    """无平台也准备记忆展示；尊重已有显式选择，之后改回 on 不再覆盖。"""
    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: [])
    path = get_config_path()
    original = {"display": {"memory_notifications": initial},
                "auxiliary": {"background_review": {"enabled": True}}, "memory": {"enabled": True}}
    atomic_config_write(path, original)
    state = await api.prepare()
    assert not state["configured"] and not state["changed"]
    config = require_readable_config_before_write(path)
    assert config["display"]["memory_notifications"] == expected
    assert config["plugins"]["entries"]["desktop-messaging"]["settings"][MARKER] is True
    from hermes_cli.config import _validate_config_key

    assert _validate_config_key(f"plugins.entries.desktop-messaging.settings.{MARKER}") == (True, None)
    assert config["auxiliary"] == original["auxiliary"] and config["memory"] == original["memory"]
    assert "platforms" not in config
    stamp = path.stat().st_mtime_ns
    await api.prepare()
    assert path.stat().st_mtime_ns == stamp
    config["display"]["memory_notifications"] = "on"
    atomic_config_write(path, config)
    await api.prepare()
    assert require_readable_config_before_write(path)["display"]["memory_notifications"] == "on"


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["display: broken\n", "[broken\n", "plugins: broken\n",
                                     "shared: &p {}\nplugins: *p\n", "display: &d {}\nother: *d\n"])
async def test_memory_invalid_config_is_preserved(content, monkeypatch):
    """记忆配置损坏或待写容器被复用时跳过，不阻断空平台恢复，不覆盖原文件。"""
    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: [])
    path = get_config_path()
    path.write_text(content, encoding="utf-8", newline="\n")
    assert not (await api.restore_gateway())["configured"]
    assert path.read_text(encoding="utf-8") == content


@pytest.mark.asyncio
async def test_memory_write_failure_does_not_complete_initialization(monkeypatch):
    """原子保存失败后保留原配置，下一次恢复仍能重新准备。"""
    policy = api.presentation
    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: [])
    path = get_config_path()
    path.write_text("# keep\ndisplay: {memory_notifications: on}\n", encoding="utf-8", newline="\n")
    before = path.read_bytes()

    def fail(*args):
        """模拟写盘失败，不接触真实账号。"""
        raise OSError("fixture disk failure")

    with monkeypatch.context() as scoped:
        scoped.setattr(policy, "atomic_config_write", fail)
        await api.prepare()
    assert path.read_bytes() == before
    await api.prepare()
    assert require_readable_config_before_write(path)["display"]["memory_notifications"] == "off"
    assert "# keep" in path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_memory_profiles_a_b_a_and_runtime_readers(tmp_path, monkeypatch):
    """真实受管 Profile 隔离及两种运行时读取；停用、独立和独占网关环境不写。"""
    from hermes_cli.profiles import create_profile
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_cli import web_server_gateway
    from gateway.run import _load_gateway_config
    from tui_gateway.server import _load_memory_notifications
    from agent.background_review import summarize_background_review_actions

    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: [])
    monkeypatch.setattr(web_server_gateway, "_has_own_gateway", lambda home: home.name == "independent")
    snapshots = {}
    for account in ["a", "b", "a"]:
        home = tmp_path / account
        home.mkdir(exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        if not (home / "profiles").exists():
            for name in ["worker", "parked", "standalone", "independent"]:
                create_profile(name)
                (home / "profiles" / name / "config.yaml").write_text("{}\n", encoding="utf-8", newline="\n")
            (home / "profiles/parked/gateway.parked").touch()
            (home / "profiles/standalone/config.yaml").write_text(
                "gateway: {standalone: true}\n", encoding="utf-8", newline="\n")
        excluded = {p: (home / "profiles" / p / "config.yaml").read_bytes()
                    for p in ["parked", "standalone", "independent"]}
        await api.prepare()
        for other, before in snapshots.items():
            assert (tmp_path / other / "config.yaml").read_bytes() == before
        for profile in ["default", "worker"]:
            with _config_profile_scope(profile):
                mode = _load_memory_notifications()
                assert mode == "off"
                assert _load_gateway_config()["display"]["memory_notifications"] == mode
                assert summarize_background_review_actions([], [], mode) == []
        for profile, before in excluded.items():
            assert (home / "profiles" / profile / "config.yaml").read_bytes() == before
        snapshots[account] = (home / "config.yaml").read_bytes()
    assert (tmp_path / "b/config.yaml").exists()


@pytest.mark.asyncio
async def test_hidden_memory_review_keeps_proposal_pending(tmp_path, monkeypatch):
    """真实记忆替换仍进入审批；关闭通知不应用或丢弃建议。"""
    from agent.background_review import summarize_background_review_actions
    from hermes_cli.web_server_profiles import _config_profile_scope
    from tools.memory_tool import MemoryStore, memory_tool
    from tools.skill_provenance import reset_current_write_origin, set_current_write_origin
    from tui_gateway.server import _load_memory_notifications

    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: [])
    monkeypatch.setattr("tools.memory_tool.get_memory_dir", lambda: tmp_path / "memory")
    store = MemoryStore(memory_char_limit=500, user_char_limit=300)
    store.load_from_disk()
    assert store.add("memory", "standing rule entry")["success"]
    before = list(store._entries_for("memory"))
    token = set_current_write_origin("background_review")
    try:
        raw = memory_tool(action="replace", old_text="standing rule", content="consolidated entry", store=store)
    finally:
        reset_current_write_origin(token)
    result = json.loads(raw)
    assert result["staged"] and result["proposal_staged"]
    messages = [
        {"role": "assistant", "tool_calls": [{"id": "c1", "function": {
            "name": "memory", "arguments": json.dumps({"action": "replace"})}}]},
        {"role": "tool", "tool_call_id": "c1", "content": raw},
    ]
    assert any("staged for your approval" in line for line in summarize_background_review_actions(messages, []))
    await api.prepare()
    with _config_profile_scope("default"):
        assert summarize_background_review_actions(messages, [], _load_memory_notifications()) == []
    assert store._entries_for("memory") == before


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["interrupt", "queue", "steer", "redirect", "steer_fallback"])
async def test_managed_mixed_busy_input_is_silent_after_config_bridge(mode, monkeypatch):
    """实际配置桥接后调用原版忙碌入口；混用网关保留输入、无回执、无首次教程。"""
    from gateway.config import Platform
    from gateway.platforms.base import SessionSource, build_session_key
    from gateway.platforms.event import MessageEvent, MessageType
    from gateway.run import _bridge_config_to_env
    from hermes_cli.config import save_env_value
    from tests.gateway.test_busy_session_ack import _make_adapter, _make_runner

    monkeypatch.setattr(api, "_messaging_platform_catalog", lambda: [
        {"id": "feishu", "required_env": ("FEISHU_APP_ID", "FEISHU_APP_SECRET")},
        {"id": "uniagentgate", "required_env": ("FIXTURE_5G_SECRET",)}])
    for name in ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FIXTURE_5G_SECRET"]:
        save_env_value(name, "fixture")
    atomic_config_write(get_config_path(), {"display": {"busy_ack_enabled": True, "busy_steer_ack_enabled": True}})
    state = await api.prepare()
    for key, value in api._gateway_environment(state).items():
        monkeypatch.setenv(key, value)
    _bridge_config_to_env(require_readable_config_before_write())
    runner, _ = _make_runner()
    runner._busy_input_mode = {"redirect": "interrupt", "steer_fallback": "steer"}.get(mode, mode)
    source = SessionSource(platform=Platform.FEISHU, chat_id="chat", chat_type="dm", user_id="user")
    event = MessageEvent(text="请改用另一张图", source=source, message_type=MessageType.TEXT)
    key = build_session_key(source)
    adapter = _make_adapter("feishu")
    runner.adapters[source.platform] = adapter
    agent = MagicMock()
    agent.steer.return_value = mode != "steer_fallback"
    agent._supports_active_turn_redirect = mode == "redirect"
    agent.redirect.return_value = True
    runner._running_agents[key] = agent
    assert await runner._handle_active_session_busy_message(event, key)
    adapter._send_with_retry.assert_not_awaited()
    if mode in {"steer", "redirect"}:
        assert getattr(agent, mode).call_args.args[0].endswith(event.text)
        assert key not in adapter._pending_messages
    else:
        assert adapter._pending_messages[key].text == event.text
    assert agent.interrupt.call_count == (mode == "interrupt")


def test_chinese_catalog_messages_and_format_contract():
    """真实目录中文说明不漏翻，键、占位符及命令别名与英文保持一致。"""
    from agent.i18n import _flatten_into

    root = Path(__file__).resolve().parents[2] / "locales"
    en, zh = {}, {}
    _flatten_into(yaml.safe_load((root / "en.yaml").read_text(encoding="utf-8")), "", en)
    _flatten_into(yaml.safe_load((root / "zh.yaml").read_text(encoding="utf-8")), "", zh)
    assert en.keys() == zh.keys()
    formatter = Formatter()
    for key in en:
        assert Counter(field for _, field, _, _ in formatter.parse(en[key]) if field is not None) == Counter(
            field for _, field, _, _ in formatter.parse(zh[key]) if field is not None), key
    messages = [key for key in en if key.startswith(("gateway.context.", "gateway.status.matrix_scope"))]
    messages += ["gateway.status.model", "gateway.status.model_provider", "gateway.status.tokens",
                 "gateway.resume.parse_error", "gateway.resume.matrix_no_named_sessions",
                 "gateway.resume.matrix_blocked_no_origin", "gateway.resume.matrix_blocked_other_room",
                 "gateway.resume.matrix_cross_room_success", "gateway.resume.blocked_not_owner"]
    for key in messages:
        if key != "gateway.context.bar":
            assert re.search("[\u3400-\u9fff]", zh[key]), key
    for key in ["approval.smart_deny_once_inputs", "approval.smart_deny_deny_inputs",
                "gateway.context.bar", "gateway.fast.label_fast", "gateway.fast.status_fast"]:
        assert en[key] == zh[key]
