"""后台委派指导覆盖桌面和消息渠道，交付方式按来源区分并冻结。"""

from pathlib import Path

import pytest


@pytest.mark.parametrize("platform,enabled", [
    ("desktop", True), ("weixin", True), ("telegram", True), ("discord", True),
    ("slack", True), ("feishu", True), ("dingtalk", True), ("wecom", True),
    ("qqbot", True), ("signal", True), ("matrix", True), ("email", True),
    ("relay", True), ("irc", True),
    ("subagent", False), ("cli", False), ("tui", False), ("cron", False),
    ("local", False), ("api_server", False), ("webhook", False),
    ("", False), ("unknown-platform", False),
])
def test_background_rules_are_surface_scoped_and_frozen(tmp_path, monkeypatch, platform, enabled):
    """真实发现插件并组装 Agent 提示，重渲染不改变已冻结的委派规则。"""
    from tests.fakes.fake_llm_provider import FakeLLMServer, write_hermes_home

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    with FakeLLMServer() as server:
        write_hermes_home(home, server.base_url, extra_config="plugins:\n  enabled: [uniwork-kits]\n")
        from hermes_cli.plugins import discover_plugins
        from run_agent import AIAgent
        from agent.system_prompt import _frozen_plugin_prompt_sections

        discover_plugins(force=True)
        agent = AIAgent(provider="custom", base_url=server.base_url, api_key="sk-fake-e2e",
                        model="fake-model", platform=platform, enabled_toolsets=["file"],
                        quiet_mode=True, skip_memory=True, skip_context_files=True)
        try:
            sections = _frozen_plugin_prompt_sections(agent)
            selected = [item for item in sections if item.id == "uniwork.background-tasks"]
            assert bool(selected) == enabled
            if selected:
                text = selected[0].content
                assert "doc_translate" in text and "ai_podcast_generate" in text
                assert "delegate_task" in text and "其他 MCP 工具" in text
                if platform == "desktop":
                    assert "宿主在子任务内缓存" in text
                    assert "txt2vid_generate" in text and "img2vid_generate" in text
                else:
                    assert "原消息会话" in text and "不广播" in text
                    assert "MEDIA" in text and "发送附件" in text
                    assert "宿主在子任务内缓存" not in text
                    assert "txt2vid_generate" not in text and "img2vid_generate" not in text
            # 身份之后变化不能让同一会话前缀随之重写。
            agent.platform = "cli" if platform == "desktop" else "desktop"
            assert _frozen_plugin_prompt_sections(agent) == sections
        finally:
            agent.close()
