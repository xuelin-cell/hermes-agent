"""Real plugin dispatch → native message wrapping/SQLite flush → native scoped REST history."""

import json
import shutil
import httpx
import pytest
from fastapi import FastAPI
from agent.secret_scope import set_secret_scope, reset_secret_scope
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from .test_unisearch import load_package, SOURCE, allow_user_tool_override


# 实际调度结果经过原生包装与数据库，再由准确Profile历史读取。
@pytest.mark.asyncio
async def test_real_native_persistence_and_scoped_history(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from agent.tool_dispatch_helpers import make_tool_result_message
    from hermes_cli.web_routers.sessions import manage_router
    from hermes_cli.plugins import discover_plugins
    from model_tools import handle_function_call
    import tui_gateway.server as server

    _, configure = load_package()
    home = tmp_path / "root"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    ht = set_hermes_home_override(home)
    st = set_secret_scope({"DESKTOP_MT_MAAS_API_KEY": "fixture-key"}, profile_home=home)
    notices = []
    monkeypatch.setattr(
        server,
        "_broadcast_global_event",
        lambda name, payload: notices.append({"type": name, "payload": payload}),
    )
    original_client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kw: original_client(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    200,
                    json={
                        "Response": {
                            "Pages": [
                                json.dumps({
                                    "vr": True,
                                    "vr_category": "stock",
                                    "passage": "# 股票名称：示例\n# 实时股价：123.45",
                                })
                            ]
                        }
                    },
                )
            ),
            **kw,
        ),
    )
    shutil.copytree(SOURCE, home / "plugins/unisearch")
    db = SessionDB(home / "state.db")
    db.create_session("native-search-session", source="desktop")
    try:
        configure.apply(None)
        allow_user_tool_override()
        discover_plugins(force=True)
        result = handle_function_call(
            "web_search",
            {"query": "示例股票"},
            session_id="native-search-session",
            tool_call_id="search-1",
            turn_id="turn-1",
        )
        assert json.loads(result)["provider"] == "unisearch"
        assert (
            json.loads(result)["data"]["cards"][0]["raw"]["_canonical"]["price"]
            == "123.45"
        )
        messages = [
            {"role": "user", "content": "示例股票"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "search-1",
                        "type": "function",
                        "function": {
                            "name": "web_search",
                            "arguments": '{"query":"示例股票"}',
                        },
                    }
                ],
            },
            make_tool_result_message("web_search", result, "search-1"),
        ]
        agent = object.__new__(AIAgent)
        agent._session_db, agent._session_db_created = db, True
        agent.session_id, agent.platform, agent.model = (
            "native-search-session",
            "desktop",
            "fixture",
        )
        agent._persist_disabled = False
        assert agent._flush_messages_to_session_db(messages) is not False
        app = FastAPI()
        app.include_router(manage_router)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                "/api/sessions/native-search-session/messages?profile=default&order=latest&limit=200"
            )
            assert response.status_code == 200, response.text
            page = response.json()
            row = next(
                m for m in page["messages"] if m.get("tool_call_id") == "search-1"
            )
            assert row["role"] == "tool" and row["tool_name"] == "web_search"
            assert (
                "unisearch" in row["content"]
                and "untrusted_tool_result" in row["content"]
            )
            assert row["timestamp"] >= notices[0]["payload"]["timestamp"] - 0.01
            assert page["profile"] == "default"
            assert (
                await client.get(
                    "/api/sessions/native-search-session/messages?profile=nonexistent&order=latest&limit=200"
                )
            ).status_code in (400, 404)
    finally:
        db.close()
        reset_secret_scope(st)
        reset_hermes_home_override(ht)
