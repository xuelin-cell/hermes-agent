"""The product plugin bridges hidden native chrome without changing core emission rules."""

import json
from tests.plugins.test_unisearch import load_package, allow_user_tool_override


# 原生隐藏过程时仍通过身份通知恢复卡片，不广播私密正文。
def test_cards_use_public_plugin_notices_in_answer_only(monkeypatch):
    import tui_gateway.server as server
    from hermes_cli.plugins import discover_plugins
    from hermes_cli.config import (
        read_user_config_raw,
        get_config_path,
        atomic_config_write,
    )
    from model_tools import handle_function_call
    from pathlib import Path
    import shutil
    import httpx

    provider, configure = load_package()
    from tests.plugins.test_unisearch import SOURCE
    from hermes_constants import get_hermes_home

    shutil.copytree(SOURCE, get_hermes_home() / "plugins/unisearch", dirs_exist_ok=True)
    configure.apply(None)
    allow_user_tool_override()
    discover_plugins(force=True)
    emitted, notices = [], []
    monkeypatch.setattr(server, "_sessions", {"s": {}})
    monkeypatch.setattr(server, "_process_tool_chrome_enabled", lambda sid: False)
    monkeypatch.setattr(
        server, "_emit", lambda event, sid, payload: emitted.append((event, payload))
    )
    monkeypatch.setattr(
        server,
        "_broadcast_global_event",
        lambda event, payload: notices.append((event, payload)),
    )
    from agent.secret_scope import set_secret_scope, reset_secret_scope

    original = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kw: original(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    200,
                    json={
                        "Response": {
                            "Pages": [
                                json.dumps({
                                    "vr": True,
                                    "vr_category": "unknown",
                                    "passage": "data",
                                })
                            ]
                        }
                    },
                )
            ),
            **kw,
        ),
    )
    token = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": "fake-test-key"})
    try:
        result = handle_function_call(
            "web_search",
            {"query": "private query"},
            session_id="s",
            tool_call_id="search-1",
            turn_id="turn1",
        )
    finally:
        reset_secret_scope(token)
    assert json.loads(result)["data"]["cards"]
    server._on_tool_complete(
        "s", "search-1", "web_search", {"query": "private query"}, result
    )
    assert (
        not emitted
    )  # The unchanged core still suppresses native successful web chrome.
    assert [n[0] for n in notices] == [
        "plugin.unisearch.tool.start",
        "plugin.unisearch.tool.complete",
    ]
    for _, payload in notices:
        assert payload["session_id"] == "s" and payload["tool_call_id"] == "search-1"
        assert payload["provider"] == "unisearch"
        assert "private query" not in json.dumps(
            payload
        ) and "fake-test-key" not in json.dumps(payload)
        assert "result" not in payload  # Global broadcast is identity-only.
