"""Turn usage stays attached to its own reply through live completion and SQLite resume."""

import threading
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
        for input_tokens, output_tokens in [(300, 40), (120, 25)]:
            def run_conversation(_prompt, **kwargs):
                # Two API responses (e.g. a tool call followed by the final reply).
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
                return {"messages": kwargs["conversation_history"] + current, "final_response": "same"}

            agent.run_conversation = run_conversation
            st = _TurnRun(agent, None, None, True, history=list(history))
            server._invoke_agent("runtime", session, st, "again", "again", None, [], None, None)
            usage = st.turn_token_usage
            assert usage["input_tokens"] == input_tokens
            assert usage["output_tokens"] == output_tokens
            assert usage["total_tokens"] == input_tokens + output_tokens
            assert usage["cache_read_tokens"] == 20  # already included in input, never added twice
            expected.append(usage)

            payload, _, _ = server._complete_turn_payload(session, st, None, 80)
            assert payload["turn_token_usage"] == usage
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
        assert not db.set_message_turn_token_usage("other", history[-1]["_row_id"], expected[-1])

    with SessionDB(db_path=db_path) as reopened:
        restored = reopened.get_messages_as_conversation(agent.session_id)
        projected = server._history_to_messages(restored)
        replies = [row for row in projected if row["role"] == "assistant"]
        assert [row["display_metadata"]["turn_token_usage"] for row in replies] == expected
        assert all(row["display_metadata"]["existing"] for row in replies)
