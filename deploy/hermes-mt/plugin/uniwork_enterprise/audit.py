"""工具调用记录（docs/企业版对接 14 号第 14 条、24 号第 1 节）：每次工具调用结束记一条，攒批发给
``POST /api/client/tool-calls``。格式和规则照平台的 tool_calls.py、桌面端的 enterprise_audit.py：

- 参数只留摘要：密钥字段打码，内容字段（文件内容、代码……）只记字节数和行数，字符串截短，再过一遍 hermes 的
  ``redact_for_egress``（命令行里夹带的令牌也遮掉）。平台收到后还会按同样的规则再摘一遍。
- 工具的结果不上传，只报字节数。
- ``id`` 由（会话、轮、tool_call_id）算出来，开始时间入队时定下：重发同一条，平台按 id 去重（ON CONFLICT DO NOTHING）。
- ``sessionId`` / ``turnId`` 和会话头取自同一处（sessions.py、hermes 的 turn_id），平台能把工具调用和模型调用对上。

挂在 ``post_tool_call`` 上：只观察，回调出错不影响工具。不用 ``pre_tool_call``：它出错或超时会把工具拦下。
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

log = logging.getLogger("uniwork_enterprise")

# 只是查工具目录（Tool Search 的桥），不是在用工具；tool_call 那个桥 hermes 会拆开，按真正的工具各记一次
SKIP_TOOLS = frozenset({"tool_search", "tool_describe"})
SECRET_KEY_RE = re.compile(r"pass(word)?|token|secret|key|authorization|cookie|credential", re.I)
# 平台的 CONTENT_FIELDS，加上 hermes 工具里放正文的参数（execute_code 的 code、write_file 的 content……）
CONTENT_FIELDS = frozenset({"content", "new_string", "old_string", "new_source", "file_text", "text", "data", "body",
                            "code", "script", "patch", "diff", "new_text", "old_text"})
TARGET_FIELDS = ("path", "file_path", "notebook_path", "command", "url", "urls", "image_url", "query", "pattern",
                 "skill", "name", "goal", "subagent_type", "description")
NAMESPACE = uuid.UUID("5f3c6b1e-0e5b-4d8e-9d55-7b3f2a1c9e10")
USER_DENIED = "BLOCKED: User denied"


def _redact(text: str) -> str:
    try:
        from agent.redact import redact_for_egress
    except Exception:  # noqa: BLE001 —— 测试环境没有 hermes：按原样（平台还会再摘一遍）
        return text
    return redact_for_egress(text)


def _strip_url(url: str) -> str:
    """URL 去掉账号密码和片段，查询参数里像密钥的值打码（平台的 _strip_url）。"""
    try:
        parts = urlsplit(url)
        query = urlencode([(k, "***" if SECRET_KEY_RE.search(k) else v) for k, v in parse_qsl(parts.query)])
        netloc = (parts.hostname or "") + (f":{parts.port}" if parts.port else "")
    except ValueError:
        return url[:300]
    return urlunsplit((parts.scheme, netloc, parts.path, query, ""))[:300]


def _text(value: str, limit: int) -> str:
    value = _redact(value)
    return _strip_url(value) if value.startswith(("http://", "https://")) else value[:limit]


def summarize(value: Any, depth: int = 0) -> Any:
    """参数的形状，不带正文和密钥（平台的 summarize_args）。"""
    if depth > 3:
        return "…"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in list(value.items())[:30]:
            key = str(key)[:60]
            if SECRET_KEY_RE.search(key):
                out[key] = "***"
            elif key in CONTENT_FIELDS and isinstance(item, str):
                out[key] = {"bytes": len(item.encode("utf-8", "replace")), "lines": item.count("\n") + 1}
            else:
                out[key] = summarize(item, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [summarize(v, depth + 1) for v in list(value)[:20]]
    if isinstance(value, str):
        return _text(value, 200)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _text(str(value), 200)


def target_of(args: Any) -> str:
    """一眼看出这次调用干了什么的那个参数：路径、命令、URL、查询词……"""
    if not isinstance(args, dict):
        return ""
    for field in TARGET_FIELDS:
        value = args.get(field)
        if isinstance(value, (list, tuple)):
            value = next((v for v in value if isinstance(v, str) and v), "")
        if isinstance(value, str) and value:
            return _text(value, 500)
    return ""


def kind_of(tool: str) -> tuple[str, str]:
    """(kind, MCP 服务名)。hermes 的 MCP 工具名是 ``mcp__<服务>__<工具>``（服务名里的 - 换成了 _）。"""
    if tool.startswith(("mcp__", "connectors__")):
        parts = tool.split("__")
        return "mcp", parts[1] if len(parts) > 2 else ""
    if tool == "delegate_task":
        return "subagent", ""
    if tool == "skill_view":
        return "skill", ""
    return "builtin", ""


def _result_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(result)


def outcome(status: str, error_message: str, result_text: str) -> str:
    """平台的 result：ok / error / denied_policy（规则、策略拦下）/ denied_user（员工在确认框里拒绝）/ cancelled。"""
    status = str(status or "ok")
    head = f"{error_message or ''}\n{result_text[:500]}"
    if USER_DENIED in head:
        return "denied_user"
    if status == "blocked" or "BLOCKED:" in head:
        return "denied_policy"
    if status in ("cancelled", "interrupted"):
        return "cancelled"
    return "ok" if status == "ok" else "error"


def _exit_code(tool: str, result_text: str) -> int | None:
    if tool != "terminal" or not result_text.startswith("{"):
        return None
    try:
        value = json.loads(result_text).get("exit_code")
    except (ValueError, AttributeError):
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def item(*, tool_name: str, args: Any, result: Any, session: str, turn_id: str, tool_call_id: str = "",
         duration_ms: int = 0, status: str = "ok", error_message: str = "", now: datetime | None = None) -> dict | None:
    """一次工具调用 → 平台的一条记录；不用记的（查工具目录的桥、没有工具名）回 None。"""
    tool = str(tool_name or "")
    if not tool or tool in SKIP_TOOLS:
        return None
    text = _result_text(result)
    duration_ms = max(0, int(duration_ms or 0))
    started = (now or datetime.now(timezone.utc)) - timedelta(milliseconds=duration_ms)
    kind, server = kind_of(tool)
    result_kind = outcome(status, error_message, text)
    if tool_call_id:
        ident = str(uuid.uuid5(NAMESPACE, f"{session}\n{turn_id}\n{tool_call_id}\n{tool}"))
    else:
        ident = str(uuid.uuid4())
    entry = {
        "id": ident, "sessionId": str(session)[:128], "turnId": str(turn_id or "")[:128], "mode": "office",
        "tool": tool[:120], "kind": kind, "mcpServer": server[:120], "target": target_of(args),
        "args": summarize(args if isinstance(args, dict) else {}), "result": result_kind,
        "durationMs": duration_ms, "resultBytes": len(text.encode("utf-8", "replace")),
        "startedAt": started.isoformat(),
    }
    if result_kind != "ok":
        error = str(error_message or text).strip().split("\n")[0]
        entry["error"] = _redact(error)[:200]
    code = _exit_code(tool, text)
    if code is not None:
        entry["exitCode"] = code
    return entry


def make_hook(source, roots, outbox):
    """``post_tool_call`` 回调：只在插件开着、平台要工具调用记录（toolAudit）时入队。出错只记日志。"""

    def uniwork_tool_audit(tool_name="", args=None, result=None, session_id="", turn_id="", tool_call_id="",
                           duration_ms=0, status=None, error_message=None, **_kwargs):
        try:
            settings = source.settings()
            if not settings.enabled or not settings.tool_audit or not session_id:
                return None
            entry = item(tool_name=tool_name, args=args, result=result, session=roots.root(str(session_id)),
                         turn_id=str(turn_id or ""), tool_call_id=str(tool_call_id or ""), duration_ms=duration_ms,
                         status=str(status or "ok"), error_message=str(error_message or ""))
            if entry is not None:
                outbox.put(entry)
        except Exception as exc:  # noqa: BLE001
            log.debug("uniwork-enterprise: tool audit skipped: %s", type(exc).__name__)
        return None

    return uniwork_tool_audit
