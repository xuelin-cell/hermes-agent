"""Real plugin/Agent caller for the desktop telemetry bridge integration test."""

import importlib
import json
import os
from pathlib import Path
import time

from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from hermes_cli.plugins import get_plugin_manager


def wait_for_sent(command, count):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        status = json.loads(command("status"))
        if status["events"].get("sent", 0) == count:
            return status
        command("flush")
        time.sleep(0.25)
    raise AssertionError(json.loads(command("status")))


manager = get_plugin_manager()
manager.discover_and_load()
scope = set_hermes_home_override(manager.home_path)
agent = None
try:
    loaded = manager._plugins["uniwork-telemetry"]
    assert loaded.error is None and loaded.enabled, loaded.error
    client = importlib.import_module(loaded.module.__name__ + ".bridge_client")
    # The real manager's Windows home is normcase'd. A JS-only HTTP test misses this boundary.
    context = client.call_bridge("/context", get_hermes_home())
    assert context["enabled"] is True
    model = context["models"][0]
    command = manager._plugin_commands["usage-report"]["handler"]
    observed_tools = []
    command.__self__.ctx.register_hook("post_tool_call", lambda **payload: observed_tools.append({
        key: payload.get(key) for key in ("tool_name", "tool_call_id", "session_id", "turn_id", "status", "result")
    }))
    from tui_gateway import server
    from datetime import datetime, timezone

    tag = 'tag ' + json.dumps({"id": "accepted-send", "tag": {"id": "server-writing-ABC", "name": "帮我写作"},
                              "occurredAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds")})
    command("off")
    command(tag.replace("accepted-send", "disabled-send"))
    command("on")
    command('tag {"id":"malformed","tag":null}')
    for _ in range(2):
        response = server._methods["command.dispatch"]("tag-probe", {"name": "usage-report", "arg": tag})
        assert response["result"]["type"] == "plugin", response
    # Accepted sends count before any Agent executes, and duplicate notifications never add a second event.
    wait_for_sent(command, 1)
    from tools.mcp_tool_discovery import discover_mcp_tools

    names = discover_mcp_tools()
    assert "mcp__UniAI_Toolkit__txt2img_generate" in names, names
    assert "mcp__connector_amap__route" in names, names
    from run_agent import AIAgent

    agent = AIAgent(
        model=model["modelId"], provider="custom", requested_provider=model["runtimeProvider"],
        base_url=model["baseUrl"], api_key=os.environ["DESKTOP_MT_MAAS_API_KEY"], api_mode="chat_completions",
        platform="desktop", session_id="telemetry-probe-session", max_iterations=4, max_tokens=128,
        enabled_toolsets=["mcp-UniAI-Toolkit", "mcp-connector_amap"], skip_memory=True, skip_background_review=True, skip_context_files=True,
        quiet_mode=True, cwd=str(get_hermes_home()),
    )
    result = agent.run_conversation("bridge migration probe", task_id="telemetry-probe-session")
    assert result["completed"] is True and result["final_response"] == "received"
    assert len(observed_tools) == 3, {
        "observed": observed_tools,
        "tool_results": [message for message in result.get("messages", []) if message.get("role") == "tool"],
    }
    status = wait_for_sent(command, 4)
    assert status["delivery"] == 200
    assert status["dropped"] == 0
    assert not status["coverageGaps"].get("input_correlation_unavailable")
    assert not status["coverageGaps"].get("unbound_desktop_request")
    assert not status["coverageGaps"].get("capability_identity_unknown")
    (Path(get_hermes_home()) / "probe-result.json").write_text(
        json.dumps({"telemetry_probe": "passed", "status": status}), encoding="utf-8")
finally:
    if agent is not None:
        agent.close()
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    shutdown_mcp_servers()
    manager.unload()
    reset_hermes_home_override(scope)
