"""企业对接插件（deploy/hermes-mt/plugin）：会话头、工具调用上报。

- hermes 按 entry point 发现它，只在 plugins.enabled 里有它的 profile 加载；
- 模型请求发给平台时带 X-Uniwork-Session（对话最早的会话号）和 X-Uniwork-Turn，经 OpenAI SDK 真的发到线上；
- 工具调用按平台的格式记（摘要、打码、去重用的 id），攒批发，各种状态码按约定处理；
- plugin.json 没有或关着就什么都不做；插件出错不影响对话和工具。
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from .support import SERVER, TOKEN_ENV, write_settings, write_token  # 先把插件目录加进 sys.path
from uniwork_enterprise import PLUGIN_KEY, instance_for  # noqa: E402
from uniwork_enterprise import audit, headers, outbox as outbox_module
from uniwork_enterprise.outbox import BATCH, CLIENT_VERSION, PATH, QUEUE_LIMIT, Outbox
from uniwork_enterprise.sessions import ConversationRoots
from uniwork_enterprise.settings import Settings, Source, root_of


def _bump(path: Path) -> None:
    """改完文件把修改时间往后挪，免得同一时刻写两次被缓存当成没变。"""
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


# ---------------------------------------------------------------- 配置和令牌

def test_no_file_or_switched_off_means_off(root: Path) -> None:
    source = Source(root)
    assert source.settings().enabled and source.settings().tool_audit
    write_settings(root, enabled=False)
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    assert not source.settings().enabled
    write_settings(root, server="")
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    assert not source.settings().enabled  # 没有平台地址也不开
    (root / ".cache/uniwork-enterprise/plugin.json").unlink()
    assert source.settings() == Settings()


def test_settings_follow_the_file(root: Path) -> None:
    source = Source(root)
    assert source.settings().tool_audit
    write_settings(root, toolAudit=False)
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    assert source.settings().enabled and not source.settings().tool_audit


def test_the_token_comes_from_the_root_env_and_can_be_reread(root: Path) -> None:
    source = Source(root)
    assert source.token(TOKEN_ENV) == "tok-1"
    before = (root / ".env").stat()
    write_token(root, "tok-2")
    os.utime(root / ".env", ns=(before.st_atime_ns, before.st_mtime_ns))  # 同一时刻、同样长：缓存看不出来
    assert source.token(TOKEN_ENV) == "tok-1"
    assert source.token(TOKEN_ENV, force=True) == "tok-2"
    assert source.token("") == ""


@pytest.mark.parametrize(("url", "mine"), [
    (SERVER + "/v1", True), ("HTTP://Platform.Test:11220/", True), ("http://platform.test/v1", False),
    ("https://platform.test:11220/v1", False), ("http://other.test:11220/v1", False), ("", False),
])
def test_only_the_platform_counts(url: str, mine: bool) -> None:
    assert Settings(enabled=True, server=SERVER, token_env=TOKEN_ENV).is_platform(url) is mine
    assert Settings(enabled=True, server="http://p.test").is_platform("http://p.test:80/v1")


def test_profiles_share_the_instance_root(tmp_path: Path) -> None:
    assert root_of(tmp_path / "opt-data" / "profiles" / "uw-a1") == tmp_path / "opt-data"
    assert root_of(tmp_path / "opt-data") == tmp_path / "opt-data"


# ---------------------------------------------------------------- 会话号

def test_the_conversation_root_follows_hermes_lineage(tmp_path: Path) -> None:
    from hermes_state import SessionDB

    db = SessionDB(tmp_path / "state.db")
    db.create_session("first", source="cli")
    db.create_session("helper", source="delegate", parent_session_id="first")
    roots = ConversationRoots(tmp_path)
    assert roots.root("helper") == "first"
    assert roots.root("first") == "first"
    assert roots.root("") == ""
    assert roots.root("late") == "late"  # 还没落库：用它自己，但不记住
    db.create_session("late", source="delegate", parent_session_id="first")
    assert roots.root("late") == "first"


def test_a_failing_lookup_uses_the_session_itself(tmp_path: Path) -> None:
    def broken():
        raise OSError("no database")

    assert ConversationRoots(tmp_path, db_factory=broken).root("s1") == "s1"


# ---------------------------------------------------------------- 会话头

class _Roots:
    def __init__(self, mapping=None, error: Exception | None = None):
        self.mapping, self.error = mapping or {}, error

    def root(self, session_id: str) -> str:
        if self.error is not None:
            raise self.error
        return self.mapping.get(session_id, session_id)


def test_headers_go_only_to_the_platform(root: Path) -> None:
    source, roots = Source(root), _Roots({"seg-2": "seg-1"})
    got = headers.session_headers(source, roots, session_id="seg-2", turn_id="seg-2:task:ab12", base_url=SERVER + "/v1")
    assert got == {"X-Uniwork-Session": "seg-1", "X-Uniwork-Turn": "seg-2:task:ab12"}
    assert headers.session_headers(source, roots, session_id="seg-2", turn_id="t", base_url="https://api.other/v1") == {}
    assert headers.session_headers(source, roots, session_id="", turn_id="t", base_url=SERVER + "/v1") == {}
    write_settings(root, enabled=False)
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    assert headers.session_headers(source, roots, session_id="seg-2", turn_id="t", base_url=SERVER + "/v1") == {}


def test_the_middleware_adds_to_the_existing_headers_and_calls_on_once(root: Path) -> None:
    seen = []
    middleware = headers.make_middleware(Source(root), _Roots({"s2": "s1"}))
    request = {"model": "m", "messages": [], "extra_headers": {"X-Uniwork-Agent": "a1"}}
    result = middleware(request=request, next_call=lambda r: seen.append(r) or "response", session_id="s2",
                        turn_id="t" * 300, base_url=SERVER + "/v1", api_mode="chat_completions")
    assert result == "response" and len(seen) == 1
    assert seen[0]["extra_headers"] == {"X-Uniwork-Agent": "a1", "X-Uniwork-Session": "s1",
                                        "X-Uniwork-Turn": "t" * headers.MAX_HEADER_CHARS}
    assert request["extra_headers"] == {"X-Uniwork-Agent": "a1"}  # 原请求不动


def test_a_broken_lookup_passes_the_request_through(root: Path) -> None:
    seen = []
    middleware = headers.make_middleware(Source(root), _Roots(error=RuntimeError("boom")))
    request = {"model": "m"}
    middleware(request=request, next_call=seen.append, session_id="s", turn_id="t", base_url=SERVER + "/v1")
    assert seen == [request]


# ---------------------------------------------------------------- 工具调用的格式

NOW = datetime(2026, 10, 29, 8, 0, 0, tzinfo=timezone.utc)


def _item(**kw):
    base = {"tool_name": "read_file", "args": {"path": "/opt/data/workspace/a.md"}, "result": '{"content": "x"}',
            "session": "s1", "turn_id": "s1:task:ab12", "tool_call_id": "call_1", "duration_ms": 250, "now": NOW}
    base.update(kw)
    return audit.item(**base)


def test_a_builtin_call_in_the_platforms_shape() -> None:
    entry = _item()
    assert entry["tool"] == "read_file" and entry["kind"] == "builtin" and entry["mcpServer"] == ""
    assert entry["target"] == "/opt/data/workspace/a.md" and entry["result"] == "ok" and "error" not in entry
    assert entry["sessionId"] == "s1" and entry["turnId"] == "s1:task:ab12" and entry["mode"] == "office"
    assert entry["durationMs"] == 250 and entry["resultBytes"] == len('{"content": "x"}')
    assert entry["startedAt"] == (NOW - timedelta(milliseconds=250)).isoformat()


def test_contents_and_secrets_never_leave() -> None:
    secret = "sk-abcdef1234567890abcdef1234567890"
    entry = _item(tool_name="write_file", args={"path": "/w/a.md", "content": "line1\nline2", "api_key": secret})
    assert entry["args"] == {"path": "/w/a.md", "content": {"bytes": 11, "lines": 2}, "api_key": "***"}
    command = f"curl -H 'Authorization: Bearer {secret}' https://x.test/a"
    entry = _item(tool_name="terminal", args={"command": command}, result='{"output": "", "exit_code": 2}')
    assert secret not in json.dumps(entry, ensure_ascii=False)
    assert entry["target"].startswith("curl") and entry["exitCode"] == 2
    entry = _item(tool_name="web_extract", args={"urls": ["https://user:pw@a.test/x?api_key=1&q=2#frag"]})
    assert entry["target"] == "https://a.test/x?api_key=%2A%2A%2A&q=2"
    code = _item(tool_name="execute_code", args={"code": "print(1)\n" * 50})
    assert code["args"] == {"code": {"bytes": 450, "lines": 51}} and code["target"] == ""


@pytest.mark.parametrize(("tool", "kind", "server"), [
    ("mcp__uniwork_ent_uniwork_knowledge__search_knowledge", "mcp", "uniwork_ent_uniwork_knowledge"),
    ("delegate_task", "subagent", ""), ("skill_view", "skill", ""), ("terminal", "builtin", ""),
])
def test_kinds(tool: str, kind: str, server: str) -> None:
    entry = _item(tool_name=tool)
    assert (entry["kind"], entry["mcpServer"]) == (kind, server)


@pytest.mark.parametrize(("status", "message", "result", "want"), [
    ("error", "BLOCKED: User denied this command.", "", "denied_user"),
    ("error", "", '{"error": "BLOCKED: User denied execute_code script execution"}', "denied_user"),
    ("blocked", "plugin said no", "", "denied_policy"),
    ("error", "BLOCKED: matched a hardline rule", "", "denied_policy"),
    ("interrupted", "", "", "cancelled"),
    ("error", "No such file: /x\nTraceback", "", "error"),
])
def test_outcomes(status: str, message: str, result: str, want: str) -> None:
    entry = _item(status=status, error_message=message, result=result)
    assert entry["result"] == want
    assert entry["error"] == (message or result).split("\n")[0][:200]


def test_retries_keep_the_same_id_and_bridge_reads_are_skipped() -> None:
    assert _item()["id"] == _item()["id"] != _item(tool_call_id="call_2")["id"]
    assert _item(tool_call_id="")["id"] != _item(tool_call_id="")["id"]
    assert _item(tool_name="tool_search") is None and _item(tool_name="tool_describe") is None


class _Queue:
    def __init__(self):
        self.items = []

    def put(self, entry):
        self.items.append(entry)


def test_the_hook_follows_the_switches_and_never_raises(root: Path) -> None:
    queue = _Queue()
    hook = audit.make_hook(Source(root), _Roots({"s2": "s1"}), queue)
    hook(tool_name="terminal", args={"command": "ls"}, result="{}", session_id="s2", turn_id="t1",
         tool_call_id="c1", duration_ms=5, status="ok", error_message=None, middleware_trace=[])
    assert [(e["tool"], e["sessionId"], e["turnId"]) for e in queue.items] == [("terminal", "s1", "t1")]
    write_settings(root, toolAudit=False)
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    hook(tool_name="terminal", args={}, result="{}", session_id="s2")
    assert len(queue.items) == 1
    write_settings(root)
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    broken = audit.make_hook(Source(root), _Roots(error=RuntimeError("boom")), queue)
    assert broken(tool_name="terminal", args={}, result="{}", session_id="s2") is None


# ---------------------------------------------------------------- 发送

class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _Platform:
    """按顺序回状态码（用完了一律 200）；记下每次请求。"""

    def __init__(self, codes=()):
        self.codes = list(codes)
        self.calls: list[tuple[str, dict, dict]] = []

    def __call__(self, url: str, payload: dict, request_headers: dict, timeout: float) -> int:
        self.calls.append((url, payload, request_headers))
        code = self.codes.pop(0) if self.codes else 200
        if code == "network":
            raise OSError("connection refused")
        return code


def _outbox(root: Path, platform: _Platform, clock: _Clock) -> Outbox:
    return Outbox(Source(root), post=platform, clock=clock, background=False)


def _fill(box: Outbox, n: int) -> None:
    for i in range(n):
        box.put({"id": str(i), "tool": "t"})


def test_batches_go_out_and_are_forgotten(root: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 450)
    assert box.flush() == 450 and len(box) == 0
    assert [len(p["items"]) for _, p, _ in platform.calls] == [BATCH, BATCH, 50]
    url, _, sent_headers = platform.calls[0]
    assert url == SERVER + PATH
    assert sent_headers == {"Authorization": "Bearer tok-1", "X-Uniwork-Version": CLIENT_VERSION}


def test_a_401_rereads_the_token_once(root: Path) -> None:
    platform, clock = _Platform([401]), _Clock()
    box = _outbox(root, platform, clock)
    box.source.token(TOKEN_ENV)  # 缓存住旧令牌
    before = (root / ".env").stat()
    write_token(root, "tok-2")
    os.utime(root / ".env", ns=(before.st_atime_ns, before.st_mtime_ns))
    _fill(box, 3)
    assert box.flush() == 3
    assert [h["Authorization"] for _, _, h in platform.calls] == ["Bearer tok-1", "Bearer tok-2"]


def test_a_second_401_drops_the_batch_and_waits_a_minute(root: Path) -> None:
    platform, clock = _Platform([401, 401]), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 3)
    assert box.flush() == 0 and len(box) == 0
    _fill(box, 2)
    assert box.flush() == 0 and len(platform.calls) == 2  # 歇着
    clock.now += outbox_module.UNAUTHORIZED_PAUSE_S + 1
    assert box.flush() == 2


def test_no_token_keeps_the_queue(root: Path) -> None:
    (root / ".env").write_text("TERMINAL_ENV=local\n", encoding="utf-8")
    platform, clock = _Platform(), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 3)
    assert box.flush() == 0 and len(box) == 3 and platform.calls == []
    write_token(root, "tok-3")
    clock.now += outbox_module.UNAUTHORIZED_PAUSE_S + 1
    assert box.flush() == 3


def test_403_clears_and_waits_five_minutes(root: Path) -> None:
    platform, clock = _Platform([403]), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 5)
    assert box.flush() == 0 and len(box) == 0
    _fill(box, 1)
    clock.now += 299
    assert box.flush() == 0 and len(platform.calls) == 1
    clock.now += 2
    assert box.flush() == 1


def test_404_keeps_the_queue_for_an_hour(root: Path) -> None:
    platform, clock = _Platform([404]), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 5)
    assert box.flush() == 0 and len(box) == 5
    clock.now += outbox_module.MISSING_PAUSE_S + 1
    assert box.flush() == 5


def test_a_rejected_batch_is_dropped_and_the_rest_still_goes(root: Path) -> None:
    platform, clock = _Platform([400]), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, BATCH + 10)
    assert box.flush() == 10 and len(box) == 0


def test_server_and_network_errors_back_off(root: Path) -> None:
    platform, clock = _Platform([500, "network"]), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 4)
    assert box.flush() == 0 and len(box) == 4
    clock.now += 4
    assert box.flush() == 0 and len(platform.calls) == 1  # 第一次退避 5 秒
    clock.now += 2
    assert box.flush() == 0 and len(platform.calls) == 2  # 连不上：退避翻倍到 10 秒
    clock.now += 9
    assert box.flush() == 0 and len(platform.calls) == 2
    clock.now += 2
    assert box.flush() == 4


def test_the_queue_keeps_the_newest_and_forgets_the_stale(root: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, QUEUE_LIMIT + 5)
    assert len(box) == QUEUE_LIMIT
    box.flush()
    sent = [e["id"] for _, p, _ in platform.calls for e in p["items"]]
    assert sent[0] == "5" and sent[-1] == str(QUEUE_LIMIT + 4)
    _fill(box, 3)
    clock.now += outbox_module.MAX_AGE_S + 1
    assert box.flush() == 0 and len(box) == 0


def test_switching_the_audit_off_drops_whats_queued(root: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _outbox(root, platform, clock)
    _fill(box, 3)
    write_settings(root, toolAudit=False)
    _bump(root / ".cache/uniwork-enterprise/plugin.json")
    assert box.flush() == 0 and len(box) == 0 and platform.calls == []


def test_the_status_file_tells_what_happened(root: Path) -> None:
    from uniwork_enterprise.status import Status

    platform, clock = _Platform([500]), _Clock()
    box = Outbox(Source(root), status=Status(root), post=platform, clock=clock, background=False)
    _fill(box, 3)
    box.flush()
    status = json.loads((root / ".cache/uniwork-enterprise/plugin-status.json").read_text(encoding="utf-8"))
    assert status["lastSend"]["code"] == 500 and status["lastSend"]["sent"] == 0 and status["queued"] == 3
    clock.now += 10
    box.flush()
    status = json.loads((root / ".cache/uniwork-enterprise/plugin-status.json").read_text(encoding="utf-8"))
    assert status["lastSend"]["code"] == 200 and status["lastSend"]["sent"] == 3 and status["queued"] == 0
    assert "tok-1" not in json.dumps(status)


def test_the_background_sender_goes_when_kicked(root: Path) -> None:
    sent = threading.Event()

    def platform(url, payload, request_headers, timeout):
        sent.set()
        return 200

    box = Outbox(Source(root), post=platform)
    box.put({"id": "1", "tool": "t"})
    box.kick()
    assert sent.wait(5)


# ---------------------------------------------------------------- 和 hermes 一起

@pytest.fixture
def hermes_home(root: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    (root / "config.yaml").write_text(f"plugins:\n  enabled:\n    - {PLUGIN_KEY}\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(Outbox, "_ensure_thread", lambda self: None)  # 不往假平台真发
    return root


@pytest.fixture
def manager(hermes_home: Path, monkeypatch: pytest.MonkeyPatch):
    import hermes_cli.plugins as plugins

    mgr = plugins.PluginManager()
    mgr.discover_and_load()
    monkeypatch.setattr(plugins, "_delivery_manager", lambda: mgr)
    return mgr


def test_hermes_loads_it_from_its_entry_point(manager) -> None:
    loaded = manager._plugins[PLUGIN_KEY]
    assert loaded.enabled and loaded.error is None and loaded.manifest.source == "entrypoint"
    assert [c.__name__ for c in manager._middleware["llm_execution"]] == ["uniwork_session_headers"]
    assert [c.__name__ for c in manager._hooks["post_tool_call"]] == ["uniwork_tool_audit"]


def test_hermes_skips_it_unless_enabled(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hermes_cli.plugins as plugins

    (root / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))
    mgr = plugins.PluginManager()
    mgr.discover_and_load()
    assert not mgr._plugins[PLUGIN_KEY].enabled
    assert "llm_execution" not in mgr._middleware


def test_the_llm_execution_chain_carries_the_headers(manager) -> None:
    from hermes_cli.middleware import run_llm_execution_middleware

    seen = []
    common = {"task_id": "task", "turn_id": "s1:task:ab12", "api_request_id": "r1", "session_id": "s1",
              "platform": "desktop", "model": "m", "provider": "custom", "api_mode": "chat_completions",
              "api_call_count": 1, "middleware_trace": []}
    run_llm_execution_middleware({"model": "m", "messages": []}, seen.append, base_url=SERVER + "/v1", **common)
    run_llm_execution_middleware({"model": "m", "messages": []}, seen.append, base_url="https://api.other/v1", **common)
    assert seen[0]["extra_headers"] == {"X-Uniwork-Session": "s1", "X-Uniwork-Turn": "s1:task:ab12"}
    assert "extra_headers" not in seen[1]


def test_a_finished_tool_call_reaches_the_queue(manager, hermes_home: Path) -> None:
    from model_tools import _emit_post_tool_call_hook

    _emit_post_tool_call_hook(function_name="read_file", function_args={"path": "/w/a.md"}, result='{"content": "x"}',
                              task_id="task", session_id="s1", tool_call_id="c1", turn_id="s1:task:ab12",
                              api_request_id="r1", duration_ms=12)
    queued = [entry for _, entry in instance_for(hermes_home).outbox._queue]  # noqa: SLF001
    assert [(e["tool"], e["sessionId"], e["turnId"], e["target"]) for e in queued] == [
        ("read_file", "s1", "s1:task:ab12", "/w/a.md")]


# ---------------------------------------------------------------- 线上真的带着头

class _Recorder(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).seen.append({k.lower(): v for k, v in self.headers.items()})
        if body.get("stream"):
            chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "m",
                     "choices": [{"index": 0, "delta": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]}
            payload = f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
        else:
            payload = json.dumps({"id": "c1", "object": "chat.completion", "created": 0, "model": "m",
                                  "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"},
                                               "finish_reason": "stop"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # noqa: D401
        pass


@pytest.mark.parametrize("stream", [False, True])
def test_the_openai_sdk_sends_the_headers(stream: bool) -> None:
    import openai

    from agent.sdk_transform_bypass import bypass_chat_sdk_request_transform

    _Recorder.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = openai.OpenAI(base_url=f"http://127.0.0.1:{server.server_port}/v1", api_key="k", max_retries=0,
                               default_headers={"X-Uniwork-Agent": "a1"})
        request = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": stream,
                   "extra_headers": {"X-Uniwork-Session": "s1", "X-Uniwork-Turn": "t1"}}
        response = client.chat.completions.create(**bypass_chat_sdk_request_transform(request, client))
        if stream:
            list(response)
    finally:
        server.shutdown()
    sent = _Recorder.seen[0]
    assert (sent["x-uniwork-session"], sent["x-uniwork-turn"], sent["x-uniwork-agent"]) == ("s1", "t1", "a1")
