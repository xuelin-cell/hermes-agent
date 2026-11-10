"""session.create with seeded messages: the seed is durable before the first prompt, and durable once."""

import json

from hermes_state import SessionDB
from tui_gateway import server


def _quiet_create(monkeypatch, db):
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)


def _create(params: dict) -> dict:
    resp = server.handle_request({"id": "create", "method": "session.create", "params": params})
    assert "result" in resp, resp
    return resp["result"]


def test_parentless_seed_survives_a_restart_and_hides_its_runbook(monkeypatch, tmp_path):
    """A client that opens a chat with its first turns already written (no parent) gets a durable row and
    transcript at create: a restart before the first prompt resumes it, the hidden runbook stays out of the
    transcript on the wire, and the seed is not written a second time by the first-submit path."""
    db = SessionDB(db_path=tmp_path / "state.db")
    _quiet_create(monkeypatch, db)
    sids = []
    try:
        result = _create({
            "cols": 96, "source": "desktop", "title": "Welcome to Hermes",
            "messages": [
                {"role": "user", "content": "Private setup runbook", "display_kind": "hidden"},
                {"role": "assistant", "content": "Welcome to Hermes"},
                # Only "hidden" is accepted from the wire; other kinds are stamped by the gateway itself.
                {"role": "user", "content": "Second question", "display_kind": "steer"},
            ]})
        sids.append(result["session_id"])
        key = result["stored_session_id"]
        assert [m["role"] for m in result["messages"]] == ["assistant", "user"]
        assert result["message_count"] == 2  # counts what is on the wire, as session.resume does
        live = server.handle_request({"id": "live", "method": "session.resume", "params": {"session_id": key, "cols": 96}})["result"]
        assert (live["message_count"], len(live["messages"])) == (2, 2)  # the reuse-live path counts the wire too

        assert db.get_session(key)["title"] == "Welcome to Hermes"
        rows = db.get_messages_as_conversation(key)
        assert [r["content"] for r in rows] == ["Private setup runbook", "Welcome to Hermes", "Second question"]
        assert rows[0]["display_kind"] == "hidden"
        assert rows[2].get("display_kind") is None
        listed = server.handle_request({"id": "list", "method": "session.list", "params": {}})["result"]["sessions"]
        assert next(s for s in listed if s["id"] == key)["preview"].startswith("Second question")  # the hidden row is not the preview

        server._sessions.pop(sids.pop())  # the gateway restarts; only state.db remains
        resumed = server.handle_request({"id": "resume", "method": "session.resume", "params": {"session_id": key, "cols": 96}})
        assert "result" in resumed, resumed
        sids.append(resumed["result"]["session_id"])
        assert [m["role"] for m in resumed["result"]["messages"]] == ["assistant", "user"]

        assert server._persist_session_row_for_submit("rid", server._sessions[sids[-1]]) is None  # the first prompt.submit
        assert len(db.get_messages_as_conversation(key)) == 3
        assert [hit["session_id"] for hit in db.search_messages("Second question")] == [key]
        assert db.search_messages("Private setup runbook") == []  # the hidden row is not searchable either
    finally:
        for sid in sids:
            server._sessions.pop(sid, None)
        db.close()


def test_branch_child_seed_is_written_once(monkeypatch, tmp_path):
    """A seeded branch child persists its copied transcript at create (#93959); the first prompt's seed
    persist is the fallback for a failed create-time copy, not a second copy."""
    db = SessionDB(db_path=tmp_path / "state.db")
    _quiet_create(monkeypatch, db)
    seed = [{"role": "user", "content": "hello from parent"}, {"role": "assistant", "content": "parent reply"}]
    db.create_session("parent-1", source="desktop")
    db.append_messages_batch("parent-1", seed)
    db.set_session_title("parent-1", "Parent chat")
    sid = None
    try:
        result = _create({"cols": 96, "source": "desktop", "parent_session_id": "parent-1", "messages": seed})
        sid, key = result["session_id"], result["stored_session_id"]
        assert [r["content"] for r in db.get_messages_as_conversation(key)] == ["hello from parent", "parent reply"]

        assert server._persist_session_row_for_submit("rid", server._sessions[sid]) is None  # the first prompt.submit
        assert [r["content"] for r in db.get_messages_as_conversation(key)] == ["hello from parent", "parent reply"]
    finally:
        if sid:
            server._sessions.pop(sid, None)
        db.close()


