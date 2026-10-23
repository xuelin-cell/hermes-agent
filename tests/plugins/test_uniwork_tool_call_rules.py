"""元景工具被折叠时，系统提示里带上 tool_call 的用法规则。"""

import pytest

from tests.plugins.test_uniwork_kits_plugin import kits, profile_env  # noqa: F401 - fixtures

UNIAI = "https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=${DESKTOP_MT_MAAS_API_KEY}&client_id=UniWork"


def _config(home, extra=""):
    """写一份接了元景工具箱的默认档案配置。"""
    (home / "config.yaml").write_text(
        f"mcp_servers:\n  UniAI-Toolkit:\n    url: '{UNIAI}'\n    timeout: 1000\n{extra}",
        encoding="utf-8",
    )


@pytest.mark.parametrize("platform", ["desktop", "subagent"])
def test_rules_are_short_and_cover_the_rejected_forms(kits, profile_env, platform):  # noqa: F811
    """主会话和子代理都加：一项一个 tool_call、不包成字符串、看图填 prompt，整段保持简短。"""
    _config(profile_env)
    text = kits.root.tool_call_rules.section({"platform": platform})
    assert "一个 tool_call 只放一项" in text
    assert "不要包成字符串" in text
    assert "analyze_image）必须填 prompt" in text
    assert "get_oss_upload_url" not in text
    assert len(text) < 200


@pytest.mark.parametrize(
    "extra",
    [
        "tools:\n  tool_search:\n    enabled: 'off'\n",
        "tools:\n  tool_search: false\n",
    ],
)
def test_no_rules_when_tool_search_is_off(kits, profile_env, extra):  # noqa: F811
    """Tool Search 关掉时元景工具直接在列表里，不加这段。"""
    _config(profile_env, extra)
    assert kits.root.tool_call_rules.section({"platform": "desktop"}) == ""


def test_no_rules_without_uniai_toolkit(kits, profile_env):  # noqa: F811
    """没接元景工具箱，或工具箱被停用时，不加这段。"""
    assert kits.root.tool_call_rules.section({"platform": "desktop"}) == ""
    (profile_env / "config.yaml").write_text(
        f"mcp_servers:\n  UniAI-Toolkit:\n    url: '{UNIAI}'\n    enabled: false\n", encoding="utf-8"
    )
    assert kits.root.tool_call_rules.section({"platform": "desktop"}) == ""
