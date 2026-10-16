"""东方财富连接器还没接上时留下的缺口。

数字员工里这 9 个专家的取数走同事的连接器（服务名 ``eastmoney_mcp``），
工具是 ``execute_action``。Hermes 这边那个连接器还没放进来，专家包里仍是
跑 ``scripts/get_data.py`` 的旧写法。

本模块不实现登录，也不往配置里写 MCP。它只看当前 profile 的
``mcp_servers``：键名是 ``eastmoney_mcp``、``connector_eastmoney_mcp``、
``connector-eastmoney-mcp``，或者地址里同时有 ``eastmoney.com`` 和
``mcp`` / ``mxds``。没有这条记录时什么都不说，专家继续按技能包里的脚本取数。
记录一出现，下一轮用户消息就改口：只用这条连接器，不再跑脚本，也不再碰
``~/.mx-skills/em_api_key``。

说明附在当轮用户消息上，不改系统提示，所以已经打开的专家会话不用重开。
同事把连接器写进默认配置档案后，``expert_sync`` 会把它同步到这 9 个专家
自己的 profile。工具形态要和数字员工一致：一个 ``execute_action``，
``actionId`` 用 ``eastmoney_mcp.list_tools`` 再 ``eastmoney_mcp.call_tool``。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from . import media_slot, store

# 数字员工 EASTMONEY_EXPERTS 里 Hermes 已装的 9 个，加上同属这条连接器、
# 尚未装进来的 3 个，避免以后装上了却对不上缺口。
EXPERTS = frozenset({
    "fund-diagnostician",
    "fund-portfolio-analyzer",
    "fund-research-expert",
    "fund-selector",
    "industry-research-expert",
    "mx-industry-cycle-analyst",
    "mx-industry-deep-research",
    "mx-market-intelligence",
    "smart-stock-selection-expert",
    "stock-deep-research-expert",
    "stock-diagnosis-expert",
    "stock-research-expert",
})

# 同事接入时优先用这些键名。地址对得上时，别的键名也能认出来。
SERVER_NAMES = frozenset({
    "eastmoney_mcp",
    "connector_eastmoney_mcp",
    "connector-eastmoney-mcp",
})


def _off(entry: Mapping[str, Any]) -> bool:
    """这条 MCP 被关掉了。"""
    return entry.get("enabled") is False or str(entry.get("enabled")).strip().lower() in {"false", "0", "no", "off"}


def _named(key: str) -> bool:
    """键名是约定的东方财富连接器名字（横线和下划线视为同一种）。"""
    folded = key.replace("-", "_")
    return key in SERVER_NAMES or folded in {name.replace("-", "_") for name in SERVER_NAMES}


def _url_matches(url: str) -> bool:
    """地址是妙想 MCP，而不是随便提到东方财富的页面。"""
    text = url.lower()
    return "eastmoney.com" in text and ("mxds" in text or "/mcp" in text)


def server_name(servers: Any) -> str:
    """已启用的东方财富连接器在 ``mcp_servers`` 里的键；没有则空字符串。"""
    if not isinstance(servers, Mapping):
        return ""
    by_url = ""
    for name, entry in servers.items():
        if not isinstance(entry, Mapping) or _off(entry):
            continue
        key = str(name)
        if _named(key):
            return key
        if not by_url and _url_matches(str(entry.get("url") or "")):
            by_url = key
    return by_url


def data_note(server: str) -> str:
    """连接器已在配置里时，告诉模型改走它、停用专家包里的脚本和钥匙。"""
    tool = media_slot.mcp_tool(server, "execute_action")
    return (
        "本轮取数用东方财富连接器，这条说明优先于专家包里的脚本和「同类数据 MCP」。\n"
        f"- 工具全名是 `{tool}`。先 `tool_search` 这个全名，再 `tool_describe`、`tool_call`。"
        "先用 `actionId` `eastmoney_mcp.list_tools` 看当前工具，再用 `actionId` `eastmoney_mcp.call_tool`。"
        "一次只发一条 `call_tool`，等它返回再发下一条。"
        "`input.toolName` 必须是刚才返回的名字（如 `mx_ashare_finance_data`、`mx_fund_finance_data`、"
        "`mx_finance_search_news`、`mx_macro_data`、`mx_stocks_screener`），"
        "`input.arguments` 只填该工具 schema 里有的字段。对不上就不调用。\n"
        "- 不要运行专家包里的 `python3 scripts/get_data.py`，不要调用 `mx_get_user_api_key`，"
        "不要读写 `~/.mx-skills/em_api_key`。同花顺 iFinD 以及其他金融连接器即使已经连接，也不要调用。\n"
        "- 某一字段返回 `invalid_input`、`rate_limited`，或结果被截断、明显缺段时，"
        "把该字段标「材料未提供」，用已经拿到的数据继续写。不要换参数重查，也不要改走脚本。\n"
        "- 工具列表里没有这个全名、调用超时或返回未登录 / 401 时，告诉用户东方财富连接器这一轮还不能用，"
        "请稍后再发一次同一个问题。不要自己改妙想地址，也不要注册 OAuth 客户端。\n"
    )


def turn_note(home: Path) -> str:
    """当前档案是东财专家且已写上连接器时返回取数说明，否则空字符串。"""
    found = store.self_expert(store.load_index(home))
    if not found or found[0] not in EXPERTS:
        return ""
    try:
        from hermes_cli.config import load_config_readonly

        cfg = load_config_readonly() or {}
    except Exception:
        return ""
    servers = cfg.get("mcp_servers") if isinstance(cfg, Mapping) else None
    name = server_name(servers)
    return data_note(name) if name else ""
