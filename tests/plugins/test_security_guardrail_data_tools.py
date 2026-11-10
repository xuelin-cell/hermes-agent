"""Data-tool adapters reach their real stores/callbacks after final authorization."""

import json
from types import SimpleNamespace

from agent.agent_runtime_helpers import invoke_tool
from hermes_state import SessionDB
from model_tools import handle_function_call
from tests.plugins.test_security_guardrail import profile


def test_skill_recall_clarify_and_delegate_callback_boundaries(tmp_path):
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    skill = home / "skills" / "guardrail-fixture"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: guardrail-fixture\ndescription: local test fixture\n---\n# Fixture\nlocal-skill-proof\n", encoding="utf-8")
    with profile(home, root) as task_id:
        result = json.loads(handle_function_call("skill_view", {"name": "guardrail-fixture"}, task_id=task_id))
        assert "local-skill-proof" in json.dumps(result), result
        db = SessionDB(home / "recall.db")
        db.create_session("past-session", source="cli")
        db.append_message("past-session", role="user", content="guardrail-recall-proof")
        callbacks = []
        def ask(question, choices, **kwargs):
            callbacks.append(question)
            return "synthetic-answer"
        agent = SimpleNamespace(session_id="current-session", _memory_manager=None,
            _get_session_db_for_recall=lambda: db, clarify_callback=ask,
            _dispatch_delegate_task=lambda args: callbacks.append(args["goal"]) or json.dumps({"local_child_callback": True}))
        try:
            result = json.loads(invoke_tool(agent, "session_search", {"session_id": "past-session"}, task_id, pre_tool_block_checked=True))
            assert "guardrail-recall-proof" in json.dumps(result), result
            result = json.loads(invoke_tool(agent, "clarify", {"question": "synthetic-question"}, task_id, pre_tool_block_checked=True))
            assert result["user_response"] == "synthetic-answer", result
            result = json.loads(invoke_tool(agent, "delegate_task", {"goal": "synthetic-goal"}, task_id, pre_tool_block_checked=True))
            assert result["local_child_callback"] and callbacks == ["synthetic-question", "synthetic-goal"]
        finally:
            db.close()
    with profile(home, root, settings={"user_rules": [{"tool": "DelegateTask", "behavior": "deny"}]}) as task_id:
        result = json.loads(invoke_tool(agent, "delegate_task", {"goal": "must-not-call"}, task_id, pre_tool_block_checked=True))
        assert "security-guardrail: user" in result["error"]
        assert callbacks == ["synthetic-question", "synthetic-goal"]


def test_process_output_and_stop_use_real_background_process(tmp_path):
    from tests.plugins.test_security_guardrail_terminal import terminal
    from tools.process_registry import process_registry
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    with profile(tmp_path / "home", root) as task_id:
        result = terminal("printf process-ready; sleep 30", task_id, background=True)
        assert not result.get("error"), result
        session = result["session_id"]
        try:
            for action in ("list", "poll", "log", "kill"):
                result = json.loads(handle_function_call("process_manage", {"action": action, "session_id": session}, task_id=task_id))
                assert not result.get("error"), result
        finally:
            process_registry.kill_process(session)
