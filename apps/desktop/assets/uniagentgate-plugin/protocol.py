# Ported from UniClaw uniwork_release@ce575e5c; original contributor history: SOURCE.md.
"""uniAgentGate WS envelope helpers — build outbound frames, parse inbound ones.

Ported from the Gateway's 接口规范 (「5g消息网关（仅短信）接口规范」§6-7) and
cross-checked against the reference OpenClaw connector's ``protocol.js``.
This module is intentionally dumb: it knows the JSON shapes, not the
socket or the retry/ack bookkeeping (that's :mod:`stream`).  Every
``build_*`` function returns a plain ``dict`` ready for
``json.dumps`` / ``websockets.send``; every ``parse_*`` function takes
an already-``json.loads``-ed ``dict`` and returns ``None`` when the
shape doesn't match, so callers can just skip malformed frames rather
than crash the receive loop.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = "uag.agent.v1"


def message_ref(value: object) -> str:
    """日志仅用摘要关联消息，避免上游标识包含手机号或业务正文。"""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]

# Gateway's default ACK policy (see 接口规范 §7.6); the real values are
# handed to us in ``connection.accepted.payload`` and should be preferred
# once known — these are only the pre-connect fallback.
DEFAULT_ACK_DEADLINE_MS = 3000
DEFAULT_ACK_MAX_RETRIES = 2


def new_message_id(prefix: str) -> str:
    """Build a ``msg_<prefix>_<token>``-shaped id (规范 §7.3)."""
    return f"msg_{prefix}_{secrets.token_urlsafe(12)}"


def now_iso() -> str:
    """ISO 8601 UTC timestamp, matching every envelope's ``timestamp`` field."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Outbound builders (Connector → Gateway) ─────────────────────────────────


def build_ws_heartbeat(*, connection_id: str, agent_id: str) -> dict[str, Any]:
    """``ws.heartbeat`` — keeps ``session.expires_at`` from lapsing (§7.7)."""
    return {
        "protocol_version": PROTOCOL_VERSION,
        "type": "ws.heartbeat",
        "message_id": new_message_id("ws_heartbeat"),
        "timestamp": now_iso(),
        "connection_id": connection_id,
        "agent_id": agent_id,
        "payload": {},
    }


def build_ack(*, in_reply_to: str, ok: bool = True) -> dict[str, Any]:
    """Protocol-layer ``ack`` for a required-ack inbound message (§7.6)."""
    return {
        "protocol_version": PROTOCOL_VERSION,
        "type": "ack",
        "message_id": new_message_id("ack"),
        "timestamp": now_iso(),
        "in_reply_to": in_reply_to,
        "payload": {"ok": ok},
    }


def build_channel_message_send(
    *,
    agent_id: str,
    phone_number: str,
    text: str = "",
    media: list[dict[str, str]] | None = None,
    session_id: str = "",
    turn_id: str = "",
    ack_deadline_ms: int = DEFAULT_ACK_DEADLINE_MS,
) -> dict[str, Any]:
    """方式 A — ``channel.message.send``: ask the Gateway to downlink RCS text/media now (§7.8).

    This is the recommended (and only) downlink path this connector
    uses: one ``agent.request`` may produce zero, one, or many of these,
    and none of the turn-event bookkeeping (response.started /
    output.final / response.completed, §7.5) is required for it.
    """
    payload: dict[str, Any] = {}
    if text:
        payload["text"] = text
    if phone_number:
        payload["phone_number"] = phone_number
    if media:
        payload["media"] = media
    return {
        "protocol_version": PROTOCOL_VERSION,
        "type": "channel.message.send",
        "message_id": new_message_id("cms"),
        "timestamp": now_iso(),
        "agent_id": agent_id,
        "session_id": session_id,
        "turn_id": turn_id,
        "ack": {"mode": "required", "deadline_ms": ack_deadline_ms},
        "channel": {"type": "rcs", "phone_number": phone_number},
        "payload": payload,
    }


# ── Inbound parsing (Gateway → Connector) ───────────────────────────────────


@dataclass
class ConnectionAccepted:
    """Parsed ``connection.accepted`` — the WS handshake's first frame (§6.1)."""

    connection_id: str
    agent_id: str
    heartbeat_interval_sec: int
    ack_deadline_ms: int
    ack_max_retries: int


