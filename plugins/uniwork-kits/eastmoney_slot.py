"""9 个东方财富专家改走同事的东方财富连接器（OpenConnector）取数。

数字员工里这 9 个专家的取数走连接器（服务名 ``eastmoney_mcp``，工具 ``execute_action``）；
专家包里仍是跑 ``scripts/get_data.py`` 的旧写法。

同事的实现（desktop ``electron/open-connector``，2026-10 ``hermes-sub`` 分支）：用户在「连接器」页面
授权东方财富后，Electron 在**那个档案**的 ``config.yaml`` 写一条 ``mcp_servers.connector_eastmoney_mcp``：
本机 OpenConnector 的地址（``http://127.0.0.1:<端口>/mcp``）、运行令牌，以及
``X-OpenConnector-Allowed-Services: eastmoney_mcp`` 请求头，并带 ``desktop_connector: eastmoney_mcp``。
每个档案各起一个自己的 OpenConnector，各自授权；档案后端启动前，带 ``desktop_connector`` 标记的条目
会被改写成该档案自己那份的地址和令牌。工具是 ``execute_action``，``actionId`` 用
``eastmoney_mcp.list_tools`` / ``eastmoney_mcp.call_tool``。

用户通常在默认档案（通用助手）里授权。``expert_sync`` 把默认档案那条同步给这 9 个专家时用键名
``MIRROR_NAME``，并去掉 ``desktop_connector``：带着它，专家后端启动时会被改写成专家自己那份还没授权的
连接器；同名还会挡住用户以后在专家档案里自己授权。专家档案里有自己授权的那条时优先用它。

本模块不实现登录，也不写配置。它看当前档案的 ``mcp_servers``，按下面任一条认出东方财富连接器：
``desktop_connector`` 是 ``eastmoney_mcp``；请求头限定的服务是 ``eastmoney_mcp``；键名是约定的几个之一；
地址是妙想 MCP。没有这条记录时什么都不说，专家继续按技能包里的脚本取数；有了，下一轮用户消息就改口：
只用这条连接器，不再跑脚本，也不再碰 ``~/.mx-skills/em_api_key``。说明附在当轮用户消息上，不改系统提示，
已经打开的专家会话不用重开。
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

SERVICE = "eastmoney_mcp"
# 同步到专家档案时用的键名：不能是 connector_eastmoney_mcp，见模块说明。
MIRROR_NAME = "eastmoney_mcp"

# 约定的键名。连接器标记、请求头或地址对得上时，别的键名也能认出来。
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


def owned_by_desktop(entry: Mapping[str, Any]) -> bool:
    """这条是桌面连接器页面为本档案写的东方财富连接（带 desktop_connector 标记）。"""
    return str(entry.get("desktop_connector") or "").strip() == SERVICE


def _service_header(entry: Mapping[str, Any]) -> bool:
    """请求头把这条连接限定在东方财富服务上（OpenConnector 的 X-OpenConnector-Allowed-Services）。"""
    headers = entry.get("headers")
    if not isinstance(headers, Mapping):
        return False
    allowed = next((str(v) for k, v in headers.items() if str(k).lower() == "x-openconnector-allowed-services"), "")
    return SERVICE in {part.strip() for part in allowed.split(",")}


def _url_matches(url: str) -> bool:
    """地址是妙想 MCP，而不是随便提到东方财富的页面。"""
    text = url.lower()
    return "eastmoney.com" in text and ("mxds" in text or "/mcp" in text)


def server_name(servers: Any) -> str:
    """已启用的东方财富连接器在 ``mcp_servers`` 里的键；没有则空字符串。

    同时有好几条时，本档案自己授权的（带 desktop_connector）优先，其次是约定键名或请求头，最后才看地址。
    """
    if not isinstance(servers, Mapping):
        return ""
    ranked = []
    for name, entry in servers.items():
        if not isinstance(entry, Mapping) or _off(entry):
            continue
        key = str(name)
        if owned_by_desktop(entry):
            ranked.append((0, key))
        elif _named(key) or _service_header(entry):
            ranked.append((1, key))
        elif _url_matches(str(entry.get("url") or "")):
            ranked.append((2, key))
    return min(ranked)[1] if ranked else ""


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
        "请到「连接器」页面重新连接东方财富后再问一次。不要自己改连接地址，也不要注册 OAuth 客户端。\n"
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
