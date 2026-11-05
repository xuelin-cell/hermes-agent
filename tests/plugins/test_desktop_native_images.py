"""真实插件加载/工具分发与图片数据，视觉/文字和Profile切换不串路由。"""

import base64
import copy
from contextlib import contextmanager
from io import BytesIO
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
from PIL import Image
import pytest

TOOL = "desktop_read_image"
ANALYZE = "mcp__UniAI_Toolkit__analyze_image"


@pytest.fixture
def native(tmp_path, monkeypatch):
    """加载真实产品插件，只有远端MCP及OSS传输换成记录器。"""
    import model_tools
    from hermes_cli import plugins
    from hermes_cli.plugins_manifest import parse_manifest_file
    from hermes_constants import get_hermes_home
    from tools.registry import registry
    from gateway.run import _profile_runtime_scope
    from agent.auxiliary_client import scoped_runtime_main
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from gateway.session_context import set_session_vars, clear_session_vars

    managers, modules, calls, puts = {}, {}, [], []
    source = Path(__file__).resolve().parents[2] / "plugins/desktop-deliverables"
    monkeypatch.setattr(
        plugins, "_delivery_manager", lambda: managers[str(get_hermes_home())]
    )
    previous_multiplex = is_multiplex_active()
    set_multiplex_active(True)
    real_client = httpx.Client

    def transport(request):
        """记录真实上传器发出的PUT，不连接网络。"""
        puts.append(request.read())
        return httpx.Response(200)

    def remote(args, **_):
        """模拟已连接工具的返回，不替换工具分发链。"""
        calls.append(copy.deepcopy(args))
        return json.dumps({"result": "remote result"})

    def upload(args, **_):
        """保持元景上传回执格式。"""
        calls.append(copy.deepcopy(args))
        return json.dumps({
            "result": "上传地址：https://obs-nmhhht6.cucloud.cn/app-agent-prod/temp/frame.png?X-Amz-Signature=test 方法：PUT 请求头：Content-Type=image/png"
        })

    @contextmanager
    def scope(
        profile="a", model="image", platform="desktop", mode="auto", provider="custom"
    ):
        """以原生Profile和会话上下文驱动同名会话A/B/A。"""
        home = tmp_path / profile
        home.mkdir(exist_ok=True)
        work = home / "work"
        work.mkdir(exist_ok=True)
        cfg = {
            "model": {"provider": "custom:images", "default": "image"},
            "providers": {
                "custom:images": {
                    "models": {
                        "image": {"supports_vision": profile != "b"},
                        "text": {"supports_vision": False},
                    }
                }
            },
            "agent": {"image_input_mode": mode, "disabled_toolsets": ["vision"]},
            "terminal": {"backend": "local", "cwd": str(work)},
        }
        (home / "config.yaml").write_text(json.dumps(cfg))
        frame = work / ".tmp" / "frames" / "00-00-01.png"
        frame.parent.mkdir(parents=True, exist_ok=True)
        if not frame.exists():
            Image.new("RGB", (8, 6), "red").save(frame)
        with _profile_runtime_scope(home, prepared_secret_scope={}):
            if str(home) not in managers:
                manager = plugins.PluginManager()
                manifest = parse_manifest_file(
                    source / "plugin.yaml", source, "bundled", ""
                )
                manager._load_plugin(manifest)
                loaded = manager._plugins["desktop-deliverables"]
                assert loaded.enabled, loaded.error
                managers[str(home)] = manager
                modules[str(home)] = loaded.module
                from importlib import import_module

                uploads = import_module(loaded.module.__name__ + ".uploads")
                monkeypatch.setattr(
                    uploads,
                    "httpx",
                    SimpleNamespace(
                        Client=lambda **kw: real_client(
                            transport=httpx.MockTransport(transport), **kw
                        )
                    ),
                )
                for name in [
                    ANALYZE,
                    "mcp__yuanjing__analyze_image",
                    "mcp__1__analyze_image",
                    "mcp__other__analyze_image",
                    "mcp__UniAI_Toolkit__image_edit",
                    "mcp__UniAI_Toolkit__web_search",
                ]:
                    registry.register(
                        name=name,
                        toolset="native_image_test",
                        schema={"name": name, "parameters": {"type": "object"}},
                        handler=remote,
                        scope=manager.scope_key,
                    )
                registry.register(
                    name="mcp__UniAI_Toolkit__get_oss_upload_url",
                    toolset="native_image_test",
                    schema={"name": "mcp__UniAI_Toolkit__get_oss_upload_url"},
                    handler=upload,
                    scope=manager.scope_key,
                )
            tokens = set_session_vars(
                source=platform, session_id="same-session", cwd=str(work)
            )
            try:
                with scoped_runtime_main({
                    "provider": provider,
                    "requested_provider": "custom:images",
                    "model": model,
                }):
                    yield SimpleNamespace(
                        home=home,
                        path=frame,
                        module=modules[str(home)],
                        manager=managers[str(home)],
                    )
            finally:
                clear_session_vars(tokens)

    def execute(name, args):
        """走原生工具middleware、pre/post hooks和registry，不直接调实现。"""
        return model_tools.handle_function_call(
            name,
            args,
            task_id="same-session",
            session_id="same-session",
            tool_call_id="call",
        )

    yield SimpleNamespace(scope=scope, execute=execute, calls=calls, puts=puts)
    for manager in managers.values():
        manager.unload()
    set_multiplex_active(previous_multiplex)