def parse_connection_accepted(envelope: dict[str, Any]) -> ConnectionAccepted | None:
    if envelope.get("type") != "connection.accepted":
        return None
    payload = envelope.get("payload") or {}
    connection_id = str(envelope.get("connection_id") or "")
    agent_id = str(envelope.get("agent_id") or "")
    if not connection_id or not agent_id:
        return None
    return ConnectionAccepted(
        connection_id=connection_id,
        agent_id=agent_id,
        heartbeat_interval_sec=int(payload.get("heartbeat_interval_sec") or 30),
        ack_deadline_ms=int(payload.get("ack_deadline_ms") or DEFAULT_ACK_DEADLINE_MS),
        ack_max_retries=int(payload.get("ack_max_retries") or DEFAULT_ACK_MAX_RETRIES),
    )


@dataclass
class ConnectionRejected:
    """Parsed ``connection.rejected`` (§6.1) — WS closes right after this."""

    code: str
    message: str


def parse_connection_rejected(envelope: dict[str, Any]) -> ConnectionRejected | None:
    if envelope.get("type") != "connection.rejected":
        return None
    error = (envelope.get("payload") or {}).get("error") or {}
    return ConnectionRejected(
        code=str(error.get("code") or "unknown"),
        message=str(error.get("message") or ""),
    )


def is_connection_replaced(envelope: dict[str, Any]) -> bool:
    """``connection.replaced`` — another connection took over this ``agent_id`` (§6.1)."""
    return envelope.get("type") == "connection.replaced"


@dataclass
class AgentRequestInput:
    """One ``payload.inputs[]`` entry (§7.4)."""

    type: str
    text: str = ""
    url: str = ""


@dataclass
class AgentRequest:
    """Parsed ``agent.request`` — one inbound RCS turn (§7.4).

    Only the fields this connector actually consumes are surfaced;
    ``turn_id`` / ``request_id`` / ``trace_id`` are kept for log
    correlation only, per the spec's own note that RCS 方式 A treats
    them as pass-through / logging fields, not routing state.
    """

    message_id: str
    agent_id: str
    session_id: str
    turn_id: str
    request_id: str
    trace_id: str
    phone_number: str
    ack_required: bool
    inputs: list[AgentRequestInput] = field(default_factory=list)

    @property
    def text(self) -> str:
        for item in self.inputs:
            if item.type == "text" and item.text:
                return item.text
        return ""

    @property
    def file_url(self) -> str:
        for item in self.inputs:
            if item.type == "file_url" and item.url:
                return item.url
        return ""


def parse_agent_request(envelope: dict[str, Any]) -> AgentRequest | None:
    if envelope.get("type") != "agent.request":
        return None
    channel = envelope.get("channel") or {}
    payload = envelope.get("payload") or {}
    raw_inputs = payload.get("inputs") or []
    inputs = [
        AgentRequestInput(
            type=str(item.get("type") or ""),
            text=str(item.get("text") or ""),
            url=str(item.get("url") or ""),
        )
        for item in raw_inputs
        if isinstance(item, dict)
    ]
    ack = envelope.get("ack") or {}
    return AgentRequest(
        message_id=str(envelope.get("message_id") or ""),
        agent_id=str(envelope.get("agent_id") or ""),
        session_id=str(envelope.get("session_id") or ""),
        turn_id=str(envelope.get("turn_id") or ""),
        request_id=str(envelope.get("request_id") or ""),
        trace_id=str(envelope.get("trace_id") or ""),
        phone_number=str(channel.get("phone_number") or channel.get("external_session_id") or ""),
        ack_required=str(ack.get("mode") or "") == "required",
        inputs=inputs,
    )


@dataclass
class AckResult:
    """Parsed ``ack`` — correlates to a message we sent via ``in_reply_to`` (§7.6)."""

    in_reply_to: str
    ok: bool
    error_code: str = ""
    error_message: str = ""
    downlink_msg_ids: list[str] = field(default_factory=list)


def parse_ack(envelope: dict[str, Any]) -> AckResult | None:
    if envelope.get("type") != "ack":
        return None
    in_reply_to = str(envelope.get("in_reply_to") or "")
    if not in_reply_to:
        return None
    payload = envelope.get("payload") or {}
    error = payload.get("error") or {}
    if not isinstance(payload.get("ok", True), bool):
        return None
    return AckResult(
        in_reply_to=in_reply_to,
        ok=bool(payload.get("ok", True)),
        error_code=str(error.get("code") or ""),
        error_message=str(error.get("message") or ""),
        downlink_msg_ids=list(payload.get("downlink_msg_ids") or []),
    )


def monotonic_ms() -> int:
    """Small helper so ``stream.py`` doesn't need a separate ``time`` import."""
    return int(time.monotonic() * 1000)
