"""Public plugin notices carry identity only; result reads use native session authorization."""

import time
from hermes_cli.plugin_events import broadcast_plugin_event
from hermes_constants import get_hermes_home, get_default_hermes_root

OWNED = {"web_search": {"unisearch"}, "web_extract": {"builtin_parse", "unicrawl"}}


# 在已绑定的会话Profile中补默认设置，不改写原生开关。
def setup(**kwargs):
    from .configure import apply

    apply(None)


# 通知只携带调用身份，结果正文沿原生授权接口读取。
def notice(
    phase, *, tool_name, session_id=None, tool_call_id=None, turn_id=None, **kwargs
):
    if tool_name not in OWNED:
        return
    from agent.web_search_registry import (
        get_active_search_provider,
        get_active_extract_provider,
    )

    provider = (
        get_active_search_provider
        if tool_name == "web_search"
        else get_active_extract_provider
    )()
    if (
        provider is None
        or provider.name not in OWNED[tool_name]
        or not session_id
        or not tool_call_id
    ):
        return
    home = get_hermes_home()
    root = get_default_hermes_root(home=home)
    profile = home.name if home.parent == root / "profiles" else "default"
    broadcast_plugin_event(
        "unisearch",
        "tool." + phase,
        {
            "session_id": session_id,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "profile": profile,
            "provider": provider.name,
            "turn_id": turn_id,
            "timestamp": time.time(),
        },
    )


# 抓取结果在产品边缘保留实际后端身份，复用原生持久化。
def label_extract_result(*, tool_name, result, **kwargs):
    """Native web_extract trims per-page metadata; preserve the executing backend at the edge."""
    if tool_name != "web_extract" or not isinstance(result, str):
        return None
    import json

    try:
        body = json.loads(result)
    except (ValueError, TypeError):
        return None
    from agent.web_search_registry import get_active_extract_provider

    provider = get_active_extract_provider()
    if (
        provider is None
        or provider.name not in OWNED["web_extract"]
        or not isinstance(body, dict)
    ):
        return None
    rows = body.get("results")
    if (
        not isinstance(rows, list)
        or not rows
        or all(str(row.get("error", "")).startswith("Blocked:") for row in rows)
    ):
        return None
    return json.dumps(
        {
            **body,
            "provider": provider.name,
            "provider_display_name": provider.display_name,
        },
        ensure_ascii=False,
    )
