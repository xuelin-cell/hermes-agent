from types import SimpleNamespace

import pytest

from agent.secret_scope import set_multiplex_active
from tui_gateway import server
from tui_gateway.uniwork_model_catalog import prepare_turn_model


def test_retired_model_fallback_uses_the_owning_profile_and_keeps_the_saved_choice(tmp_path):
    homes = [tmp_path / "a", tmp_path / "b"]
    for index, home in enumerate(homes):
        home.mkdir()
        (home / "config.yaml").write_text(
            f"""
model: {{default: retired, provider: 'custom:retired'}}
providers:
  desktop-mt-maas-test:
    api: https://plan-{index}.example.invalid/v1
    api_key: fixture-key-{index}
    default_model: main
    models: {{main: {{}}, fast: {{}}}}
  personal:
    api: https://personal-{index}.example.invalid/v1
    api_key: fixture-personal-{index}
    default_model: personal
uniwork_model_catalog:
  models:
    - {{model: fast, provider: 'custom:desktop-mt-maas-test'}}
    - {{model: main, provider: 'custom:desktop-mt-maas-test'}}
  main: {{model: main, provider: 'custom:desktop-mt-maas-test'}}
  fast: {{model: fast, provider: 'custom:desktop-mt-maas-test'}}
""",
            encoding="utf-8",
        )
    set_multiplex_active(True)
    for index in (0, 1, 0):
        switches = []
        agent = SimpleNamespace(model="main", provider="custom", requested_provider="custom:desktop-mt-maas-test",
                                switch_model=lambda **kwargs: switches.append(kwargs))
        saved = {"model": "retired", "provider": "custom:retired"}
        session = {
            "source": "desktop", "profile_home": str(homes[index]), "agent": agent, "model_override": saved,
            "uniwork_model_selection": {"model": "personal", "provider": "custom:personal"},
        }
        with server._session_profile_runtime_scope(session):
            build = server._deferred_build_agent_kwargs(session, None)
            assert build["model_override"] == {"model": "main", "provider": "custom:desktop-mt-maas-test"}
            assert prepare_turn_model(session, SimpleNamespace(one_turn_restore=None))
            assert switches[-1]["new_model"] == "personal"
            assert switches[-1]["base_url"] == f"https://personal-{index}.example.invalid/v1"
            assert session["model_override"] == saved

            # A hidden fast model remains a valid saved choice and cannot be
            # chosen as the global selectable fallback.
            session["model_override"] = {"model": "fast", "provider": "custom:desktop-mt-maas-test"}
            assert prepare_turn_model(session, SimpleNamespace(one_turn_restore=None))
            assert switches[-1]["new_model"] == "fast"
            session["model_override"] = saved
            session["uniwork_model_selection"] = {"model": "fast", "provider": "custom:desktop-mt-maas-test"}
            switches.clear()
            assert prepare_turn_model(session, SimpleNamespace(one_turn_restore=None))
            assert not switches  # the agent is already on main


def test_catalog_with_no_models_rejects_the_turn(tmp_path):
    (tmp_path / "config.yaml").write_text("uniwork_model_catalog: {models: []}\n", encoding="utf-8")
    session = {"source": "desktop", "profile_home": str(tmp_path), "agent": SimpleNamespace(model="", provider="")}
    with server._session_profile_runtime_scope(session), pytest.raises(ValueError, match="No available model"):
        prepare_turn_model(session, SimpleNamespace(one_turn_restore=None))