def test_native_pixels_and_analysis_policy_follow_profile_and_model(
    native, monkeypatch
):
    """真图片保留到原生消息；文本/其他工具照旧，Profile及模型切换即时生效。"""
    from agent.vision_message_prep import VisionMessagePrepMixin
    from agent.tool_guardrails import ToolCallGuardrailController
    from run_agent import AIAgent
    from hermes_cli.middleware import apply_llm_request_middleware
    from model_tools import get_tool_definitions

    class Agent(VisionMessagePrepMixin):
        provider = "custom"
        _no_list_tool_content_models = set()
        _tool_guardrails = ToolCallGuardrailController()
        _stall_guards_enabled = lambda self: True

    for profile, model, sees in [
        ("a", "image", True),
        ("a", "text", False),
        ("b", "image", False),
        ("a", "image", True),
    ]:
        with native.scope(profile, model) as state:
            assert TOOL in {
                x["function"]["name"]
                for x in get_tool_definitions(
                    enabled_toolsets=["desktop_ui"], quiet_mode=True
                )
            }
            original = {
                "messages": [
                    {"role": "system", "content": "frozen system"},
                    {"role": "user", "content": "分析视频帧"},
                ]
            }
            before = copy.deepcopy(original)
            assert (
                apply_llm_request_middleware(
                    original, platform="desktop", model=model
                ).payload
                == before
            )
            assert original == before
            counts = len(native.calls), len(native.puts)
            loaded = native.execute(TOOL, {"path": str(state.path)})
            if sees:
                agent = Agent()
                agent.model = model
                observed = AIAgent._append_guardrail_observation(
                    agent, TOOL, {"path": str(state.path)}, loaded, failed=False
                )
                parts = agent._tool_result_content_for_active_model(TOOL, observed)
                data = next(
                    p["image_url"]["url"] for p in parts if p["type"] == "image_url"
                )
                with Image.open(
                    BytesIO(base64.b64decode(data.split(",", 1)[1]))
                ) as image:
                    assert image.size == (8, 6) and image.convert("RGB").getpixel((
                        0,
                        0,
                    )) == (255, 0, 0)
                assert str(state.path) in parts[0]["text"]
                agent._no_list_tool_content_models = {("custom", model)}
                assert "error" in json.loads(
                    agent._tool_result_content_for_active_model(TOOL, loaded)
                )
                for name in [
                    ANALYZE,
                    "mcp__yuanjing__analyze_image",
                    "mcp__1__analyze_image",
                    "vision_analyze",
                ]:
                    assert "error" in json.loads(
                        native.execute(name, {"image_url_or_oss_path": str(state.path)})
                    )
                assert (len(native.calls), len(native.puts)) == counts
            else:
                assert "error" in json.loads(loaded)
                result = native.execute(
                    ANALYZE, {"image_url_or_oss_path": str(state.path)}
                )
                assert json.loads(result)["result"] == "remote result"
                assert native.calls[-1]["image_url_or_oss_path"].startswith(
                    "app-agent-prod/temp/"
                )
                assert len(native.puts) > counts[1]
            for name in [
                "mcp__other__analyze_image",
                "mcp__UniAI_Toolkit__image_edit",
                "mcp__UniAI_Toolkit__web_search",
            ]:
                args = {"query": "unchanged"}
                assert (
                    json.loads(native.execute(name, args))["result"] == "remote result"
                )
                assert native.calls[-1] == args

    # 实际请求已切换时，不继续沿用轮次起点的runtime模型。
    with native.scope("switch") as state:
        from tools.registry import registry

        def vision_runtime(args, **_):
            """在真实工具分发末端记录原生视觉路由，避免实际调用辅助服务。"""
            from agent.auxiliary_client import _read_main_model
            from tools.vision_tools import _should_use_native_vision_fast_path

            return json.dumps({
                "model": _read_main_model(),
                "native": _should_use_native_vision_fast_path(),
            })

        registry.register(
            name="vision_analyze",
            toolset="vision",
            schema={"name": "vision_analyze"},
            handler=vision_runtime,
            scope=state.manager.scope_key,
        )
        state.module.before_turn(
            session_id="same-session", task_id="same-session", platform="desktop"
        )
        request = {"messages": [{"role": "user", "content": "继续"}]}
        for model, blocked in [("text", False), ("image", True)]:
            assert (
                apply_llm_request_middleware(
                    request,
                    session_id="same-session",
                    platform="desktop",
                    model=model,
                    provider="custom",
                ).payload
                == request
            )
            start = len(native.calls)
            response = json.loads(
                native.execute(
                    ANALYZE, {"image_url_or_oss_path": "https://example.com/a.png"}
                )
            )
            assert ("error" in response) is blocked
            assert len(native.calls) == start + (0 if blocked else 1)
            builtin = json.loads(
                native.execute("vision_analyze", {"image_url": str(state.path)})
            )
            if blocked:
                assert "error" in builtin
            else:
                assert builtin == {"model": model, "native": False}
    for reject in [False, True]:
        with native.scope("wire-reject" if reject else "wire") as state:
            _native_conversation(state, native, monkeypatch, reject=reject)


