"""会话头（docs/企业版对接 23 号第 3 节、24 号第 1 节、25 号第 1 节）：发给平台 ``/v1`` 的模型请求带上

- ``X-Uniwork-Session``：这个对话最早的会话号（sessions.py）；
- ``X-Uniwork-Turn``：hermes 给这一轮分的 turn_id，用户发一句话到 agent 答完算一轮，中间的模型调用和工具调用共用。

挂在 ``llm_execution`` 中间件上，它是真正的链式：每一层把请求交给下一层（hermes_cli/middleware.py）。
不用 ``llm_request``：那里每个回调拿到的都是原始请求，最后一个的返回覆盖前面的，fork 自带的插件也注册了它。
头放进请求的 ``extra_headers``，OpenAI SDK 原样发出去。只发给平台：``base_url`` 和 plugin.json 的平台地址同源才加。
起标题、压缩上下文这类辅助调用不经过这个中间件，不带头（24 号第 1 节）。
出任何错都原样交给下一层，对话不受影响。
"""

from __future__ import annotations

import logging

log = logging.getLogger("uniwork_enterprise")

SESSION_HEADER = "X-Uniwork-Session"
TURN_HEADER = "X-Uniwork-Turn"
MAX_HEADER_CHARS = 200  # 平台只存前 200 个字（llm_proxy.py）


def session_headers(source, roots, *, session_id: str, turn_id: str, base_url: str) -> dict[str, str]:
    """这次模型请求要加的头；不该加（插件关着、不是发给平台的、没有会话号）就是空的。"""
    settings = source.settings()
    if not settings.enabled or not session_id or not settings.is_platform(base_url):
        return {}
    out = {SESSION_HEADER: roots.root(session_id)[:MAX_HEADER_CHARS]}
    if turn_id:
        out[TURN_HEADER] = str(turn_id)[:MAX_HEADER_CHARS]
    return out


def make_middleware(source, roots, status=None):
    def uniwork_session_headers(request=None, next_call=None, session_id="", turn_id="", base_url="", **_context):
        outgoing = request
        try:
            if isinstance(request, dict):
                extra = session_headers(source, roots, session_id=str(session_id or ""), turn_id=str(turn_id or ""),
                                        base_url=str(base_url or ""))
                if extra:
                    merged = dict(request.get("extra_headers") or {})
                    merged.update(extra)
                    outgoing = {**request, "extra_headers": merged}
                    if status is not None:
                        status.note_headers()
        except Exception as exc:  # noqa: BLE001
            log.debug("uniwork-enterprise: session headers skipped: %s", type(exc).__name__)
            outgoing = request
        return next_call(outgoing)

    return uniwork_session_headers
