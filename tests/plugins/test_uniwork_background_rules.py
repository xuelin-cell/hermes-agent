"""生产插件的新会话指导按桌面来源生效，并由原生系统提示快照冻结。"""

from pathlib import Path

import pytest


@pytest.mark.parametrize("platform", ["desktop", "subagent", "cli"])
def test_background_rules_are_surface_scoped_and_frozen(tmp_path, monkeypatch, platform):
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
            assert bool(selected) == (platform == "desktop")
            # 身份之后变化不能让同一会话前缀随之重写。
            agent.platform = "cli" if platform == "desktop" else "desktop"
            assert _frozen_plugin_prompt_sections(agent) == sections
        finally:
            agent.close()
