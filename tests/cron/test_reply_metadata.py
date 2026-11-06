"""Cron replies expose the same persisted metadata as desktop prompt turns."""

import time

import hermes_state
from agent.context_compressor import _DB_PERSISTED_MARKER
from agent.secret_scope import set_multiplex_active
from cron.scheduler import run_job
from cron.scheduler_provider import _profile_cron_scope
from gateway.run import _profile_runtime_scope
from hermes_cli.web_routers.sessions import _project_for_display
from hermes_state import SessionDB


def test_cron_reply_metadata_survives_reopening_its_own_profile(tmp_path, monkeypatch):
    class OfflineAgent:
        def __init__(self, *, session_id, session_db, model, **kwargs):
            self.session_id = session_id
            self.db = session_db
            self.model = model
            self.session_prompt_tokens = 90
            self.session_completion_tokens = 10
            self.session_total_tokens = 100
            self.session_cache_read_tokens = 25
            self.session_cache_write_tokens = 0
            self.db.create_session(session_id, source="cron")

        def run_conversation(self, prompt, *, task_id):
            if "without usage" not in prompt:
                self.session_prompt_tokens += 40
                self.session_completion_tokens += 8
                self.session_total_tokens += 48
                self.session_cache_read_tokens += 10
            messages = [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "Checking.", "tool_calls": [
                    {"id": "lookup", "type": "function", "function": {"name": "lookup", "arguments": "{}"}},
                ]},
                {"role": "tool", "content": "Found.", "tool_call_id": "lookup"},
                {"role": "assistant", "content": "Report ready.", "display_metadata": {"existing": True}},
            ]
            self.db.append_messages_batch(self.session_id, messages)
            for message in messages:
                message[_DB_PERSISTED_MARKER] = True
            return {
                "messages": messages, "final_response": "Report ready.", "completed": True,
                "model": "switched-model" if self.model == "switched-model" else "answered-model",
                "provider": "custom:endpoint",
            }

        def close(self):
            pass

    # Use the production profile-relative DB resolver instead of conftest's single DB path.
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", hermes_state._IMPORT_DEFAULT_DB_PATH)
    monkeypatch.setattr("run_agent.AIAgent", OfflineAgent)
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda **kwargs: {"provider": "custom", "api_key": "test-key",
                          "base_url": "https://example.invalid/v1", "api_mode": "chat_completions"},
    )
    homes = [tmp_path / name for name in ("a", "b")]
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text(
            f"providers:\n  endpoint:\n    name: Answer from {home.name}\n"
            "    model: answered-model\n    base_url: https://example.invalid/v1\n",
            encoding="utf-8",
        )

    set_multiplex_active(True)
    for index, home in enumerate([homes[0], homes[1], homes[0]]):
        job_id = f"reply-{index}"
        with_usage = index != 1
        switched = index == 2
        before = time.time()
        with _profile_cron_scope(home), _profile_runtime_scope(home, prepared_secret_scope={}):
            success, _, response, error = run_job({
                "id": job_id, "name": job_id, "deliver": "local",
                "model": "switched-model" if switched else "requested-model",
                "prompt": "Report with usage" if with_usage else "Report without usage",
            })
        assert success and error is None, error
        assert response == "Report ready."

        with SessionDB(db_path=home / "state.db") as reopened:
            session = next(row for row in reopened.list_sessions_rich(source="cron")
                           if row["id"].startswith(f"cron_{job_id}_"))
            messages = _project_for_display(reopened.get_messages(session["id"]), home=home)
        assert messages[0]["timestamp"] > 0
        assert "turn_model" not in (messages[1].get("display_metadata") or {})
        reply = messages[-1]
        assert reply["content"] == response
        metadata = reply["display_metadata"]
        assert metadata["existing"] is True
        assert metadata["turn_model"] == {
            "model": "switched-model" if switched else "answered-model", "provider": "custom:endpoint",
            "name": "" if switched else f"Answer from {home.name}",
        }
        assert before <= metadata["turn_completed_at"] <= session["ended_at"]
        if with_usage:
            assert metadata["turn_token_usage"] == {
                "input_tokens": 40, "output_tokens": 8, "total_tokens": 48,
                "cache_read_tokens": 10, "cache_write_tokens": 0,
            }
        else:
            assert "turn_token_usage" not in metadata
