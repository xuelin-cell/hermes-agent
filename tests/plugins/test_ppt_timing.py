"""PPT-only timings through real plugin registration, including A→B→A profile scope."""
import json
import logging
from pathlib import Path

from tests.plugins.test_uniwork_kits_plugin import profile_env  # noqa: F401


def load(home):
    from hermes_cli.plugins import PluginManager
    from hermes_cli.plugins_manifest import PluginManifest

    manager = PluginManager(scope_key=str(home))
    manager._load_plugin(PluginManifest(name="uniwork-kits", source="bundled", path=str(
        Path(__file__).parents[2] / "plugins/uniwork-kits")))
    assert manager._plugins["uniwork-kits"].error is None
    return manager


def records(caplog):
    return [json.loads(r.message.split("[ppt-timing] ", 1)[1])
            for r in caplog.records if "[ppt-timing] " in r.message]


def test_hooks_measure_attempts_without_logging_content_or_background_review(profile_env, caplog):
    manager = load(profile_env)
    caplog.set_level(logging.INFO)
    identity = {"session_id": "ppt-s", "turn_id": "user-turn"}
    manager.invoke_hook("pre_llm_call", **identity, user_message="做10页PPT", platform="desktop")
    manager.invoke_hook("pre_api_request", **identity, api_request_id="r", retry_count=0,
                        request={"authorization": "never-log-this"})
    manager.invoke_hook("api_request_error", **identity, api_request_id="r", api_duration=0.5,
                        error={"type": "ConnectionError", "message": "never-log-this"})
    manager.invoke_hook("pre_api_request", **identity, api_request_id="r", retry_count=1)
    manager.invoke_hook("post_api_request", **identity, api_request_id="r", api_duration=3,
                        started_at=100, ended_at=103, first_chunk_at=101,
                        usage={"output_tokens": 20, "reasoning_tokens": 5}, model="test-model")
    manager.invoke_hook("post_tool_call", **identity, tool_name="terminal", duration_ms=25,
                        args={"command": "node build.js never-log-this"}, status="ok")
    manager.invoke_hook("post_llm_call", **identity, assistant_response="never-log-this")
    # Same session's background work has no foreground pre_llm start, and no record.
    manager.invoke_hook("pre_api_request", session_id="ppt-s", turn_id="review", api_request_id="bg")
    manager.invoke_hook("post_api_request", session_id="ppt-s", turn_id="review", api_request_id="bg", api_duration=99)
    data = records(caplog)
    api = next(r for r in data if r["event"] == "api")
    assert (api["first_chunk_wait_ms"], api["after_first_chunk_ms"]) == (1000, 2000)
    assert api["retry_count"] == 1
    end = next(r for r in data if r["event"] == "end")
    assert (end["api_ms"], end["api_errors"], end["tool_ms"]) == (3500, 1, 25)
    assert {r["turn_id"] for r in data} == {"user-turn"}
    assert "never-log-this" not in json.dumps(data)


def test_profile_alternation_and_non_ppt_requests_do_not_leak_timings(profile_env, tmp_path, caplog):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    other = tmp_path / "other"
    other.mkdir()
    (other / "config.yaml").write_text("model:\n  provider: zai\n  default: glm-test\n", encoding="utf-8")
    manager = load(profile_env)
    caplog.set_level(logging.INFO)
    identity = {"session_id": "same-session", "turn_id": "same-turn"}

    def at(home, event, **kw):
        token = set_hermes_home_override(home)
        try:
            manager.invoke_hook(event, **identity, **kw)
        finally:
            reset_hermes_home_override(token)

    at(profile_env, "pre_llm_call", user_message="做PPT", platform="desktop")
    at(profile_env, "pre_api_request", api_request_id="a")
    at(other, "pre_llm_call", user_message="做PPT", platform="desktop")
    at(other, "pre_api_request", api_request_id="b")
    at(other, "post_api_request", api_request_id="b", api_duration=9)
    at(profile_env, "post_api_request", api_request_id="a", api_duration=1)
    at(profile_env, "post_llm_call")
    at(other, "post_llm_call")
    ends = [r for r in records(caplog) if r["event"] == "end"]
    assert [r["api_ms"] for r in ends] == [1000, 9000]
    assert next(r for r in records(caplog) if r["event"] == "api")["first_chunk_wait_ms"] is None
    caplog.clear()
    manager.invoke_hook("pre_llm_call", session_id="ordinary", turn_id="plain", user_message="写一首诗")
    manager.invoke_hook("post_api_request", session_id="ordinary", turn_id="plain", api_request_id="none", api_duration=10)
    assert records(caplog) == []
