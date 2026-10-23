"""Tests for interrupt handling in concurrent tool execution."""

import threading
import time
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    (tmp_path / ".hermes").mkdir(exist_ok=True)


def _make_agent(monkeypatch):
    """Create a minimal AIAgent-like object with just the methods under test."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    monkeypatch.setenv("HERMES_INFERENCE_PROVIDER", "")
    # Avoid full AIAgent init — just import the class and build a stub
    import run_agent as _ra

    class _Stub:
        _interrupt_requested = False
        _interrupt_message = None
        # Bind to this thread's ident so interrupt() targets a real tid.
        _execution_thread_id = threading.current_thread().ident
        _interrupt_thread_signal_pending = False
        log_prefix = ""
        quiet_mode = True
        verbose_logging = False
        log_prefix_chars = 200
        _checkpoint_mgr = MagicMock(enabled=False)
        _subdirectory_hints = MagicMock()
        tool_progress_callback = None
        tool_start_callback = None
        tool_complete_callback = None
        _todo_store = MagicMock()
        _session_db = None
        valid_tool_names = set()
        _turns_since_memory = 0
        _iters_since_skill = 0
        _current_tool = None
        _last_activity = 0
        _print_fn = print
        # Worker-thread tracking state mirrored from AIAgent.__init__ so the
        # real interrupt() method can fan out to concurrent-tool workers.
        _active_children: list = []

        def __init__(self):
            # Instance-level (not class-level) so each test gets a fresh set.
            self._tool_worker_threads: set = set()
            self._tool_worker_threads_lock = threading.Lock()
            self._active_children_lock = threading.Lock()

        def _touch_activity(self, desc):
            self._last_activity = time.time()

        def _vprint(self, msg, force=False):
            pass

        def _safe_print(self, msg):
            pass

        def _should_emit_quiet_tool_messages(self):
            return False

        def _should_start_quiet_spinner(self):
            return False

        def _has_stream_consumers(self):
            return False

    stub = _Stub()
    # Bind the real methods under test
    stub._execute_tool_calls_concurrent = _ra.AIAgent._execute_tool_calls_concurrent.__get__(stub)
    stub.interrupt = _ra.AIAgent.interrupt.__get__(stub)
    stub.clear_interrupt = _ra.AIAgent.clear_interrupt.__get__(stub)
    # /steer injection (added in PR #12116) fires after every concurrent
    # tool batch. Stub it as a no-op — this test exercises interrupt
    # fanout, not steer injection.
    stub._apply_pending_steer_to_tool_results = lambda *a, **kw: None
    stub._invoke_tool = MagicMock(side_effect=lambda *a, **kw: '{"ok": true}')
    return stub


class _FakeToolCall:
    def __init__(self, name, args="{}", call_id="tc_1"):
        self.function = MagicMock(name=name, arguments=args)
        self.function.name = name
        self.id = call_id


class _FakeAssistantMsg:
    def __init__(self, tool_calls):
        self.tool_calls = tool_calls


def test_execution_finished_does_not_commit_before_parallel_sibling(monkeypatch):
    """单工具结束及时反馈，但慢工具返回前不得提交结果或宣布最终完成。"""
    from tui_gateway import server

    agent = _make_agent(monkeypatch)
    release = threading.Event()
    observed = threading.Event()
    messages = []
    progress = []
    completed = []
    agent._tool_guardrails = MagicMock()
    agent._tool_guardrails.before_call.return_value.allows_execution = True
    agent._append_guardrail_observation = lambda name, args, result, **kw: result
    agent._record_file_mutation_result = MagicMock()
    agent._tool_result_content_for_active_model = lambda name, result: result
    agent._subdirectory_hints.check_tool_call.return_value = ""
    agent._flush_messages_to_session_db = MagicMock(return_value=True)
    monkeypatch.setitem(server._sessions, "progress-test", {
        "tool_started_at": {"skill": time.time(), "search": time.time()},
    })
    monkeypatch.setattr(server, "_tool_progress_enabled", lambda sid: True)

    def emit(event, sid, payload):
        """通过真实网关投影确认客户端能收到不含结果的状态事件。"""
        if event == "tool.execution_finished" and payload["tool_id"] == "skill":
            progress.append(payload)
            observed.set()

    monkeypatch.setattr(server, "_emit", emit)

    def invoke(name, *args, **kwargs):
        """用事件控制搜索结束，避免依赖机器执行速度。"""
        if name == "web_search":
            assert release.wait(10)
        return '{"ok": true}'

    def on_progress(event, name, preview=None, *args, **kwargs):
        """记录技能的执行结束通知，供主测试线程同步。"""
        if event == "tool.execution_finished" and name == "skill_view":
            server._on_tool_progress("progress-test", event, name, preview, **kwargs)

    agent._invoke_tool.side_effect = invoke
    agent.tool_progress_callback = on_progress
    agent.tool_complete_callback = lambda *args: completed.append(args)
    calls = [_FakeToolCall("skill_view", call_id="skill"), _FakeToolCall("web_search", call_id="search")]
    from agent.tool_executor import execute_tool_calls_concurrent
    thread = threading.Thread(
        target=execute_tool_calls_concurrent,
        args=(agent, _FakeAssistantMsg(calls), messages, "test"), kwargs={"finalize": False},
    )
    thread.start()
    try:
        assert observed.wait(5), "技能结束后不应等待同批搜索才能反馈"
        assert thread.is_alive()
        assert messages == []
        assert completed == []
        agent._flush_messages_to_session_db.assert_not_called()
        assert progress[0]["tool_id"] == "skill"
        assert "result" not in progress[0]
    finally:
        release.set()
        thread.join(10)
    assert not thread.is_alive()
    assert [message["tool_call_id"] for message in messages] == ["skill", "search"]
    assert len(completed) == 2
    assert agent._flush_messages_to_session_db.call_count == 2




def test_concurrent_preflight_interrupt_skips_all(monkeypatch):
    """When _interrupt_requested is already set before concurrent execution,
    all tools are skipped with cancellation messages."""
    agent = _make_agent(monkeypatch)
    agent._interrupt_requested = True

    tc1 = _FakeToolCall("tool_a", call_id="tc_a")
    tc2 = _FakeToolCall("tool_b", call_id="tc_b")
    msg = _FakeAssistantMsg([tc1, tc2])
    messages = []

    agent._execute_tool_calls_concurrent(msg, messages, "test_task")

    assert len(messages) == 2
    assert "skipped due to user interrupt" in messages[0]["content"]
    assert "skipped due to user interrupt" in messages[1]["content"]
    # _invoke_tool should never have been called
    agent._invoke_tool.assert_not_called()




def test_clear_interrupt_clears_worker_tids(monkeypatch):
    """After clear_interrupt(), stale worker-tid bits must be cleared so the
    next turn's tools — which may be scheduled onto recycled tids — don't
    see a false interrupt."""
    from tools.interrupt import is_interrupted, set_interrupt

    agent = _make_agent(monkeypatch)
    # Simulate a worker having registered but not yet exited cleanly (e.g. a
    # hypothetical bug in the tear-down).  Put a fake tid in the set and
    # flag it interrupted.
    fake_tid = threading.current_thread().ident  # use real tid so is_interrupted can see it
    with agent._tool_worker_threads_lock:
        agent._tool_worker_threads.add(fake_tid)
    set_interrupt(True, fake_tid)
    assert is_interrupted() is True  # sanity

    agent.clear_interrupt()

    assert is_interrupted() is False, (
        "clear_interrupt() did not clear the interrupt bit for a tracked "
        "worker tid — stale interrupt can leak into the next turn"
    )

