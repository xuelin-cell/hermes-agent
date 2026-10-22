"""元景工具被 Tool Search 折叠时，用一段短规则教模型按 tool_call 的格式调用，减少调用被退回。

日志里被退回的三类写法：一个 tool_call 塞多项、calls 写成坏掉的字符串、看图漏填 prompt。
"""

from typing import Any, Mapping

from . import media_slot

RULES = (
    "元景工具箱等 MCP 工具不在工具列表里时，用 tool_call 调用：一个 tool_call 只放一项，"
    "要调用多次就发多个 tool_call；calls 写成数组、arguments 写成对象，不要包成字符串。"
    "看图（analyze_image）必须填 prompt；其他工具的必填参数不确定时，先用 tool_describe 查。"
)


def _folded(config: Mapping[str, Any]) -> bool:
    """Tool Search 是否开着：关掉时 MCP 工具直接在列表里，不需要这段规则。"""
    tools = config.get("tools") if isinstance(config.get("tools"), Mapping) else {}
    raw = tools.get("tool_search")
    try:
        from tools.tool_search import ToolSearchConfig

        return ToolSearchConfig.from_raw(raw).enabled != "off"
    except Exception:
        if raw is False:
            return False
        return not (isinstance(raw, Mapping) and str(raw.get("enabled")).strip().lower() == "off")


def section(session_info):
    """新会话加载：接了元景工具箱且工具被折叠时才加，子代理也加（后台任务在子代理里调用元景）。"""
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
    except Exception:
        return ""
    if not media_slot.uniai_server(config.get("mcp_servers")) or not _folded(config):
        return ""
    return RULES
