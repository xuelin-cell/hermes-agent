"""A desktop pick updates the model used by the gateway for the same conversation."""

import asyncio
from types import SimpleNamespace

from agent.secret_scope import is_multiplex_active, set_multiplex_active
from gateway.config import GatewayConfig, Platform
from gateway.control_socket import query_gateway_control
from gateway.run import GatewayRunner, _profile_runtime_scope, _start_gateway_start_control_socket
from gateway.session import SessionSource, SessionStore
from hermes_state import SessionDB
from tui_gateway import server
from tui_gateway.methods_session import _Resume
from tui_gateway.prompt_turn import _TurnRun


def test_desktop_model_pick_reaches_live_messaging_gateway_and_survives_restart(tmp_path, monkeypatch):
    import hermes_state

    home = tmp_path / "hermes"
    other = home / "profiles" / "team"
    other.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", hermes_state._IMPORT_DEFAULT_DB_PATH)
    monkeypatch.setattr("hermes_cli.profiles._get_default_hermes_home", lambda: home)
    monkeypatch.setattr("hermes_cli.profiles._get_profiles_root", lambda: home / "profiles")
    monkeypatch.setattr("hermes_cli.models_validate.validate_requested_model",
                        lambda *args, **kwargs: {"accepted": True, "recognized": True, "persist": True})
    for index, path in enumerate((home, other)):
        (path / "config.yaml").write_text(
            "model:\n  default: default-model\n  provider: custom:team-endpoint\n"
            "providers:\n  team-endpoint:\n    name: Team endpoint\n"
            f"    base_url: https://example-{index}.invalid/v1\n"
            f"    api_key: local-test-key-{index}\n"
            "    model: default-model\n    models: [default-model, picked-model, another-model]\n"
            "    discover_models: false\n",
            encoding="utf-8",
        )

    def runner():
        instance = object.__new__(GatewayRunner)
        instance.config = GatewayConfig(multiplex_profiles=True)
        instance._primary_profile_name = "default"
        instance.session_store = SessionStore(home / "sessions", instance.config)
        return instance

    async def exercise():
        gateway = runner()
        sources = [SessionSource(platform=Platform.WEIXIN, chat_id="same-chat", profile=profile)
                   for profile in (None, "team")]
        entries = []
        for source, path in zip(sources, (home, other)):
            with _profile_runtime_scope(path, prepared_secret_scope={}):
                entries.append(gateway.session_store.get_or_create_session(source))
        assert entries[0].session_key != entries[1].session_key
        control = await _start_gateway_start_control_socket(gateway)
        assert control is not None
        try:
            with SessionDB(db_path=home / "state.db") as desktop_db:
                monkeypatch.setattr(server, "_get_db", lambda: desktop_db)
                monkeypatch.setattr(server, "_commit_agent_switch", lambda *args: None)
                monkeypatch.setattr(server, "_sessions_quiescent", lambda **kwargs: False)
                for index, model, busy in ((0, "picked-model", False), (1, "another-model", False),
                                           (0, "another-model", True)):
                    entry = entries[index]
                    path = (home, other)[index]
                    runtime = f"desktop-{index}"
                    session = {
                        "session_key": entry.session_id, "profile_home": str(other) if index else None,
                        "agent": SimpleNamespace(model="default-model", provider="custom:team-endpoint"),
                        "running": busy,
                    }
                    monkeypatch.setitem(server._sessions, runtime, session)
                    response = await asyncio.to_thread(server.handle_request, {
                        "id": "pick", "method": "config.set", "params": {
                            "session_id": runtime, "key": "model",
                            "value": f"{model} --provider custom:team-endpoint --session",
                        },
                    })
                    result = response.get("result", {})
                    assert result.get("value") == model and not result.get("warning"), response
                    if busy:
                        assert result["deferred"] is True
                        assert gateway.session_store.get_model_override(entry.session_key)["model"] == "picked-model"
                        turn = _TurnRun(session["agent"], None, None, True)
                        await asyncio.to_thread(server._finish_turn, runtime, session, turn)
                    with _profile_runtime_scope(path, prepared_secret_scope={}):
                        selected, kwargs = gateway._resolve_session_agent_runtime(
                            source=sources[index], session_key=entry.session_key)
                    assert selected == model
                    assert kwargs["base_url"] == f"https://example-{index}.invalid/v1"
                    assert kwargs["api_key"] == f"local-test-key-{index}"
                    assert desktop_db.gateway_routing_entry_for_session(entry.session_id)["model_override"] == {
                        "model": model, "provider": "custom:team-endpoint",
                    }
                    if index == 1:
                        assert gateway.session_store.get_model_override(entries[0].session_key)["model"] == "picked-model"

                # An archived desktop tab must not change the new live conversation at its route.
                entry = entries[0]
                response = await asyncio.to_thread(
                    query_gateway_control, home, "set-session-model", params={
                        "session_key": entry.session_key, "session_id": "archived",
                        "home": str(home), "model": "default-model", "provider": "custom:team-endpoint",
                    })
                assert response == {"applied": False}

                # A desktop resume uses the explicit pick even when an older reply left stale runtime metadata.
                ctx = object.__new__(_Resume)
                ctx.db, ctx.target, ctx.profile_home = desktop_db, entry.session_id, None
                ctx.found = {"model": "default-model", "source": "weixin"}
                assert ctx.runtime_overrides()["model_override"]["model"] == "another-model"
        finally:
            await control.stop()
            gateway.session_store.close_all_db_handles()

        restarted = runner()
        try:
            with _profile_runtime_scope(home, prepared_secret_scope={}):
                selected, kwargs = restarted._resolve_session_agent_runtime(
                    source=sources[0], session_key=entries[0].session_key)
            assert selected == "another-model"
            assert kwargs["api_key"] == "local-test-key-0"
        finally:
            restarted.session_store.close_all_db_handles()

    previous = is_multiplex_active()
    set_multiplex_active(True)
    try:
        asyncio.run(exercise())
    finally:
        set_multiplex_active(previous)
