"""Messaging turns store metadata on the exact reply displayed by the desktop."""

import time
from contextlib import ExitStack
from types import SimpleNamespace

from agent.context_compressor import _DB_PERSISTED_MARKER
from agent.secret_scope import set_multiplex_active
from gateway.config import Platform
from gateway.run import _profile_runtime_scope
from gateway.run_turn_runner import TurnRunner
from gateway.session import SessionSource
from gateway.turn_context import TurnContext
from hermes_cli.web_routers.sessions import _project_for_display
from hermes_state import SessionDB


def test_messaging_reply_metadata_uses_turn_deltas_and_owning_profile(tmp_path):
    class OfflineAgent:
        def __init__(self, db):
            self._session_db = db
            self.session_id = "messaging-session"
            self.model = "requested-model"
            self.session_prompt_tokens = 90
            self.session_completion_tokens = 10
            self.session_total_tokens = 100
            self.session_cache_read_tokens = 25
            self.session_cache_write_tokens = 0
            db.create_session(self.session_id, source="weixin")

        def run_conversation(self, message, *, conversation_history, task_id):
            if message == "reuse history":
                return {"messages": conversation_history, "final_response": "Answer.", "completed": True}
            if message != "no usage":
                self.session_prompt_tokens += 40
                self.session_completion_tokens += 8
                self.session_total_tokens += 48
                self.session_cache_read_tokens += 10
            current = [
                {"role": "user", "content": message},
                {"role": "assistant", "content": "Checking.", "tool_calls": [
                    {"id": "lookup", "type": "function", "function": {"name": "lookup", "arguments": "{}"}},
                ]},
                {"role": "tool", "content": "Found.", "tool_call_id": "lookup"},
                {"role": "assistant", "content": "Answer.", "display_metadata": {"existing": True}},
            ]
            self._persist_user_message_idx = len(conversation_history)
            self._session_db.append_messages_batch(self.session_id, current)
            for row in current:
                row[_DB_PERSISTED_MARKER] = True
            return {
                "messages": conversation_history + current, "final_response": "Answer.",
                "model": "answered-model", "provider": "custom:endpoint",
                "completed": message != "interrupted", "interrupted": message == "interrupted",
            }

    def run(home, agent, message):
        with _profile_runtime_scope(home, prepared_secret_scope={}):
            history = agent._session_db.get_messages_as_conversation(agent.session_id, include_row_ids=True)
            ctx = TurnContext(
                source=SessionSource(platform=Platform.WEIXIN, chat_id="chat", user_id="user"),
                message=message, session_id=agent.session_id, session_key=f"weixin:{home.name}",
            )
            gateway = SimpleNamespace(_consume_pending_native_image_paths=lambda _key: [])
            return TurnRunner(gateway, ctx)._run_conversation_with_approval(agent, history, None, None, None)

    homes = [tmp_path / name for name in ("a", "b")]
    set_multiplex_active(True)
    with ExitStack() as stack:
        agents = []
        for home in homes:
            home.mkdir()
            (home / "config.yaml").write_text(
                f"providers:\n  endpoint:\n    name: Answer from {home.name}\n"
                "    model: answered-model\n    base_url: https://example.invalid/v1\n",
                encoding="utf-8",
            )
            with _profile_runtime_scope(home, prepared_secret_scope={}):
                agents.append(OfflineAgent(stack.enter_context(SessionDB(db_path=home / "state.db"))))
        expected = [[], []]
        for index, prompt in ((0, "first"), (1, "no usage"), (0, "second")):
            home, agent = homes[index], agents[index]
            before = time.time()
            result = run(home, agent, prompt)
            reply = result["messages"][-1]
            metadata = reply["display_metadata"]
            assert metadata["existing"] is True
            assert metadata["turn_model"] == {
                "model": "answered-model", "provider": "custom:endpoint", "name": f"Answer from {home.name}",
            }
            assert before <= metadata["turn_completed_at"] <= time.time()
            if prompt == "no usage":
                assert "turn_token_usage" not in metadata
            else:
                assert metadata["turn_token_usage"] == {
                    "input_tokens": 40, "output_tokens": 8, "total_tokens": 48,
                    "cache_read_tokens": 10, "cache_write_tokens": 0,
                }
            expected[index].append(metadata.copy())
        run(homes[0], agents[0], "reuse history")
        run(homes[1], agents[1], "interrupted")
        expected[1].append({"existing": True})

    for home, agent, metadata in zip(homes, agents, expected):
        with _profile_runtime_scope(home, prepared_secret_scope={}), SessionDB(db_path=home / "state.db") as db:
            messages = _project_for_display(db.get_messages(agent.session_id), home=home)
        replies = [row for row in messages if row["role"] == "assistant" and not row.get("tool_calls")]
        assert [row["display_metadata"] for row in replies] == metadata
        assert all(not row.get("display_metadata") for row in messages if row.get("tool_calls"))
