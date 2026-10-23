# Ported from UniClaw uniwork_release@ce575e5c; original contributor history: SOURCE.md.
"""uniAgentGate HTTP auth — ``register`` + ``heartbeat`` (接口规范 §5.1-5.2).

Two-layer auth, same shape as the Gateway spec:

1. **Agent identity** — ``agent_sk`` + ``X-Agent-Id`` header, used once at
   :func:`register` to mint a short-lived ``session_token``.
2. **Session** — the ``session_token`` from step 1, used on every
   subsequent HTTP call (:func:`heartbeat`) and on the WS handshake
   (see ``stream.py``).

:func:`validate_credentials` is what the settings UI's "验证凭据" button
calls — it's just :func:`register` with the resulting token discarded,
mirroring ``dingtalk/auth.py::fetch_access_token``.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass

from hermes_cli.version_info import get_version_info

import httpx
from packaging.version import InvalidVersion, Version

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 10.0
CONNECTOR_VERSION = "1.0.0"
DEFAULT_CAPABILITIES = ["text", "image"]


class UniAgentGateAuthError(Exception):
    """Raised when the Gateway rejects credentials or is unreachable.

    Carries an error ``code`` (the Gateway's own ``error.code``, or a
    synthetic ``network_error`` / ``invalid_response``) plus a
    human-readable message safe to surface in the settings UI.
    """

    def __init__(self, code: str, message: str, *, http_status: int | None = None) -> None:
        self.code = code
        self.message = message
        self.http_status = http_status
        super().__init__(f"{code}: {message}")


@dataclass
class RegisteredSession:
    """Result of a successful :func:`register` call (接口规范 §5.1)."""

    agent_id: str
    session_token: str
    ttl_sec: int


def _base_url(gateway_url: str) -> str:
    return gateway_url.rstrip("/")


def _agent_version() -> str:
    version = get_version_info().base_version
    # Migration builds can report 0.0.0; the gateway requires at least 1.0.0.
    minimum = "1.0.0"
    try:
        return version if Version(version or "") >= Version(minimum) else minimum
    except InvalidVersion:
        return minimum


def _request_headers(token: str, agent_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-Agent-Id": agent_id,
        "X-Request-Timestamp": str(int(time.time())),
        "X-Agent-Version": _agent_version(),
        "X-Request-Id": str(uuid.uuid4()),
    }


async def register(
    gateway_url: str,
    agent_id: str,
    agent_sk: str,
    *,
    version: str = CONNECTOR_VERSION,
    capabilities: list[str] | None = None,
) -> RegisteredSession:
    """``POST /v1/agent-runtimes/register`` — exchange ``agent_sk`` for a session token.

    Raises :class:`UniAgentGateAuthError` on any failure (network, bad
    credentials, malformed response) so both the validate route and the
    stream client's register-with-retry loop can handle it uniformly.
    """
    if not gateway_url or not agent_id or not agent_sk:
        raise UniAgentGateAuthError(
            code="missing_credentials",
            message="Gateway 地址、Agent ID、Agent Secret 均不能为空",
        )

    body = {
        "version": version,
        "capabilities": capabilities if capabilities is not None else DEFAULT_CAPABILITIES,
        "endpoint_url": None,
    }
    headers = _request_headers(agent_sk, agent_id)
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{_base_url(gateway_url)}/v1/agent-runtimes/register",
                json=body,
                headers=headers,
            )
    except httpx.TimeoutException as exc:
        raise UniAgentGateAuthError(
            code="network_timeout",
            message=f"连接 5G 网关超时（{REQUEST_TIMEOUT_SECONDS:.0f}s）",
        ) from exc
    except httpx.RequestError as exc:
        raise UniAgentGateAuthError(
            code="network_error",
            message=f"无法连接 5G 网关: {exc.__class__.__name__}",
        ) from exc

    try:
        data = resp.json()
    except ValueError as exc:
        raise UniAgentGateAuthError(
            code="invalid_response",
            message=f"网关返回非 JSON 响应（HTTP {resp.status_code}）",
            http_status=resp.status_code,
        ) from exc

    if not isinstance(data, dict):
        raise UniAgentGateAuthError("invalid_response", "网关返回无效注册响应")

    if resp.status_code >= 400 or not isinstance(data.get("session_token"), str) or not data["session_token"].strip():
        error = data.get("error") if isinstance(data.get("error"), dict) else data
        code = str(error.get("code") or "unknown_error")
        message = str(error.get("message") or "网关拒绝了该凭证")
        raise UniAgentGateAuthError(
            code=code,
            message=_humanize(code, message),
            http_status=resp.status_code,
        )

    session_token = str(data["session_token"])
    try:
        ttl_sec = max(1, int(data.get("ttl_sec") or 60))
    except (ValueError, TypeError) as exc:
        raise UniAgentGateAuthError("invalid_response", "网关返回无效注册期限") from exc
    logger.info("uniAgentGate register ok: ttl_sec=%d", ttl_sec)
    return RegisteredSession(
        agent_id=str(data.get("agent_id") or agent_id),
        session_token=session_token,
        ttl_sec=ttl_sec,
    )


async def heartbeat(
    gateway_url: str,
    session_token: str,
    agent_id: str,
) -> int:
    """``POST /v1/agent-runtimes/heartbeat`` — refresh the session TTL (§5.2).

    HTTP results are diagnostic only. WebSocket heartbeats govern the
    session lifetime; the caller must not re-register because this fails.
    """
    headers = _request_headers(session_token, agent_id)
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{_base_url(gateway_url)}/v1/agent-runtimes/heartbeat",
                json={"agent_id": agent_id},
                headers=headers,
            )
    except httpx.TimeoutException as exc:
        raise UniAgentGateAuthError(code="network_timeout", message="心跳请求超时") from exc
    except httpx.RequestError as exc:
        raise UniAgentGateAuthError(
            code="network_error", message=f"心跳请求失败: {exc.__class__.__name__}",
        ) from exc

    if resp.status_code >= 400:
        try:
            data = resp.json()
            error = data.get("error") if isinstance(data, dict) else {}
            error = error if isinstance(error, dict) else {}
        except ValueError:
            error = {}
        code = str(error.get("code") or ("session_expired" if resp.status_code == 401 else "unknown_error"))
        raise UniAgentGateAuthError(
            code=code,
            message="心跳失败",
            http_status=resp.status_code,
        )

    try:
        data = resp.json()
    except ValueError:
        return 30
    return 30  # HTTP heartbeat is diagnostic; WS owns the cadence.


async def validate_credentials(gateway_url: str, agent_id: str, agent_sk: str) -> None:
    """One-shot credential check for the settings UI's "验证凭据" button.

    Just calls :func:`register` and discards the resulting session —
    the Gateway has no separate "check only" endpoint, and registering
    twice in a row is harmless (§4.5: re-registering the same
    ``agent_id`` simply replaces the previous session).
    """
    await register(gateway_url, agent_id, agent_sk)


def _humanize(code: str, message: str) -> str:
    """Translate common Gateway error codes into friendlier Chinese."""
    lowered = code.lower()
    if lowered == "unauthorized":
        return "Agent ID 或 Agent Secret 不正确"
    if lowered == "session_expired":
        return "会话已过期，请重新注册"
    if "not_found" in lowered:
        return "该 Agent ID 未在网关注册"
    # Gateway-provided text is untrusted and may echo submitted credentials.
    return "网关拒绝了该凭证"
