"""先验证原生输出钩子在真实对话结束、数据库关闭重开后保留交付标记。"""

import pytest

from tests.fakes.fake_llm_provider import (
    FakeLLMServer,
    Text,
    ToolCall,
    write_hermes_home,
)


def test_media_hook_is_persisted_before_conversation_reopens(tmp_path, monkeypatch):
    """仅模型响应受控，真实执行 HTTP、工具、插件发现和 SQLite 写入与重开。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    output = workspace / "报告.md"
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(workspace))
    with FakeLLMServer([
        ToolCall("write_file", {"path": str(output), "content": "# 交付测试"}),
        Text("文件写好了。"),
    ]) as server:
        write_hermes_home(
            home,
            server.base_url,
            extra_config="plugins:\n  enabled: [delivery-proof]\n",
        )
        plugin = home / "plugins/delivery-proof"
        plugin.mkdir(parents=True)
        (plugin / "plugin.yaml").write_text(
            'name: delivery-proof\nversion: "0.1.0"\n', encoding="utf-8"
        )
        (plugin / "__init__.py").write_text(
            'def rewrite(response_text="", **kwargs):\n'
            '    """把本轮真实写出的文件交给原生持久化流程。"""\n'
            f'    return response_text + "\\n\\nMEDIA:" + {str(output)!r}\n'
            "def register(ctx):\n"
            '    """通过正式插件入口安装输出钩子。"""\n'
            '    ctx.register_hook("transform_llm_output", rewrite)\n',
            encoding="utf-8",
        )
        from hermes_cli.plugins import discover_plugins
        from hermes_state import SessionDB
        from run_agent import AIAgent

        discover_plugins(force=True)
        database = SessionDB(home / "state.db")
        agent = AIAgent(
            provider="custom",
            base_url=server.base_url,
            api_key="sk-fake-e2e",
            model="fake-model",
            session_db=database,
            session_id="delivery-proof",
            platform="desktop",
            enabled_toolsets=["file"],
            quiet_mode=True,
            skip_memory=True,
            skip_context_files=True,
        )
        try:
            result = agent.run_conversation("生成交付文件。", task_id="delivery-proof")
            assert output.read_text(encoding="utf-8") == "# 交付测试"
            assert result["final_response"].count("MEDIA:") == 1
            expected = result["final_response"]
        finally:
            agent.close()
            database.close()
        reopened = SessionDB(home / "state.db")
        try:
            replies = [
                row["content"]
                for row in reopened.get_messages("delivery-proof")
                if row["role"] == "assistant" and row["content"]
            ]
            assert replies[-1] == expected
            assert f"MEDIA:{output}" in replies[-1]
        finally:
            reopened.close()


@pytest.mark.parametrize(
    "kind", ["workspace", "desktop", "temp", "terminal", "execute_code"]
)
def test_production_plugin_persists_actual_tool_outputs(tmp_path, kind):
    """真实发现生产插件并运行原版对话，模型只给工具调用和不含路径的结束语。"""
    from tests.plugins.desktop_deliverables_fixture import run_scenario

    receipt = run_scenario(tmp_path, kind)
    assert receipt["text"].count("MEDIA:") == 1