def _native_conversation(state, native, monkeypatch, *, reject):
    """真实HTTP模型请求、Agent工具循环及SQLite恢复，只有模型回复受控。"""
    from tests.fakes.fake_llm_provider import FakeLLMServer, ToolCall, Text, Error
    from hermes_cli import plugins
    from hermes_state import SessionDB
    from run_agent import AIAgent

    with (
        monkeypatch.context() as patch,
        FakeLLMServer([
            ToolCall(
                "tool_call",
                {
                    "name": ANALYZE,
                    "arguments": {"image_url_or_oss_path": str(state.path)},
                },
            ),
            ToolCall(TOOL, {"path": str(state.path)}),
            *(
                [
                    Error(
                        status=400,
                        message="messages: tool content must be a string, not an array",
                    )
                ]
                if reject
                else []
            ),
            Text("图片没有送达。" if reject else "已分析帧图片。"),
        ]) as server,
    ):
        patch.setattr(plugins, "get_plugin_manager", lambda: state.manager)
        state.manager._discovered = True
        config_file = state.home / "config.yaml"
        config = json.loads(config_file.read_text())
        config["model"].update({
            "provider": "custom",
            "base_url": server.base_url,
            "context_length": 128000,
        })
        config["providers"]["custom"] = config["providers"]["custom:images"]
        config["agent"]["api_max_retries"] = 1
        config_file.write_text(json.dumps(config))
        db = SessionDB(state.home / "state.db")
        count = len(native.calls), len(native.puts)
        agent = AIAgent(
            provider="custom",
            model="image",
            base_url=server.base_url,
            api_key="sk-fake-e2e",
            platform="desktop",
            session_id="wire-session",
            session_db=db,
            enabled_toolsets=["desktop_ui", "native_image_test"],
            quiet_mode=True,
            skip_memory=True,
            skip_context_files=True,
            max_iterations=6,
        )
        try:
            result = agent.run_conversation(
                "分析视频帧 " + str(state.path), task_id="same-session"
            )
            assert result["final_response"] == (
                "图片没有送达。" if reject else "已分析帧图片。"
            )
            requests = server.main_requests()
            assert len(requests) == (4 if reject else 3)
            tools = [m for m in requests[-1]["messages"] if m.get("role") == "tool"]
            assert '"error"' in tools[-2]["content"] and TOOL in tools[-2]["content"]
            parts = tools[-1]["content"]
            if reject:
                assert isinstance(parts, str) and "没有图片部件" in parts
                assert (
                    "图片未交付" in parts and "you can see it natively now" not in parts
                )
            else:
                assert any(
                    p.get("type") == "image_url"
                    and p["image_url"]["url"].startswith("data:image/")
                    for p in parts
                )
            assert not any(
                "data:image/" in json.dumps(r) for r in server.aux_requests()
            )
            assert (len(native.calls), len(native.puts)) == count
            system = [m for m in requests[0]["messages"] if m["role"] == "system"]
            assert all(
                [m for m in r["messages"] if m["role"] == "system"] == system
                for r in requests
            )
            assert requests[0]["tools"] == requests[-1]["tools"]
        finally:
            agent.close()
            db.close()
        reopened = SessionDB(state.home / "state.db")
        try:
            rows = reopened.get_messages("wire-session")
            assert any(
                row["role"] == "tool"
                and str(state.path) in str(row["content"])
                and "只有文字" in str(row["content"])
                for row in rows
            )
        finally:
            reopened.close()


