"""Inline tools must authorize after middleware just like registry tools."""

import json
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from types import SimpleNamespace

from agent.agent_runtime_helpers import invoke_tool
from agent.tool_executor import _ToolCallRef, _resolve_sequential_dispatch
from hermes_cli.plugins import PluginContext, get_plugin_manager
from hermes_cli.plugins_manifest import PluginManifest
from tests.plugins.test_security_guardrail import profile
from tools.memory_tool_store import MemoryStore


def test_inline_memory_serial_and_concurrent_share_final_gate(tmp_path):
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    home = tmp_path / "home"
    with profile(home, root) as task_id:
        agent = SimpleNamespace(session_id="session-1", _memory_manager=None,
            _memory_store=MemoryStore(memory_char_limit=500, user_char_limit=500),
            quiet_mode=True, valid_tool_names={"memory"})
        args = {"action": "add", "target": "user", "content": "synthetic-private-note"}
        ctx = PluginContext(PluginManifest(name="inline-policy"), get_plugin_manager())
        seen = []
        def reject(execution):
            seen.append((execution.tool_name, execution.arguments["content"]))
            return {"action": "block", "message": "inline-veto"}
        registration = ctx.register_hook("pre_tool_execute", reject)
        try:
            with ThreadPoolExecutor(max_workers=1) as worker:
                result = json.loads(worker.submit(copy_context().run, lambda: invoke_tool(
                    agent, "memory", args, task_id, "parallel-1", pre_tool_block_checked=True)).result(timeout=30))
            assert result.get("error") == "inline-veto", result
            ref = _ToolCallRef(name="memory", args=args, call_id="serial-1", task_id=task_id, trace=[])
            dispatch = _resolve_sequential_dispatch(agent, ref, [])
            result = json.loads(dispatch.execute(args))
            assert result.get("error") == "inline-veto", result
            assert seen == [("memory", "synthetic-private-note")] * 2
            assert not (home / "memories" / "USER.md").exists()
        finally:
            registration.dispose()
        result = json.loads(invoke_tool(agent, "memory", args, task_id, "allow-1", pre_tool_block_checked=True))
        assert result["success"], result
        assert "synthetic-private-note" in (home / "memories" / "USER.md").read_text(encoding="utf-8")


def test_tool_search_unwrap_checks_real_todo_once(tmp_path):
    from agent.tool_executor import _unwrap_tool_search_call
    from tools.todo_tool import TodoStore
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    with profile(tmp_path / "home", root) as task_id:
        agent = SimpleNamespace(session_id="todo-session", _todo_store=TodoStore(), _memory_manager=None,
                                enabled_toolsets=["todo"], disabled_toolsets=[])
        seen = []
        ctx = PluginContext(PluginManifest(name="todo-observer"), get_plugin_manager())
        registration = ctx.register_hook("pre_tool_execute", lambda execution: seen.append(execution.tool_name))
        try:
            name, args, error = _unwrap_tool_search_call(agent, "tool_call", {"calls": [{
                "name": "todo_list", "arguments": {"todos": [{"id": "one", "content": "real todo", "status": "pending"}]}}]})
            assert error is None and name == "todo_list"
            result = json.loads(invoke_tool(agent, name, args, task_id, "todo-1", pre_tool_block_checked=True))
            assert not result.get("error"), result
            assert agent._todo_store.read()[0]["content"] == "real todo"
            assert seen == ["todo_list"]
        finally:
            registration.dispose()
