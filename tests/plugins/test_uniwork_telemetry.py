"""UniWork v3 wire contracts and real native-plugin discovery/dispatch in isolated homes."""

from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
import time
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest
import hermes_yaml as yaml

SOURCE = Path(__file__).resolve().parents[2] / "apps/desktop/assets/usage-telemetry-plugin"


@pytest.fixture
def modules():
    name = "telemetry_contract_fixture"
    spec = importlib.util.spec_from_file_location(name, SOURCE / "__init__.py", submodule_search_locations=[str(SOURCE)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    yield SimpleNamespace(**{part: importlib.import_module(name + "." + part)
                             for part in ("protocol", "outbox", "collector", "catalog", "runtime", "journal")})
    for key in list(sys.modules):
        if key == name or key.startswith(name + "."):
            sys.modules.pop(key)


def test_wire_shapes_unicode_and_token_semantics(modules):
    p = modules.protocol
    now = p.timestamp()
    plugin, subject = p.resource("office", "办公"), {**p.resource("plugin:office/write"), "type": "skill"}
    events = p.capabilities("call-1", "turn", now, subject, plugin)
    assert set(events[0]) == {"eventId", "eventName", "occurredAt", "plugin", "usageId"}
    assert set(events[1]) == set(events[0]) | {"subject"}
    assert events[0]["usageId"] == events[1]["usageId"]
    assert events[0]["eventId"] != events[1]["eventId"]
    assert p.capabilities("call-2", "turn", now, subject, plugin)[0]["eventId"] == events[0]["eventId"]
    tag = p.capabilities("tag", "turn", now, {"type": "skill_tag", "id": "server-tag"})[0]
    assert "usageId" not in tag and "plugin" not in tag
    text = " \t\n\r\x00\ud800" + "😀" * 2200
    event = p.completed("round", "session", "turn", now, 2**63 - 1, {"modelId": "actual-model"}, text, [])[0]
    assert len(event["conversation"]["userInput"]) == 2000
    assert event["conversation"]["userInput"].startswith(" \t\n\r😀")
    assert "usages" not in event
    assert event["occurredAt"] == now
    assert str(2**63 - 1) in p.encode(event)
    assert p.raw_tokens({"input_tokens": 10, "output_tokens": 3, "cache_read_input_tokens": 7,
                         "cache_creation_input_tokens": 5}, "anthropic_messages") == {
        "inputTokens": 22, "outputTokens": 3, "cachedTokens": 7}
    assert p.raw_tokens({"prompt_tokens": 22, "completion_tokens": 3,
                         "prompt_tokens_details": {"cached_tokens": 7}}) == {
        "inputTokens": 22, "outputTokens": 3, "cachedTokens": 7}
    assert p.normalized_tokens({"input_tokens": 10, "prompt_tokens": 22, "output_tokens": 3,
                                "cache_read_tokens": 7})["inputTokens"] == 22
    for invalid in (True, -1, 1.5, "1", None, 2**63):
        assert not p.completed("bad", "s", "t", now, invalid, {}, "", [])
        assert "inputTokens" not in p.raw_tokens({"prompt_tokens": invalid})


def test_bridge_diagnostics_keep_http_cause_without_credentials(modules):
    error = HTTPError('http://127.0.0.1/input?token=secret', 502, 'private path', {}, None)
    assert modules.runtime.bridge_error('/context', error) == {
        'route': '/context', 'type': 'HTTPError', 'status': 502}
    assert modules.runtime.bridge_error('/input', TimeoutError('private details')) == {
        'route': '/input', 'type': 'TimeoutError'}


def test_outbox_freezes_partial_receipts_and_retries_original_payload(modules, tmp_path):
    p = modules.protocol
    path = tmp_path / "outbox.db"
    db = sqlite3.connect(path)
    box = modules.outbox.Outbox(db, "account-a", {"platform": "windows"})
    event = p.completed("round", "s", "t", p.timestamp(), 42, {}, "原始输入", [])[0]
    second = p.capabilities("tool", "t", p.timestamp(), {"type": "mcp", "id": "connector:amap"})[0]
    box.write("receipt", [event, second])
    box.write("receipt", [{**event, "occurredAt": "CHANGED"}])
    sent = []
    replies = [
        {"status": 503},
        {"status": 200, "body": {"code": 0}},
        {"status": 200, "body": {"code": 200, "data": {"results": [
            {"index": 0, "status": "accepted"}, {"index": 0, "status": "duplicate"}]}}},
        {"status": 200, "body": {"code": 200, "data": {"results": [
            {"index": 1, "status": "rejected", "retryable": False, "errorCode": "EVENT_ID_CONFLICT"},
            {"index": 0, "status": "duplicate"}]}}},
    ]
    def transport(body, account):
        sent.append((body, account))
        return replies.pop(0)
    sender = modules.outbox.Sender(box, transport)
    context = {"account": "account-a", "enabled": True, "revision": "token-a"}
    sender.send_once({**context, "account": "account-b"})
    assert not sent
    for _ in range(3):
        sender.retry_at = 0
        sender.send_once(context)
        assert box.status() == {"pending": 2}
    sender.retry_at = 0
    sender.send_once(context)
    assert box.status() == {"sent": 1, "rejected": 1}
    assert all(item == sent[0] for item in sent)
    assert json.loads(sent[0][0])["events"][0] == event
    db.close()
    reopened = modules.outbox.Outbox(sqlite3.connect(path), "account-a", {})
    assert reopened.status() == {"sent": 1, "rejected": 1}
    reopened.db.close()


def test_outbox_byte_limit_413_429_and_auth_pause(modules, tmp_path):
    p = modules.protocol
    box = modules.outbox.Outbox(sqlite3.connect(tmp_path / "batch.db"), "a", {"platform": "windows"})
    for n in range(45):
        box.write(str(n), p.completed(str(n), "s", str(n), p.timestamp(), 1, {}, "😀" * 2000, []))
    ids, body = box.batch()
    assert 0 < len(ids) < 45 and len(body) <= p.MAX_BODY_BYTES
    reply = {"status": 413}
    calls = []
    sender = modules.outbox.Sender(box, lambda payload, account: calls.append(payload) or reply)
    context = {"account": "a", "enabled": True, "revision": "first"}
    sender.send_once(context)
    assert sender.limit < len(ids)
    sender.retry_at = 0
    reply = {"status": 429, "retryAfter": "120"}
    sender.send_once(context)
    assert sender.retry_at >= time.monotonic() + 119
    sender.retry_at = 0
    reply = {"status": 401}
    sender.send_once(context)
    count = len(calls)
    sender.send_once(context)
    assert len(calls) == count
    sender.send_once({**context, "revision": "refreshed"})
    assert len(calls) == count + 1
    box.db.close()


def test_turns_children_overlap_waits_failure_and_unknown_usage(modules, tmp_path):
    recorded = []
    model = {"modelId": "main", "modelName": "Main", "productId": "plan", "provider": "yuanjing",
             "runtimeProvider": "custom", "baseUrl": "https://model.invalid/v1", "credential": "fingerprint"}
    catalog = SimpleNamespace(models=lambda values: values, expert=lambda: None,
                              skill=lambda *args: (None, None), mcp=lambda name: ({"type": "mcp", "id": "shared:slack"}, None))
    collector = modules.collector.Collector(catalog, lambda key, events: recorded.extend(events))
    base = {"session_id": "s", "turn_id": "t", "task_id": "task", "model": "main", "platform": "desktop",
            "provider": "custom", "base_url": model["baseUrl"], "credential": "fingerprint", "time": "2026-11-06T01:00:00.000Z",
            "submission_id": "visible-send", "request_kind": "user"}
    collector.observe("start", {**base, "mono": 10, "input": "hello", "models": [model]})
    collector.observe("child", {"parent_session_id": "s", "parent_turn_id": "t", "child_session_id": "child"})
    collector.observe("usage", {**base, "attempt": "one", "tokens": {"inputTokens": 9, "outputTokens": 3, "cachedTokens": 2}})
    child = {**base, "session_id": "child", "turn_id": "child-turn"}
    collector.observe("usage", {**child, "attempt": "child-one", "tokens": {"inputTokens": 5, "outputTokens": 2, "cachedTokens": 0}})
    collector.observe("child_end", {"child_session_id": "child"})
    for key, begin, end in (("first", 12, 17), ("second", 15, 19)):
        collector.observe("wait_start", {**base, "tool_call_id": key, "surface": "desktop", "mono": begin})
        collector.observe("wait_end", {**base, "tool_call_id": key, "surface": "desktop", "mono": end})
    collector.observe("answer", {**base, "has_answer": True})
    collector.observe("end", {**base, "mono": 25, "completed": True, "failed": False,
                              "interrupted": False, "turn_exit_reason": "text_response(4 chars)"})
    event = recorded[0]
    assert event["conversation"]["durationMs"] == 8000  # 15s elapsed - 7s union of waits.
    assert event["usages"][0]["inputTokens"] == 14
    assert event["usages"][0]["cachedTokens"] == 2
    collector.observe("usage", {**child, "attempt": "late", "tokens": {"inputTokens": 100}})
    collector.observe("end", {**base, "mono": 99, "completed": True, "failed": False,
                              "interrupted": False, "turn_exit_reason": "completed"})
    assert recorded == [event] and event["usages"][0]["inputTokens"] == 14
    # Success of a capability survives a subsequently failed turn.
    failed = {**base, "turn_id": "failure"}
    collector.observe("start", {**failed, "mono": 30, "models": [model]})
    collector.observe("tool", {**failed, "mono": 31, "success": True, "tool_call_id": "mcp", "tool_name": "mcp__slack__send"})
    collector.observe("end", {**failed, "mono": 32, "completed": False, "failed": True, "interrupted": False})
    assert [e["eventName"] for e in recorded] == ["conversation.turn.completed", "capability.invoke"]


def test_catalog_resource_ownership_and_tool_failures(modules, tmp_path):
    home = tmp_path
    (home / "imported-plugins").mkdir()
    (home / "imported-plugins/index.json").write_text(json.dumps({"plugins": {"office": {
        "kind": "expert", "self": True, "display_name": "办公", "skill_names": ["office--write"],
        "mcp_keys": ["plugin_office_docs"]}}}), encoding="utf-8")
    (home / "config.yaml").write_text(yaml.safe_dump({"mcp_servers": {
        "connector_amap": {"desktop_connector": "amap"},
        "UniAI-Toolkit": {"uniwork_builtin_id": "legacy-toolkit-id"},
        "plugin_office_docs": {"url": "https://docs.invalid/mcp"},
        "shared": {"url": "https://mcp.slack.com/mcp"},
        "unknown": {"url": "https://unknown.invalid/mcp"}}}), encoding="utf-8")
    catalog = modules.catalog.Catalog(home)
    subject, plugin = catalog.skill("office--write", home / "skills/kits/office/skills/write", "local")
    assert subject["id"] == "plugin:office/write" and plugin["id"] == "office"
    subject, plugin = catalog.mcp("mcp__connector_amap__route")
    assert subject["id"] == "connector:amap" and plugin is None
    subject, plugin = catalog.mcp("mcp__UniAI_Toolkit__txt2img_generate")
    assert subject == {"type": "mcp", "id": "builtin:legacy-toolkit-id", "name": "UniAI-Toolkit", "tool": "txt2img_generate"}
    assert plugin is None
    subject, plugin = catalog.mcp("mcp__plugin_office_docs__write")
    assert subject["id"] == "plugin:office/docs" and plugin["id"] == "office"
    assert catalog.mcp("mcp__shared__send")[0]["id"] == "shared:slack"
    assert catalog.mcp("mcp__unknown__send") == (None, None)
    result = {"status": "ok", "tool_name": "mcp__connector_amap__route", "args": {"secret": "never retained"},
              "result": json.dumps({"content": [{"type": "text", "text": '{"success": false}'}]})}
    assert modules.runtime.tool_snapshot(result) == {"tool_name": result["tool_name"], "success": False}


def test_resume_without_history_never_becomes_a_new_complete_round(modules):
    recorded = []
    catalog = SimpleNamespace(models=lambda values: values, expert=lambda: None)
    collector = modules.collector.Collector(catalog, lambda key, events: recorded.extend(events))
    base = {"session_id": "s", "turn_id": "resumed-native", "task_id": "s", "model": "model",
            "platform": "desktop", "submission_id": "resume-send", "request_kind": "resume",
            "resume_from": "a" * 64, "input": "[System note: continue]", "time": modules.protocol.timestamp()}
    collector.observe("start", {**base, "mono": 100, "models": []})
    collector.observe("answer", {**base, "has_answer": True})
    collector.observe("end", {**base, "mono": 115, "completed": True, "failed": False, "interrupted": False})
    assert recorded == []
    assert collector.gaps["resume_state_unavailable"] == 1


def resume_collector(modules, home, account="a"):
    home.mkdir(exist_ok=True)
    (home / "imported-plugins").mkdir(exist_ok=True)
    (home / "imported-plugins/index.json").write_text(json.dumps({"plugins": {
        "office": {"kind": "expert", "self": True, "display_name": "办公", "mcp_keys": ["plugin_office_docs"]}
    }}), encoding="utf-8")
    (home / "config.yaml").write_text(yaml.safe_dump({
        "providers": {"managed": {"api": "https://model.invalid/v1", "key_env": "DESKTOP_MT_MAAS_API_KEY"}},
        "mcp_servers": {"plugin_office_docs": {"url": "https://docs.invalid/mcp"}}
    }), encoding="utf-8")
    box = modules.outbox.Outbox(sqlite3.connect(home / "events.db"), account, {})
    journal = modules.journal.TurnJournal(box.db, account)
    collector = modules.collector.Collector(modules.catalog.Catalog(home), box.write, box.session_for, journal)
    model = {"modelId": "main", "modelName": "Main", "productId": "plan", "provider": "yuanjing",
             "runtimeProvider": "custom:managed", "baseUrl": "https://model.invalid/v1", "credential": "fingerprint"}
    base = {"session_id": "s", "task_id": "stored", "turn_id": "native-first", "model": "main",
            "provider": "custom", "base_url": model["baseUrl"], "credential": model["credential"],
            "platform": "desktop", "submission_id": "send-first", "request_kind": "user", "models": [model],
            "execution_id": "a" * 64, "input": "原请求", "time": modules.protocol.timestamp(), "mono": 10}
    return collector, box, base


def test_persisted_resume_merges_closed_segments_and_keeps_one_business_identity(modules, tmp_path):
    collector, box, base = resume_collector(modules, tmp_path / "profile")
    collector.observe("start", base)
    original = next(iter(collector.turns.values())).logical_id
    collector.observe("usage", {**base, "attempt": "first", "tokens": {"inputTokens": 10, "outputTokens": 3, "cachedTokens": 2}})
    collector.observe("tool", {**base, "tool_name": "mcp__plugin_office_docs__read", "tool_call_id": "reused-call-id", "success": True})
    collector.observe("wait_start", {**base, "surface": "desktop", "tool_call_id": "approval", "mono": 12})
    collector.observe("wait_end", {**base, "surface": "desktop", "tool_call_id": "approval", "mono": 17})
    collector.observe("end", {**base, "mono": 35, "completed": False, "failed": False, "interrupted": True})
    assert box.db.execute("SELECT state FROM turn_journal").fetchone()[0] == "interrupted"
    box.db.close()

    collector, box, _ = resume_collector(modules, tmp_path / "profile")
    resumed = {**base, "turn_id": "native-resumed", "submission_id": "send-resumed", "request_kind": "resume",
               "resume_from": "a" * 64, "execution_id": "b" * 64, "input": "SYSTEM CONTINUE NOTE",
               "mono": 5000, "time": "2026-11-09T10:00:00.000Z"}
    collector.observe("start", resumed)
    collector.observe("usage", {**resumed, "attempt": "second", "tokens": {"inputTokens": 7, "outputTokens": 2, "cachedTokens": 1}})
    collector.observe("tool", {**resumed, "tool_name": "mcp__plugin_office_docs__read", "tool_call_id": "reused-call-id", "success": True})
    collector.observe("answer", {**resumed, "has_answer": True})
    terminal = {**resumed, "mono": 5015, "completed": True, "failed": False, "interrupted": False}
    collector.observe("end", terminal)
    collector.observe("end", terminal)
    events = [json.loads(row[0]) for row in box.db.execute("SELECT payload FROM events")]
    completed = [e for e in events if e["eventName"] == "conversation.turn.completed"]
    assert len(completed) == 1
    assert completed[0]["conversation"] == {"sessionId": "s", "turnId": original, "durationMs": 35000,
                                             "modelId": "main", "modelName": "Main", "userInput": "原请求"}
    assert completed[0]["occurredAt"] == base["time"]
    assert completed[0]["usages"][0]["inputTokens"] == 17
    assert completed[0]["usages"][0]["outputTokens"] == 5
    assert completed[0]["usages"][0]["cachedTokens"] == 3
    plugin_events = [e for e in events if "plugin" in e]
    assert len(plugin_events) == 3  # One use plus two real calls, despite reused model call IDs.
    assert len({e["usageId"] for e in plugin_events}) == 1
    assert "SYSTEM CONTINUE NOTE" not in str(box.db.execute("SELECT snapshot FROM turn_journal").fetchall())

    collector.observe("start", {**resumed, "turn_id": "duplicate-resume", "resume_from": "b" * 64})
    assert collector.gaps["resume_state_unavailable"] == 1
    # Re-execution is a new user request, even with identical visible text.
    fresh = {**base, "turn_id": "fresh", "execution_id": "c" * 64}
    collector.observe("start", fresh)
    assert collector.turns[("s", "fresh")].logical_id != original
    collector.observe("usage", {**fresh, "attempt": "missing-receipt", "tokens": {}})
    collector.observe("usage", {**fresh, "attempt": "known-receipt", "tokens": {"inputTokens": 7, "outputTokens": 2, "cachedTokens": 1}})
    collector.observe("answer", {**fresh, "has_answer": True})
    collector.observe("end", {**fresh, "mono": 11, "completed": True, "failed": False, "interrupted": False})
    latest = json.loads(box.db.execute("SELECT payload FROM events ORDER BY rowid DESC LIMIT 1").fetchone()[0])
    assert latest["conversation"]["durationMs"] == 1000
    assert not any(key in latest["usages"][0] for key in modules.protocol.TOKEN_FIELDS)
    box.db.close()


def test_failed_provider_attempt_preserves_the_exception_and_records_unknown_usage(modules):
    observed, calls = [], []
    runtime = SimpleNamespace(enabled=True, account="a", put=lambda *args, **kwargs: observed.append((args, kwargs)))
    failure = RuntimeError("fixture interrupted provider")
    def provider(request):
        calls.append(request)
        raise failure
    with pytest.raises(RuntimeError) as raised:
        modules.runtime.Runtime.llm(runtime, {"messages": []}, provider)
    assert raised.value is failure and len(calls) == 1
    assert len(observed) == 1 and observed[0][0][0] == "usage"
    assert observed[0][1]["tokens"] == {}


def test_incomplete_recovery_is_never_promoted_and_checkpoint_events_are_atomic(modules, tmp_path):
    home = tmp_path / "a"
    collector, box, base = resume_collector(modules, home)
    collector.observe("start", base)
    box.db.close()  # No terminal observation: the old monotonic timer cannot be recovered.
    collector, box, _ = resume_collector(modules, home)
    resumed = {**base, "turn_id": "after-crash", "request_kind": "resume", "resume_from": "a" * 64,
               "execution_id": "b" * 64, "input": "SYSTEM NOTE", "mono": 100}
    collector.observe("start", resumed)
    collector.observe("end", {**resumed, "mono": 105, "completed": False, "failed": False, "interrupted": True})
    assert collector.gaps["resume_incomplete"] == 1
    box.db.close()
    collector, box, _ = resume_collector(modules, home)
    final = {**resumed, "turn_id": "last-segment", "resume_from": "b" * 64, "execution_id": "c" * 64}
    collector.observe("start", final)
    collector.observe("answer", {**final, "has_answer": True})
    collector.observe("end", {**final, "mono": 115, "completed": True, "failed": False, "interrupted": False})
    assert collector.gaps["resume_incomplete"] == 1
    assert all(json.loads(row[0])["eventName"] != "conversation.turn.completed"
               for row in box.db.execute("SELECT payload FROM events"))
    box.db.close()

    # Same IDs in a different profile or account must not inherit this checkpoint.
    for profile, account in ((tmp_path / "b", "a"), (home, "other-account")):
        other, other_box, _ = resume_collector(modules, profile, account)
        other.observe("start", resumed)
        assert other.gaps["resume_state_unavailable"] == 1
        other_box.db.close()

    collector, box, base = resume_collector(modules, home)
    fresh = {**base, "turn_id": "new-user-turn", "execution_id": "d" * 64}
    collector.observe("start", fresh)
    collector.observe("answer", {**fresh, "has_answer": True})
    box.db.executescript("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON turn_journal "
                        "WHEN NEW.state='finished' BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure'); END;")
    with pytest.raises(sqlite3.IntegrityError):
        collector.observe("end", {**fresh, "mono": 15, "completed": True, "failed": False, "interrupted": False})
    assert all(json.loads(row[0])["eventName"] != "conversation.turn.completed"
               for row in box.db.execute("SELECT payload FROM events"))
    assert box.db.execute("SELECT state FROM turn_journal WHERE current=1 AND account='a'").fetchone()[0] == "running"
    box.db.close()


def wait_until(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.02)
    raise AssertionError("background worker did not finish")


def test_real_discovery_hooks_middleware_storage_and_profile_a_b_a(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from hermes_cli.plugins import get_plugin_manager
    from hermes_cli.middleware import run_llm_execution_middleware

    credential = hashlib.sha256(b"fixture-model-key").hexdigest()
    model = {"modelId": "model", "modelName": "Model", "productId": "real-plan", "provider": "yuanjing",
             "runtimeProvider": "custom:managed", "baseUrl": "https://model.invalid/v1", "credential": credential}
    context = {"account": "fixture-account", "enabled": True, "revision": "revision", "models": [model],
               "client": {"platform": "windows", "appVersion": "test"}}
    uploaded = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path == "/v1/chat/completions":
                usage = {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23,
                         "prompt_tokens_details": {"cached_tokens": 4}}
                common = {"id": "fixture-response", "model": "model", "created": int(time.time())}
                if body.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    chunks = [
                        {**common, "object": "chat.completion.chunk", "choices": [
                            {"index": 0, "delta": {"role": "assistant", "content": "done"}, "finish_reason": None}]},
                        {**common, "object": "chat.completion.chunk", "usage": usage, "choices": [
                            {"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    ]
                    for chunk in chunks:
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({**common, "object": "chat.completion", "usage": usage, "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}).encode())
                return
            reply = context
            if self.path == "/input":
                reply = {"userInput": "hello😀", "submissionId": "visible-send", "requestKind": "user"}
            if self.path == "/batch":
                uploaded.append(body)
                reply = {"status": 200, "body": {"code": 200, "data": {"results": [
                    {"index": index, "status": "accepted"} for index, _ in enumerate(body["events"])]}}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(reply).encode())
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    model["baseUrl"] = f"http://127.0.0.1:{server.server_port}/v1"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("UNIWORK_TELEMETRY_BRIDGE", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("UNIWORK_TELEMETRY_TOKEN", "fixture-bridge-token")
    monkeypatch.setenv("UNIWORK_TELEMETRY_CONTEXT", json.dumps(context))
    monkeypatch.setenv("DESKTOP_MT_MAAS_API_KEY", "fixture-model-key")
    bundled = tmp_path / "empty-bundled"
    bundled.mkdir()
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    managers = {}

    @contextmanager
    def profile(name):
        home = tmp_path / name
        if not home.exists():
            shutil.copytree(SOURCE, home / "plugins/uniwork-telemetry")
            (home / "config.yaml").write_text(yaml.safe_dump({"plugins": {"enabled": ["uniwork-telemetry"]},
                "providers": {"managed": {"api": model["baseUrl"], "key_env": "DESKTOP_MT_MAAS_API_KEY"}}}), encoding="utf-8")
        scope = set_hermes_home_override(str(home))
        try:
            manager = get_plugin_manager()
            manager.discover_and_load()
            managers[name] = manager
            loaded = manager._plugins["uniwork-telemetry"]
            assert loaded.enabled and loaded.error is None
            yield home, manager
        finally:
            reset_hermes_home_override(scope)

    try:
        for name, turn in (("a", "first"), ("b", "second"), ("a", "third")):
            with profile(name) as (home, manager):
                ids = {"session_id": "session-" + name, "turn_id": turn, "task_id": "task-" + name,
                       "platform": "desktop", "model": "model", "provider": "custom", "base_url": model["baseUrl"]}
                assert manager.invoke_hook("pre_llm_call", **ids, user_message="hello😀", future_additive_field=True) == []
                downstream_calls = []
                result = SimpleNamespace(usage={"prompt_tokens": 20, "completion_tokens": 3,
                                               "prompt_tokens_details": {"cached_tokens": 4}})
                # Retries reuse native api_request_id: two actual executions still contribute twice.
                for _ in range(2):
                    actual = run_llm_execution_middleware({"messages": []}, lambda body: downstream_calls.append(body) or result,
                                                         **ids, api_request_id="same-native-request")
                    assert actual is result
                assert len(downstream_calls) == 2
                manager.invoke_hook("post_llm_call", **ids, assistant_response="done")
                manager.invoke_hook("on_session_end", **ids, completed=True, failed=False, interrupted=False, turn_exit_reason="text_response(4 chars)")
                command = manager._plugin_commands["usage-report"]["handler"]
                wait_until(lambda: json.loads(command("status"))["events"].get("pending", 0) >= 1)
                command("flush")
                wait_until(lambda: json.loads(command("status"))["events"].get("pending", 0) == 0)
        assert len(uploaded) == 3
        assert [batch["events"][0]["conversation"]["sessionId"] for batch in uploaded] == ["session-a", "session-b", "session-a"]
        for batch in uploaded:
            assert batch["events"][0]["conversation"]["userInput"] == "hello😀"
            assert batch["events"][0]["usages"][0]["inputTokens"] == 40
            assert batch["events"][0]["usages"][0]["cachedTokens"] == 8
            assert "fixture-model-key" not in json.dumps(batch)
        with profile("a") as (home, manager):
            command = manager._plugin_commands["usage-report"]["handler"]
            # Run an actual AIAgent turn too: the localhost fixture replaces only the remote model/API.
            from run_agent import AIAgent

            agent = AIAgent(model="model", provider="custom", requested_provider="custom:managed",
                            base_url=model["baseUrl"], api_key="fixture-model-key", api_mode="chat_completions",
                            platform="desktop", session_id="actual-agent-session", max_iterations=2, max_tokens=64,
                            enabled_toolsets=[], skip_memory=True, skip_background_review=True, skip_context_files=True,
                            quiet_mode=True, cwd=str(home))
            try:
                result = agent.run_conversation("hello😀", task_id="actual-agent-session")
                assert result["completed"] is True and result["final_response"] == "done"
                wait_until(lambda: json.loads(command("status"))["events"].get("pending", 0) >= 1)
                command("flush")
                wait_until(lambda: len(uploaded) == 4)
                event = uploaded[-1]["events"][0]
                assert event["conversation"]["sessionId"] == "actual-agent-session"
                assert event["usages"][0]["inputTokens"] == 20
            finally:
                agent.close()
            command("off")
            assert yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))["plugins"]["entries"]["uniwork-telemetry"]["settings"]["enabled"] is False
            assert json.loads(command("status"))["enabled"] is False
    finally:
        for manager in managers.values():
            manager.unload()
        server.shutdown()
        server.server_close()
        thread.join(2)