@pytest.mark.parametrize(
    "case",
    [
        "broken",
        "missing",
        "outside",
        "sensitive",
        "url",
        "text-mode",
        "veto",
        "non-desktop",
    ],
)
def test_native_loading_failures_do_not_claim_pixels_or_call_external_vision(
    native, case
):
    """失败不调用远端、不伪装读图；非桌面保持原调用。"""
    with native.scope(
        platform="cli" if case == "non-desktop" else "desktop",
        mode="text" if case == "text-mode" else "auto",
        provider="xiaomi" if case == "veto" else "custom",
    ) as state:
        source = state.path
        if case == "broken":
            source.write_bytes(b"not an image")
        if case == "missing":
            source = source.with_name("missing.png")
        if case == "outside":
            source = state.home.parent / "outside.png"
            source.write_bytes(state.path.read_bytes())
        if case == "sensitive":
            source = state.path.parent / ".ssh" / "key.png"
            source.parent.mkdir()
            source.write_bytes(state.path.read_bytes())
        if case == "url":
            source = "https://example.com/a.png"
        result = native.execute(TOOL, {"path": str(source)})
        assert "error" in json.loads(result)
        assert not native.calls and not native.puts
        result = native.execute(ANALYZE, {"image_url_or_oss_path": str(state.path)})
        if case == "non-desktop":
            assert json.loads(result)["result"] == "remote result"
            assert native.calls and native.puts
        else:
            assert "error" in json.loads(result)
            assert not native.calls and not native.puts
