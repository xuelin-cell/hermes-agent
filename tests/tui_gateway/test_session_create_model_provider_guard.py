"""``session.create`` rejects a model the selected provider cannot serve (#96817).

Before the gate the session was minted and the FIRST turn died with the provider's 404 — a dead
chat. Custom / unknown providers and same-family or unlisted names stay permissive.
"""

import logging

import pytest


@pytest.fixture
def _create(monkeypatch, tmp_path):
    monkeypatch.setattr("hermes_cli.banner.prefetch_update_check", lambda: None)
    from tui_gateway import server

    (tmp_path / "config.yaml").write_text("model:\n  default: claude-opus-5\n  provider: anthropic\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    monkeypatch.setattr(server, "_profile_home", lambda *a: None)
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *a: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(server, "_register_session_cwd", lambda *a: None)
    monkeypatch.setattr(server, "_project_info_for_cwd", lambda *a: None)
    return lambda params: (server._methods["session.create"]("r1", {"cols": 80, **params}), server._sessions)


@pytest.mark.parametrize("params", [
    {"model": "gpt-5.5", "provider": "anthropic"},
    {"model": "gpt-5.5"},  # provider implied by the profile config
    {"model": "deepseek/deepseek-v4-flash-0731", "provider": "openai-codex"},  # the incident pair
])
def test_session_create_rejects_incoherent_model_provider_pair_before_any_state(_create, params):
    response, sessions = _create(params)

    error = response["error"]
    assert error["code"] == -32602
    assert params["model"] in error["message"]
    assert error["data"]["provider"] in error["message"]
    assert error["data"]["model"] == params["model"]
    assert 1 <= len(error["data"]["suggestions"]) <= 5
    assert all(s in error["message"] for s in error["data"]["suggestions"])
    assert sessions == {}


@pytest.mark.parametrize("params", [
    {"model": "claude-opus-5", "provider": "anthropic"},  # coherent
    {"model": "claude-opus-5-20261001", "provider": "anthropic"},  # same family, not (yet) listed
    {"model": "gpt-5.5", "provider": "custom:local"},  # custom endpoint: Hermes cannot know its models
    {"model": "gpt-5.5", "provider": "openrouter"},  # aggregator
])
def test_session_create_keeps_coherent_unlisted_and_custom_pairs(_create, params):
    response, sessions = _create(params)

    assert "error" not in response, response
    session = sessions[response["result"]["session_id"]]
    assert session["model_override"] == {"model": params["model"], "provider": params["provider"]}


def test_session_create_logs_when_a_client_override_beats_the_profile_default(_create, caplog, monkeypatch):
    """A composer pick silently decided every new chat's model; agent.log must name it (#107410)."""
    from tui_gateway import server

    monkeypatch.setattr(server, "_session_default_model", lambda session: "deepseek-v4-flash")
    with caplog.at_level(logging.INFO):
        response, _ = _create({"model": "gpt-5.5", "provider": "openrouter"})
        pinned = [r.getMessage() for r in caplog.records if "client override" in r.getMessage()]
        caplog.clear()
        _create({})
        unpinned = [r.getMessage() for r in caplog.records if "client override" in r.getMessage()]

    assert len(pinned) == 1
    assert response["result"]["stored_session_id"] in pinned[0]
    assert "gpt-5.5" in pinned[0] and "openrouter" in pinned[0] and "deepseek-v4-flash" in pinned[0]
    assert unpinned == []


def test_code_mode_pins_codex_runtime_without_changing_work_mode(_create, tmp_path):
    response, sessions = _create({"model": "deepseek-v4-flash", "provider": "custom:package", "code_mode": True})
    session = sessions[response["result"]["session_id"]]
    assert session["model_override"] == {
        "model": "deepseek-v4-flash", "provider": "custom:package", "code_mode": True,
    }
    response, sessions = _create({"model": "deepseek-v4-flash", "provider": "custom:package"})
    assert "api_mode" not in sessions[response["result"]["session_id"]]["model_override"]

    # Resume resolves the upstream wire and credentials in the owning profile, A→B→A.
    from types import SimpleNamespace
    from tui_gateway import server
    homes = [tmp_path / "code-a", tmp_path / "code-b"]
    for index, home in enumerate(homes):
        home.mkdir()
        (home / "config.yaml").write_text(
            "model:\n  default: fixture-model\n  provider: custom:package\n"
            f"providers:\n  package:\n    api: http://127.0.0.1:59999/v1\n    api_key: fixture-{index}\n",
            encoding="utf-8",
        )
        (home / ".env").write_text("")
    for index in (0, 1, 0):
        with server._session_profile_runtime_scope({"profile_home": str(homes[index])}):
            model, runtime = server._resolve_agent_model_runtime(
                {"model": "fixture-model", "provider": "custom:package", "code_mode": True, "api_mode": "codex_app_server"}, None,
            )
            assert runtime["api_key"] == f"fixture-{index}"
            assert runtime["api_mode"] != "codex_app_server"
            agent = SimpleNamespace(model=model, provider="custom:package", base_url=runtime["base_url"],
                                    api_mode="codex_app_server", _desktop_code_mode=True)
            config = server._runtime_model_config(agent)
            restored = server._stored_session_runtime_overrides({"model": model, "model_config": config})
            assert restored["model_override"]["code_mode"] is True
