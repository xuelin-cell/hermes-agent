# Ported from UniClaw uniwork_release@ce575e5c; original contributor history: SOURCE.md.
"""uniAgentGate WS client — register + heartbeat + long-connected RCS channel.

Mirrors :class:`~hexagent_api.channels.wecom.stream.WeComStreamClient`'s
shape (``start`` / ``stop`` / ``is_alive`` / ``health`` / an
``on_message(raw, context)`` callback) so :mod:`channels.runtime` can
treat this channel like any other. The wire protocol itself — register,
heartbeat, WS handshake, ``agent.request`` / ``ack`` / ``ws.heartbeat``
/ ``channel.message.send`` — follows the Gateway's 接口规范 (see
``protocol.py`` for the envelope shapes) and the reference OpenClaw
connector this was ported from.

Lifecycle, high level::

    register (HTTP, agent_sk)              → session_token
      │
      ├─ HTTP heartbeat loop (compatibility only; responses and failures
      │  do not control session lifetime or WebSocket reconnection)
      │
      └─ WS connect loop (reconnect with backoff on transient drops;
         re-register on session_expired (4004); stand down without
         reconnecting on connection_replaced (4003) or a hard reject)

Only 方式 A (``channel.message.send``, 接口规范 §7.1.1) is implemented —
the recommended, non-streaming downlink path for RCS. This connector
never sends ``response.started`` / ``output.final`` /
``response.completed`` (方式 B); the Gateway's 30s turn-collection
timeout for 方式 B therefore doesn't apply here.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import random
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from .health import ChannelHealth
from . import auth, protocol

logger = logging.getLogger(__name__)


HTTP_HEARTBEAT_INTERVAL_SEC = 20.0
CONNECT_RETRY_MIN_SEC = 1.0
CONNECT_RETRY_MAX_SEC = 30.0
MAX_REGISTER_SERVER_ERROR_RETRIES = 3
MAX_AUTH_RECOVERY_ROUNDS = 3
DEDUPE_TTL_SECONDS = 300.0
DEDUPE_MAX_ENTRIES = 512
# How long to wait for the Gateway's business ACK on an outbound
# channel.message.send before giving up. Comfortably above the spec's
# own ack_deadline_ms (3000ms) so a single Gateway-side retry still
# lands before we time out client-side.
ACK_WAIT_SECONDS = 8.0
WS_OPEN_TIMEOUT_SECONDS = 15.0
FIRST_FRAME_TIMEOUT_SECONDS = 15.0

RawUniAgentGateMessage = dict[str, Any]


class UniAgentGateInboundContext:
    """Handle passed to the runtime alongside the normalised inbound dict.

    Bundles a reference back to the owning stream client (so the reply
    path can call :meth:`UniAgentGateStreamClient.send_channel_message`
    on the same live WS session) with the routing fields the reply
    needs. Mirrors :class:`WeComInboundContext` / :class:`FeishuInboundContext`.
    """

    __slots__ = ("client", "phone_number", "session_id", "turn_id", "request_id")

    def __init__(
        self,
        client: "UniAgentGateStreamClient",
        *,
        phone_number: str,
        session_id: str,
        turn_id: str,
        request_id: str,
    ) -> None:
        self.client = client
        self.phone_number = phone_number
        self.session_id = session_id
        self.turn_id = turn_id
        self.request_id = request_id


StreamCallback = Callable[[RawUniAgentGateMessage, UniAgentGateInboundContext], Awaitable[None]]


class UniAgentGateStreamClient:
    """One Gateway registration + WS session for a given ``agent_id``.

    Usage mirrors every other channel's stream client::

        stream = UniAgentGateStreamClient(gateway_url, agent_id, agent_sk, on_message)
        await stream.start()
        ...
        await stream.stop()
    """

    def __init__(
        self,
        gateway_url: str,
        agent_id: str,
        agent_sk: str,
        on_message: StreamCallback,
    ) -> None:
        self._gateway_url = gateway_url.rstrip("/")
        self._agent_id = agent_id
        self._agent_sk = agent_sk
        self._on_message = on_message

        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self._ws: Any | None = None
        self._session_token: str | None = None
        self._needs_reregister = False

        self._pending_acks: dict[str, "asyncio.Future[protocol.AckResult]"] = {}
        self._seen_message_ids: OrderedDict[str, float] = OrderedDict()

        self.health = ChannelHealth()
        self.ready = asyncio.Event()
        self._dispatch_tasks: set[asyncio.Task] = set()

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def is_alive(self) -> bool:
        return self._task is not None and not self._task.done()

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Spawn the register→connect→reconnect loop and return immediately."""
        if self._task is not None:
            return
        self._stopping = False
        self.health.mark_starting()
        self._task = asyncio.create_task(
            self._run(), name="uniagentgate-runtime",
        )
        logger.info("UniAgentGateStreamClient started")

    async def stop(self) -> None:
        """Close the WS (if any), cancel background tasks, mark stopped."""
        if self._task is None:
            return
        self._stopping = True
        task = self._task
        self._task = None

        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close(code=1000, reason="runtime_stop")

        for fut in list(self._pending_acks.values()):
            if not fut.done():
                fut.cancel()
        self._pending_acks.clear()

        dispatches = list(self._dispatch_tasks)
        for dispatch in dispatches:
            dispatch.cancel()
        await asyncio.gather(*dispatches, return_exceptions=True)
        self._dispatch_tasks.clear()

        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

        self.health.mark_stopped()
        logger.info("UniAgentGateStreamClient stopped: reason=runtime_stop (shutdown or configuration reload)")

    # ── Main loop: register, then connect-with-reconnect until told to stop ──

    async def _run(self) -> None:
        attempt = 0
        auth_recovery_rounds = 0
        while not self._stopping:
            registration = await self._register_with_retry()
            if registration is None:
                if not self._stopping:
                    self.health.mark_failed(
                        "uniAgentGate 注册失败，请检查 Gateway 地址 / Agent ID / Agent Secret",
                    )
                    logger.warning("uniAgentGate stopped: reason=registration_failed; automatic retry stopped")
                return

            self._session_token = registration.session_token
            self._needs_reregister = False
            hb_task = asyncio.create_task(
                self._http_heartbeat_loop(registration.ttl_sec),
                name="uniagentgate-heartbeat",
            )
            stand_down = False
            try:
                while not self._stopping and not self._needs_reregister:
                    outcome, was_accepted = await self._connect_once()
                    if self._stopping:
                        break
                    if was_accepted:
                        auth_recovery_rounds = 0
                    if outcome in {"auth_unauthorized", "auth_session_expired"}:
                        code = outcome.removeprefix("auth_")
                        if auth_recovery_rounds >= MAX_AUTH_RECOVERY_ROUNDS:
                            self.health.mark_failed(
                                f"5G 网关鉴权失败（{code}），自动重新注册 {MAX_AUTH_RECOVERY_ROUNDS} 轮后仍被拒绝，请手动重试",
                            )
                            logger.warning(
                                "uniAgentGate auth recovery exhausted: code=%s rounds=%d",
                                code, auth_recovery_rounds,
                            )
                            stand_down = True
                            break
                        auth_recovery_rounds += 1
                        self.health.mark_degraded(
                            f"5G 网关会话鉴权失败，正在重新注册（{auth_recovery_rounds}/{MAX_AUTH_RECOVERY_ROUNDS}）",
                        )
                        logger.warning(
                            "uniAgentGate auth recovery: code=%s round=%d/%d; registering a fresh session",
                            code, auth_recovery_rounds, MAX_AUTH_RECOVERY_ROUNDS,
                        )
                        self._needs_reregister = True
                        break
                    if outcome == "replaced":
                        stand_down = True
                        break
                    if outcome == "session_expired":
                        self._needs_reregister = True
                        break
                    if outcome == "rejected":
                        self.health.mark_failed(
                            "uniAgentGate 连接被拒绝，请检查协议版本或凭据配置",
                        )
                        stand_down = True
                        break
                    # Transient drop ("closed" / "error") — retry the same
                    # session with backoff. A connection that was accepted
                    # (even briefly) resets the backoff counter.
                    attempt = 0 if was_accepted else attempt + 1
                    delay = _backoff_delay(attempt)
                    logger.warning(
                        "uniAgentGate disconnected: reason=%s accepted=%s; retry in %.1fs",
                        outcome, was_accepted, delay,
                    )
                    self.health.mark_degraded(
                        f"WebSocket 已断开，{delay:.1f}s 后重连",
                    )
                    await asyncio.sleep(delay)
            finally:
                hb_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await hb_task

            if self._stopping:
                return
            if stand_down:
                # Either a hard reject or another connector took over this
                # agent_id (§6.1 connection.replaced) — don't fight it.
                if outcome == "replaced":
                    self.health.mark_stopped()
                    self.health.last_error = "连接被其他客户端接管，已停止自动重连"
                logger.warning(
                    "uniAgentGate stopped: reason=%s (%s); automatic retry stopped",
                    outcome,
                    "another client took over" if outcome == "replaced" else "gateway rejected connection",
                )
                return
            # Expired session or recoverable auth rejection: register afresh.

    async def _register_with_retry(self) -> auth.RegisteredSession | None:
        server_error_attempts = 0
        while not self._stopping:
            try:
                return await auth.register(self._gateway_url, self._agent_id, self._agent_sk)
            except auth.UniAgentGateAuthError as exc:
                logger.warning(
                    "uniAgentGate register failed: code=%s status=%s",
                    exc.code, exc.http_status,
                )
                if exc.http_status is not None and 400 <= exc.http_status < 500:
                    return None
                server_error_attempts += 1
                if server_error_attempts >= MAX_REGISTER_SERVER_ERROR_RETRIES:
                    return None
                await asyncio.sleep(1.0 * server_error_attempts)
        return None

    async def _http_heartbeat_loop(self, ttl_sec: int) -> None:
        """Send compatibility HTTP heartbeats without controlling the connection.

        The gateway uses WebSocket heartbeats as the authority. HTTP errors
        (including unauthorized/session_expired) are diagnostic only; even a
        successful response must not change connection state or cadence.
        """
        interval = max(1.0, min(HTTP_HEARTBEAT_INTERVAL_SEC, ttl_sec / 2))
        failures = 0
        assert self._session_token is not None
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    await auth.heartbeat(
                        self._gateway_url, self._session_token, self._agent_id,
                    )
                    failures = 0
                except auth.UniAgentGateAuthError as exc:
                    failures += 1
                    logger.warning(
                        "uniAgentGate HTTP heartbeat failed (%d): code=%s; diagnostic only, WebSocket unchanged",
                        failures, exc.code,
                    )
        except asyncio.CancelledError:
            raise

    # ── One WS connection attempt ────────────────────────────────────────────

    async def _connect_once(self) -> tuple[str, bool]:
        """Connect, serve until closed, return ``(outcome, was_accepted)``.

        ``outcome`` is one of ``"replaced"``, ``"session_expired"``,
        ``"auth_unauthorized"``, ``"auth_session_expired"`` (register afresh),
        ``"rejected"``, ``"closed"`` (transient — caller should retry),
        or ``"error"`` (handshake/network failure before we even got a
        first frame).
        """
        headers = {
            "Authorization": f"Bearer {self._session_token}",
            "X-Agent-Id": self._agent_id,
            "X-UAG-Protocol-Version": protocol.PROTOCOL_VERSION,
        }
        was_accepted = False
        try:
            async with websockets.connect(
                self._ws_url(),
                additional_headers=headers,
                open_timeout=WS_OPEN_TIMEOUT_SECONDS,
            ) as ws:
                self._ws = ws
                try:
                    first_raw = await asyncio.wait_for(
                        ws.recv(), timeout=FIRST_FRAME_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "uniAgentGate no first frame within %.0fs",
                        FIRST_FRAME_TIMEOUT_SECONDS,
                    )
                    return "error", False

                first = _safe_json_loads(first_raw)
                if first is None:
                    logger.warning("uniAgentGate handshake failed: reason=invalid_first_frame_json")
                    return "error", False

                rejected = protocol.parse_connection_rejected(first)
                if rejected is not None:
                    logger.warning("uniAgentGate connection rejected: code=%s", rejected.code)
                    if rejected.code in {"unauthorized", "session_expired"}:
                        return f"auth_{rejected.code}", False
                    return "rejected", False

                try:
                    accepted = protocol.parse_connection_accepted(first)
                except (ValueError, TypeError, AttributeError):
                    return "error", False
                if accepted is None:
                    logger.warning(
                        "uniAgentGate unexpected first frame type=%s", first.get("type"),
                    )
                    return "error", False

                was_accepted = True
                if accepted.agent_id != self._agent_id:
                    return "rejected", False
                self.health.mark_running()
                self.ready.set()
                logger.info("uniAgentGate connected")

                ws_hb_task = asyncio.create_task(
                    self._ws_heartbeat_loop(ws, accepted.connection_id, accepted.heartbeat_interval_sec),
                    name="uniagentgate-ws-heartbeat",
                )
                try:
                    async for raw in ws:
                        try:
                            await self._handle_frame(ws, raw)
                        except (ValueError, TypeError, AttributeError):
                            logger.warning("uniAgentGate malformed frame ignored")
                finally:
                    ws_hb_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await ws_hb_task
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd is not None else 0
            logger.info(
                "uniAgentGate ws closed: code=%s reason=%s",
                code,
                {4003: "connection_replaced", 4004: "session_expired"}.get(code, "websocket_closed"),
            )
            if code == 4003:
                return "replaced", was_accepted
            if code == 4004:
                return "session_expired", was_accepted
            return "closed", was_accepted
        except (OSError, InvalidHandshake, asyncio.TimeoutError) as exc:
            logger.warning("uniAgentGate connect failed: error_type=%s", type(exc).__name__)
            return "error", was_accepted
        finally:
            self._ws = None
            for future in list(self._pending_acks.values()):
                if not future.done():
                    future.set_exception(RuntimeError("5G 连接中断，下发结果未知"))
            self._pending_acks.clear()
        logger.info("uniAgentGate ws closed normally: code=%s", ws.close_code)
        return "closed", was_accepted

    async def _ws_heartbeat_loop(self, ws: Any, connection_id: str, interval_sec: int) -> None:
        try:
            while True:
                await asyncio.sleep(max(1, interval_sec))
                await self._safe_send(
                    ws, protocol.build_ws_heartbeat(connection_id=connection_id, agent_id=self._agent_id),
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("uniAgentGate ws heartbeat send failed (connection likely closing)")

    async def _handle_frame(self, ws: Any, raw: str | bytes) -> None:
        envelope = _safe_json_loads(raw)
        if envelope is None:
            logger.warning("uniAgentGate inbound ignored: reason=invalid_envelope")
            return
        msg_type = envelope.get("type")

        if msg_type == "ack":
            ack = protocol.parse_ack(envelope)
            if ack is not None:
                fut = self._pending_acks.pop(ack.in_reply_to, None)
                if fut is not None and not fut.done():
                    fut.set_result(ack)
            return

        if msg_type == "ws.heartbeat":
            return  # server→client heartbeat echo; no reply required (§7.7)

        if protocol.is_connection_replaced(envelope):
            # The Gateway will close this socket with code 4003 right
            # after this frame (§6.1) — nothing to do but wait for it.
            logger.info("uniAgentGate connection.replaced received")
            return

        if msg_type == "agent.request":
            await self._handle_agent_request(ws, envelope)
            return

        logger.info("uniAgentGate inbound ignored: reason=unsupported_frame")

    async def _handle_agent_request(self, ws: Any, envelope: dict[str, Any]) -> None:
        ref = protocol.message_ref(envelope.get("message_id"))
        logger.info("uniAgentGate inbound received: ref=%s", ref)
        request = protocol.parse_agent_request(envelope)
        if request is None or not request.message_id:
            logger.warning("uniAgentGate inbound ignored: ref=%s reason=missing_message_id", ref)
            return
        if request.agent_id != self._agent_id:
            logger.warning("uniAgentGate inbound ignored: ref=%s reason=agent_mismatch", ref)
            return

        if request.ack_required:
            await self._safe_send(ws, protocol.build_ack(in_reply_to=request.message_id))

        if self._is_duplicate(request.message_id):
            logger.info(
                "uniAgentGate duplicate agent.request ref=%s ignored", ref,
            )
            return

        context = UniAgentGateInboundContext(
            self,
            phone_number=request.phone_number,
            session_id=request.session_id,
            turn_id=request.turn_id,
            request_id=request.request_id,
        )
        raw: RawUniAgentGateMessage = {
            "msgId": request.message_id,
            "sessionId": request.session_id,
            "turnId": request.turn_id,
            "requestId": request.request_id,
            "phoneNumber": request.phone_number,
            "text": {"content": request.text},
            "fileUrl": request.file_url,
            "fileUrls": [item.url for item in request.inputs if item.type == "file_url" and item.url],
        }
        # Dispatch concurrently so a slow agent run never blocks the
        # receive loop (which must keep answering ws.heartbeat / ack).
        task = asyncio.create_task(
            self._dispatch(raw, context), name=f"uniagentgate-dispatch-{request.message_id}",
        )
        self._dispatch_tasks.add(task)
        task.add_done_callback(self._dispatch_tasks.discard)
        logger.info("uniAgentGate inbound queued: ref=%s text_chars=%s has_file=%s",
                    ref, len(request.text), bool(request.file_url))

    async def _dispatch(self, raw: RawUniAgentGateMessage, context: UniAgentGateInboundContext) -> None:
        try:
            await self._on_message(raw, context)
        except Exception as exc:
            logger.error("uniAgentGate inbound handler failed: ref=%s error_type=%s",
                         protocol.message_ref(raw.get("msgId")), type(exc).__name__)

    # ── Outbound reply (方式 A) ───────────────────────────────────────────────

    async def send_channel_message(
        self,
        *,
        phone_number: str,
        text: str = "",
        media: list[dict[str, str]] | None = None,
        session_id: str = "",
        turn_id: str = "",
    ) -> tuple[str, protocol.AckResult]:
        """``channel.message.send`` — the recommended RCS downlink (§7.1.1 / §7.8).

        Waits for the Gateway's business ACK (``payload.ok``) so the
        caller knows whether the SMS actually went out, not just
        whether the socket accepted the bytes. Raises :class:`RuntimeError`
        on timeout or an explicit ``ok=false`` so callers can log and
        move on the way every other channel's ``_reply_to_*`` does.
        """
        ws = self._ws
        if ws is None:
            raise RuntimeError("uniAgentGate WebSocket 未连接，无法下发消息")
        if not text and not media:
            raise RuntimeError("下发内容为空（既无文本也无媒体）")

        envelope = protocol.build_channel_message_send(
            agent_id=self._agent_id,
            phone_number=phone_number,
            text=text,
            media=media,
            session_id=session_id,
            turn_id=turn_id,
        )
        message_id = str(envelope["message_id"])
        loop = asyncio.get_running_loop()
        fut: "asyncio.Future[protocol.AckResult]" = loop.create_future()
        self._pending_acks[message_id] = fut
        try:
            try:
                await self._safe_send(ws, envelope)
            except (ConnectionClosed, OSError) as exc:
                raise RuntimeError("5G 连接中断，下发结果未知") from exc
            try:
                ack = await asyncio.wait_for(fut, timeout=ACK_WAIT_SECONDS)
            except asyncio.TimeoutError as exc:
                raise RuntimeError(
                    f"下发 RCS 消息超时未收到网关确认（phone={_mask_phone(phone_number)}）",
                ) from exc
        finally:
            self._pending_acks.pop(message_id, None)
            if not fut.done():
                fut.cancel()
            elif not fut.cancelled():
                fut.exception()  # A failed socket send may race the receive-loop failure.

        if not ack.ok:
            # Gateway-provided text is untrusted and may echo credentials.
            raise RuntimeError(f"网关拒绝下发: {ack.error_code}")
        logger.info("uniAgentGate downlink accepted: message_id=%s", message_id)
        return message_id, ack

    async def _safe_send(self, ws: Any, envelope: dict[str, Any]) -> None:
        await ws.send(json.dumps(envelope, ensure_ascii=False))

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _ws_url(self) -> str:
        parsed = urlsplit(self._gateway_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path = parsed.path.rstrip("/") + "/v1/agent-runtimes/connect"
        return urlunsplit((scheme, parsed.netloc, path, "", ""))

    def _is_duplicate(self, message_id: str) -> bool:
        """Dedup ``agent.request`` retries the same way ``ChannelsRuntime`` does.

        Belt-and-suspenders on top of the immediate protocol ACK: if the
        Gateway ever retransmits despite that ACK, we short-circuit
        instead of running (and re-billing an SMS for) the same turn twice.
        """
        now = time.monotonic()
        cutoff = now - DEDUPE_TTL_SECONDS
        while self._seen_message_ids:
            oldest_id, ts = next(iter(self._seen_message_ids.items()))
            if ts >= cutoff:
                break
            self._seen_message_ids.popitem(last=False)

        if message_id in self._seen_message_ids:
            return True
        self._seen_message_ids[message_id] = now
        while len(self._seen_message_ids) > DEDUPE_MAX_ENTRIES:
            self._seen_message_ids.popitem(last=False)
        return False


def _backoff_delay(attempt: int) -> float:
    """Exponential backoff with jitter, capped at ``CONNECT_RETRY_MAX_SEC``."""
    # Bound the exponent before computing it: capping the result afterwards
    # still overflows when a long outage pushes attempt beyond ~1024.
    max_exponent = math.ceil(math.log2(CONNECT_RETRY_MAX_SEC / CONNECT_RETRY_MIN_SEC))
    exponent = min(max(0, attempt), max_exponent)
    base = min(CONNECT_RETRY_MAX_SEC, CONNECT_RETRY_MIN_SEC * (2**exponent))
    jitter = base * (0.5 + random.random() * 0.5)
    return max(CONNECT_RETRY_MIN_SEC, jitter)


def _safe_json_loads(raw: str | bytes) -> dict[str, Any] | None:
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        parsed = json.loads(text)
    except (ValueError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _mask_phone(phone: str) -> str:
    return f"***{phone[-4:]}" if len(phone) >= 4 else "***"