def test_partial_seed_copy_is_rolled_back_not_duplicated(monkeypatch, tmp_path):
    """A seed copy that fails after the row exists leaves no row behind: the first prompt's retry copies the
    whole seed again, so a kept partial copy would double it."""
    db = SessionDB(db_path=tmp_path / "state.db")
    _quiet_create(monkeypatch, db)
    real_append, calls = db.append_messages_batch, []

    def flaky_append(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("copy failed after the row was committed")
        return real_append(*args, **kwargs)

    monkeypatch.setattr(db, "append_messages_batch", flaky_append)
    sid = None
    try:
        result = _create({"cols": 96, "source": "desktop", "title": "Welcome",
                          "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]})
        sid, key = result["session_id"], result["stored_session_id"]
        assert db.get_session(key) is None  # rolled back, so the first prompt starts clean

        assert server._persist_session_row_for_submit("rid", server._sessions[sid]) is None
        assert [r["content"] for r in db.get_messages_as_conversation(key)] == ["hi", "hello"]
        assert server._sessions[sid]["pending_title"] == "Welcome"  # still queued: the turn applies it, as for any lazy row
    finally:
        if sid:
            server._sessions.pop(sid, None)
        db.close()


def test_branch_reply_snapshots_and_timestamps_survive_copy_and_reload(monkeypatch, tmp_path):
    path = tmp_path / "state.db"
    metadata = {
        "turn_token_usage": {"input_tokens": 40, "output_tokens": 8, "total_tokens": 48,
                             "cache_read_tokens": 0, "cache_write_tokens": 0},
        "turn_model": {"model": "answered-model", "provider": "test", "name": "Answered model"},
        "turn_completed_at": 1700000005.125,
    }
    history = [
        {"role": "user", "content": "Question", "timestamp": 1700000000.25},
        {"role": "assistant", "content": "Answer", "timestamp": 1700000005.125, "display_metadata": metadata},
        {"role": "user", "content": "Older question", "timestamp": 1700000010.5},
        {"role": "assistant", "content": "Older answer", "timestamp": 1700000012.75},
    ]
    keys = []
    with SessionDB(db_path=path) as db:
        _quiet_create(monkeypatch, db)
        db.create_session("parent", source="desktop")
        db.append_messages_batch("parent", history)
        for method in ("session.branch_stored", "session.create"):
            params = {"source": "desktop", "parent_session_id": "parent"}
            if method == "session.create":
                params["messages"] = [
                    {**row, "display_metadata": json.dumps(row["display_metadata"])}
                    if row.get("display_metadata") else dict(row) for row in history
                ]
            response = server.handle_request({"id": "branch", "method": method, "params": params})
            assert "result" in response, response
            sid, key = (response["result"][field] for field in ("session_id", "stored_session_id"))
            keys.append(key)
            try:
                # The first send must not duplicate the branch's already durable history.
                assert server._persist_session_row_for_submit("submit", server._sessions[sid]) is None
            finally:
                server._sessions.pop(sid, None)

    with SessionDB(db_path=path) as reopened:
        for key in ("parent", *keys):
            messages = reopened.get_messages_as_conversation(key)
            assert [(row["role"], row["content"], row["timestamp"]) for row in messages] == [
                (row["role"], row["content"], row["timestamp"]) for row in history
            ]
            displayed = server._history_to_messages(messages)
            assert displayed[1]["display_metadata"] == metadata
            assert "turn_completed_at" not in (displayed[-1].get("display_metadata") or {})


def test_seed_import_accepts_only_valid_reply_display_snapshots():
    messages = server._coerce_seed_history([
        {"role": "assistant", "content": "Invalid snapshot", "timestamp": 10 ** 400,
         "display_metadata": {"turn_model": {"name": "Missing model"}, "turn_completed_at": float("nan"),
                              "turn_token_usage": {"total_tokens": -1}, "gateway_input_owner": "other"}},
        {"role": "assistant", "content": "Valid display snapshot", "timestamp": 1700000000.25,
         "display_metadata": {"turn_model": {"model": "answered-model"}, "turn_completed_at": 1700000005.125,
                              "gateway_input_owner": "other"}},
    ])
    assert messages[0] == {"role": "assistant", "content": "Invalid snapshot"}
    assert messages[1] == {
        "role": "assistant", "content": "Valid display snapshot", "timestamp": 1700000000.25,
        "display_metadata": {"turn_model": {"model": "answered-model", "provider": "", "name": ""},
                             "turn_completed_at": 1700000005.125},
    }
