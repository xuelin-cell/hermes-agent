"""Real Agent interruption/restart probe. Only the remote model and MCP service are fixtures."""

import json
import os
from pathlib import Path
import sqlite3
import sys
import time

from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from hermes_cli.plugins import get_plugin_manager
from tui_gateway.turn_marker import record_turn_start

phase, message = sys.argv[1:3]
session = "resume-session"
manager = get_plugin_manager()
manager.discover_and_load()
scope = set_hermes_home_override(manager.home_path)
home = Path(get_hermes_home())
command = manager._plugin_commands["usage-report"]["handler"]
db_path = home / "plugin-data/uniwork-telemetry/data.db"


def checkpoint(expected):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if db_path.exists():
            with sqlite3.connect(db_path) as db:
                try:
                    row = db.execute("SELECT state,snapshot FROM turn_journal WHERE current=1").fetchone()
                except sqlite3.OperationalError:
                    row = None
                if row and row[0] == expected:
                    return json.loads(row[1])
        time.sleep(0.02)
    raise AssertionError(f"No durable {expected} checkpoint: {command('status')}")


def flush():
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        command("flush")
        status = json.loads(command("status"))
        if status["queue"] == 0 and not status["events"].get("pending"):
            return status
        time.sleep(0.1)
    raise AssertionError(command("status"))


agent = None
try:
    runtime = command.__self__
    model = runtime.context["models"][0]
    if phase == "crash":
        def die_after_reply(**_payload):
            checkpoint("running")
            os._exit(99)  # Deliberately bypass finally/unload and the terminal hook.
        runtime.ctx.register_hook("post_llm_call", die_after_reply)

    if phase == "pause":
        from tools.mcp_tool_discovery import discover_mcp_tools
        assert "mcp__connector_amap__route" in discover_mcp_tools()

    from run_agent import AIAgent

    agent = AIAgent(
        model=model["modelId"], provider="custom", requested_provider=model["runtimeProvider"],
        base_url=model["baseUrl"], api_key=os.environ["DESKTOP_MT_MAAS_API_KEY"], api_mode="chat_completions",
        platform="desktop", session_id=session, max_iterations=3, max_tokens=128,
        enabled_toolsets=["mcp-connector_amap"] if phase == "pause" else [],
        tool_complete_callback=(lambda *_args: agent.interrupt("fixture pause")) if phase == "pause" else None,
        skip_memory=True, skip_background_review=True, skip_context_files=True, quiet_mode=True, cwd=str(home),
    )
    # This is the same public marker writer used by prompt.submit before entering the Agent.
    record_turn_start(home, session, message)
    history_file = home / "resume-history.json"
    history = json.loads(history_file.read_text(encoding="utf-8")) if phase == "resume" and history_file.exists() else None
    result = agent.run_conversation(message, task_id=session, conversation_history=history)
    if phase == "pause":
        assert result["interrupted"] is True and result["completed"] is False, result
        history_file.write_text(json.dumps(result["messages"]), encoding="utf-8")
    else:
        assert result["completed"] is True and result["final_response"] == "done", result
    state = checkpoint("interrupted" if phase == "pause" else "finished")
    status = flush()
    (home / "resume-result.json").write_text(json.dumps({"checkpoint": state, "status": status}), encoding="utf-8")
finally:
    if agent is not None:
        agent.close()
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    shutdown_mcp_servers()
    manager.unload()
    reset_hermes_home_override(scope)
