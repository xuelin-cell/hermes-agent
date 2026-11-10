"""Messaging reset uses real profile databases and removes transcript snapshots only."""
from importlib import import_module

from hermes_state import SessionDB

reset = import_module("plugins.desktop-messaging.dashboard.reset_history").reset_platform_history


def test_reset_keeps_desktop_and_other_profile_history(tmp_path):
    homes = [tmp_path / name for name in ("a", "b")]
    for home in homes:
        home.mkdir()
        (home / "sessions").mkdir()
        db = SessionDB(home / "state.db")
        try:
            for sid, source in (("phone", "weixin"), ("desktop", "desktop"), ("unconnected", "dingtalk")):
                db.create_session(sid, source)
                db.append_message(sid, "user", "keep or clear by platform")
                (home / "sessions" / f"{sid}.jsonl").write_text("snapshot", encoding="utf-8")
        finally:
            db.close()
        (home / "user-file.txt").write_text("preserve", encoding="utf-8")
    assert reset(homes[0], {"weixin"}) == 1
    for home, phone_exists in ((homes[0], False), (homes[1], True), (homes[0], False)):
        db = SessionDB(home / "state.db")
        try:
            assert bool(db.get_session("phone")) is phone_exists
            assert db.get_session("desktop") is not None
            assert db.get_session("unconnected") is not None
        finally:
            db.close()
        assert (home / "sessions" / "phone.jsonl").exists() is phone_exists
        assert (home / "user-file.txt").read_text(encoding="utf-8") == "preserve"


def test_idle_renewal_uses_real_session_boundary_and_does_not_interrupt(tmp_path, monkeypatch):
    import asyncio
    from datetime import datetime, timedelta
    from types import SimpleNamespace
    from gateway.config import GatewayConfig
    from gateway.session import SessionSource, SessionStore
    from gateway.config import Platform

    home = tmp_path / "idle-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / "config.yaml").write_text("desktop:\n  messaging_auto_new_session: true\nplugins:\n  enabled: [desktop-messaging]\n", encoding="utf-8")
    store = SessionStore(home / "sessions", GatewayConfig())
    source = SessionSource(platform=Platform.WEIXIN, chat_id="one", user_id="user", chat_type="dm")
    entry = store.get_or_create_session(source)
    entry.updated_at = datetime.now() - timedelta(hours=7)
    key = entry.session_key
    busy = [True]
    gateway = SimpleNamespace(_is_user_authorized_for_source=lambda _: True,
                              _hm_effective_session_key_for_source=lambda _: key,
                              _is_session_running=lambda _: busy[0])
    event = SimpleNamespace(source=source, text="continue")
    from hermes_cli.plugins import PluginManager
    manager = PluginManager()
    manager.discover_and_load()
    assert any(item["name"] == "desktop-messaging" and item["enabled"] and not item["error"] for item in manager.list_plugins())
    asyncio.run(manager.ainvoke_hook("pre_gateway_dispatch", event=event, gateway=gateway, session_store=store))
    assert not store.lookup_by_session_key(key).suspended
    busy[0] = False
    asyncio.run(manager.ainvoke_hook("pre_gateway_dispatch", event=event, gateway=gateway, session_store=store))
    assert store.lookup_by_session_key(key).suspended
    assert store.get_or_create_session(source).session_id != entry.session_id
