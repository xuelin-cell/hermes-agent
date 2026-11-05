"""Turn usage stays attached to its own reply through live completion and SQLite resume."""

import threading
import time
from types import SimpleNamespace

from hermes_state import SessionDB
from tui_gateway import server
from tui_gateway.prompt_turn import _TurnRun
from tui_gateway.turn_token_usage import token_usage_snapshot, turn_token_delta


def test_turn_usage_survives_completion_and_reload_without_reusing_previous_turn(tmp_path):
    agent = SimpleNamespace(
        session_id="chat", model="test", provider="test", _session_title_hint="Scratch",
        context_compressor=SimpleNamespace(compression_count=0), session_prompt_tokens=900,
        session_completion_tokens=100, session_total_tokens=1000,
        session_cache_read_tokens=400, session_cache_write_tokens=0,
    )
    db_path = tmp_path / "state.db"
    session = {"session_key": agent.session_id, "agent": agent, "history_lock": threading.RLock()}
    with SessionDB(db_path=db_path) as db:
        agent._session_db = db
        db.create_session(agent.session_id, source="desktop")
        history = []
        expected = []
        expected_models = []
        expected_times = []
        for input_tokens, output_tokens, interrupted in [(300, 40, False), (120, 25, False), (0, 0, False), (10, 2, True)]:
            def run_conversation(_prompt, **kwargs):
                # Two API responses (e.g. a tool call followed by the final reply).
                if input_tokens:
                    for prompt, output in [(input_tokens - 10, output_tokens - 2), (10, 2)]:
                        agent.session_prompt_tokens += prompt
                        agent.session_completion_tokens += output
                        agent.session_total_tokens += prompt + output
                    agent.session_cache_read_tokens += 20
                current = [{"role": "user", "content": "again"},
                           {"role": "assistant", "content": "same", "display_metadata": {"existing": True}}]
                db.append_messages_batch(agent.session_id, current)
                for message in current:
                    message["_db_persisted"] = True
                agent._persist_user_message_idx = len(history)
                return {"messages": kwargs["conversation_history"] + current, "final_response": "same",
                        "model": f"answered-{input_tokens}", "provider": "test-provider", "interrupted": interrupted}

            agent.run_conversation = run_conversation
            st = _TurnRun(agent, None, None, True, history=list(history))
            before = time.time()
            server._invoke_agent("runtime", session, st, "again", "again", None, [], None, None)
            if interrupted:
                assert st.turn_completed_at is None
            else:
                assert before <= st.turn_completed_at <= time.time()
            expected_times.append(st.turn_completed_at)
            usage = st.turn_token_usage
            if input_tokens:
                assert usage["input_tokens"] == input_tokens
                assert usage["output_tokens"] == output_tokens
                assert usage["total_tokens"] == input_tokens + output_tokens
                assert usage["cache_read_tokens"] == 20  # already included in input, never added twice
            else:
                assert usage is None  # missing usage must not hide or reuse the model snapshot
            expected.append(usage)
            expected_models.append(st.turn_model)
            assert st.turn_model["model"] == f"answered-{input_tokens}"
            agent.model = "restored-default"

            payload, _, _ = server._complete_turn_payload(session, st, None, 80)
            assert payload.get("turn_token_usage") == usage
            assert payload["turn_model"] == st.turn_model
            assert payload.get("turn_completed_at") == st.turn_completed_at
            assert server._event_frame("message.complete", "runtime", payload)["params"]["payload"] == payload
            history = st.result["messages"]

        # No provider usage, or a reset of the session counters, must not invent consumption.
        assert turn_token_delta(token_usage_snapshot(agent), agent) is None
        before = token_usage_snapshot(agent)
        agent.session_total_tokens = 0
        assert turn_token_delta(before, agent) is None
        assert turn_token_delta(None, agent) is None

        # An exact row address cannot stamp another session's answer.
        db.create_session("other", source="desktop")
        assert not db.merge_message_display_metadata("other", history[-1]["_row_id"], {"turn_model": expected_models[-1]})

    with SessionDB(db_path=db_path) as reopened:
        restored = reopened.get_messages_as_conversation(agent.session_id)
        projected = server._history_to_messages(restored)
        replies = [row for row in projected if row["role"] == "assistant"]
        assert [row["display_metadata"].get("turn_token_usage") for row in replies] == expected
        assert all(row["display_metadata"]["existing"] for row in replies)
        assert [row["display_metadata"]["turn_model"] for row in replies] == expected_models
        assert [row["display_metadata"].get("turn_completed_at") for row in replies] == expected_times


def test_reply_model_names_follow_the_owning_profile_and_never_borrow_another_route(tmp_path):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from tui_gateway.turn_reply_metadata import snapshot_turn_model

    homes = [tmp_path / name for name in ("a", "b")]
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text(
            f"providers:\n  endpoint:\n    name: Model {home.name}\n    model: chosen-model\n"
            "    base_url: https://model.invalid/v1\n"
            "  other:\n    name: Wrong endpoint\n    model: chosen-model\n"
            "    base_url: https://other.invalid/v1\n"
            "  desktop-mt-maas-plan:\n    name: Internal plan endpoint\n"
            "    default_model: chosen-model\n    base_url: https://plan.invalid/v1\n",
            encoding="utf-8")
    result = {"model": "chosen-model", "provider": "custom", "base_url": "https://model.invalid/v1/"}
    previous = is_multiplex_active()
    set_multiplex_active(True)
    try:
        snapshots = []
        for home in [homes[0], homes[1], homes[0]]:
            with server._session_profile_runtime_scope({"profile_home": str(home)}, hydrate_secrets=False):
                snapshots.append(snapshot_turn_model(result, SimpleNamespace()))
                switched = snapshot_turn_model({**result, "model": "fallback-model"}, SimpleNamespace())
                assert switched["model"] == "fallback-model" and not switched["name"]
                plan = snapshot_turn_model({"model": "chosen-model", "provider": "custom:desktop-mt-maas-plan"}, SimpleNamespace())
                assert not plan["name"]
        assert [item["name"] for item in snapshots] == ["Model a", "Model b", "Model a"]
        with server._session_profile_runtime_scope({"profile_home": str(homes[1])}, hydrate_secrets=False):
            snapshot_turn_model(result, SimpleNamespace())
        assert snapshots[0]["name"] == "Model a"
    finally:
        set_multiplex_active(previous)
