"""透传层：REST 与 WebSocket 原样转发到该用户的容器。

除了下面几个头之外不改任何字节：
- ``Host`` 改成 ``127.0.0.1:9120``（hermes 的 Host 门只认 loopback 名）
- ``Origin`` 不转发（浏览器的 Origin 会被 hermes 当作跨站拒掉，.7 的 Nginx 也是清空的）
- REST 加 ``X-Hermes-Session-Token``；ws 加 ``?token=``
- ``Cookie`` 不转发（那是入口自己的会话，hermes 不该看到）
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Optional

import aiohttp
from aiohttp import web

from .config import Settings
from .tenants import Tenant

log = logging.getLogger("entry.proxy")

_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade", "host", "cookie", "origin", "content-length",
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol",
}
_RESP_STRIP = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"}
_MAX_WS_MSG = 64 * 1024 * 1024


def _upstream_headers(request: web.Request, settings: Settings, tenant: Tenant) -> dict[str, str]:
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    headers["Host"] = f"127.0.0.1:{settings.hermes_port}"
    headers["X-Hermes-Session-Token"] = tenant.token
    peer = request.remote or ""
    prior = request.headers.get("X-Forwarded-For", "")
    headers["X-Forwarded-For"] = f"{prior}, {peer}" if prior else peer
    headers.setdefault("X-Forwarded-Proto", request.headers.get("X-Forwarded-Proto", request.scheme))
    return headers


async def proxy_http(request: web.Request, settings: Settings, http: aiohttp.ClientSession, tenant: Tenant, tail: str) -> web.StreamResponse:
    qs = request.rel_url.query_string
    url = f"http://{tenant.ip}:{settings.forward_port}/{tail}" + (f"?{qs}" if qs else "")
    body = await request.read()
    headers = _upstream_headers(request, settings, tenant)
    try:
        async with http.request(
            request.method,
            url,
            headers=headers,
            data=body if body else None,
            allow_redirects=False,
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=1800),
        ) as resp:
            out = web.StreamResponse(status=resp.status, reason=resp.reason)
            for k, v in resp.headers.items():
                if k.lower() in _RESP_STRIP:
                    continue
                out.headers.add(k, v)
            await out.prepare(request)
            async for chunk in resp.content.iter_chunked(64 * 1024):
                await out.write(chunk)
            await out.write_eof()
            return out
    except aiohttp.ClientError as exc:
        log.warning("proxy %s %s -> %s: %s", request.method, tail, tenant.slug, exc)
        return web.json_response({"error": "tenant_unreachable", "detail": type(exc).__name__}, status=502)


async def proxy_ws(
    request: web.Request,
    settings: Settings,
    http: aiohttp.ClientSession,
    tenant: Tenant,
    on_activity: Optional[Callable[[], None]] = None,
) -> web.WebSocketResponse:
    """``on_activity`` 在每一帧上调用（调用方自己节流）。

    ★ 空闲回收看的是「最后一次活动时间」。ws 是长连接，一次握手之后可能几十分钟
    只有帧、没有新的 HTTP 请求——一次长回复的流式输出就是这样。不在这里打点的话，
    正在聊天的容器会被回收线程当成闲置停掉，对话当场断掉（实测 idle=1min 时必现）。
    """
    requested = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if p.strip()]
    qs = request.rel_url.query_string
    url = f"ws://{tenant.ip}:{settings.forward_port}/api/ws?token={tenant.token}" + (f"&{qs}" if qs else "")
    headers = {"Host": f"127.0.0.1:{settings.hermes_port}"}
    try:
        upstream = await http.ws_connect(
            url,
            headers=headers,
            protocols=requested,
            max_msg_size=_MAX_WS_MSG,
            heartbeat=None,
            timeout=aiohttp.ClientWSTimeout(ws_close=10),
        )
    except aiohttp.WSServerHandshakeError as exc:
        log.warning("ws handshake with tenant %s failed: %s %s", tenant.slug, exc.status, exc.message)
        raise web.HTTPBadGateway(text=f"tenant ws handshake {exc.status}")
    except aiohttp.ClientError as exc:
        log.warning("ws connect to tenant %s failed: %s", tenant.slug, exc)
        raise web.HTTPBadGateway(text="tenant unreachable")

    downstream = web.WebSocketResponse(
        protocols=(upstream.protocol,) if upstream.protocol else (),
        max_msg_size=_MAX_WS_MSG,
        heartbeat=None,
    )
    await downstream.prepare(request)

    async def pump(src: aiohttp.ClientWebSocketResponse | web.WebSocketResponse, dst, label: str) -> None:
        try:
            async for msg in src:
                if on_activity is not None:
                    on_activity()
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await dst.send_str(msg.data)
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    await dst.send_bytes(msg.data)
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                    break
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    log.debug("ws %s error: %s", label, src.exception())
                    break
        finally:
            code = src.close_code or 1000
            try:
                await dst.close(code=code if 1000 <= code < 5000 else 1000)
            except Exception:  # noqa: BLE001
                pass

    await asyncio.gather(
        pump(downstream, upstream, f"{tenant.slug}:client->tenant"),
        pump(upstream, downstream, f"{tenant.slug}:tenant->client"),
        return_exceptions=True,
    )
    return downstream
