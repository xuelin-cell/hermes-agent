"""Tool-contract baseline rule definitions."""

from .core import ask_rule, terminal_rule
from ..signals import RiskCategory as C

MISSING_COMMAND = terminal_rule("common.tool.missing_command", C.TOOL_CONTRACT, "工具调用缺少命令参数")
MISSING_PATH = terminal_rule("common.tool.missing_path", C.TOOL_CONTRACT, "工具调用缺少路径参数")
MISSING_URL = terminal_rule("common.tool.missing_url", C.TOOL_CONTRACT, "工具调用缺少 URL 参数")
MISSING_QUERY = terminal_rule("common.tool.missing_query", C.TOOL_CONTRACT, "工具调用缺少查询参数")
UNKNOWN_EXEC_FIELD = terminal_rule("common.tool.unknown_exec_field", C.TOOL_CONTRACT, "未知工具携带类似执行命令的参数")
CONFLICTING_DOMAIN_FILTERS = terminal_rule(
    "common.tool.conflicting_domain_filters",
    C.TOOL_CONTRACT,
    "WebSearch 不能同时指定 allowed_domains 和 blocked_domains",
)
PUBLIC_PUBLISH = ask_rule(
    "common.tool.public_publish",
    C.DATA_EXFILTRATION,
    "将本地内容发布或更新到公网",
)

TERMINAL_RULES = (
    MISSING_COMMAND,
    MISSING_PATH,
    MISSING_URL,
    MISSING_QUERY,
    UNKNOWN_EXEC_FIELD,
    CONFLICTING_DOMAIN_FILTERS,
)
ASK_RULES = (PUBLIC_PUBLISH,)
RULES = (*TERMINAL_RULES, *ASK_RULES)
