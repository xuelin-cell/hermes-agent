"""页面报来的事件，写成一行日志：自动刷新或跳走的原因、启动各阶段耗时、和实例的连接断开又恢复。

用来定位"用着用着重启了""切到个人又变回企业""等了十几秒"这类反馈：前端在刷新前用 sendBeacon 发一条，
重新加载后报启动耗时并带上上次刷新的原因（apps/desktop/src/lib/client-events-mt.ts）。

只写日志：不查库、不碰实例、不准备会话。身份读网关的身份头（只认 MT_SSO_TRUSTED 来的），身份刚换过的
页面也不会因为报事件去换令牌、唤醒实例。字段按白名单收，值截短、去掉空白和等号，按会话限频（没有身份时
按来源 IP），一律回 204，页面不用管结果。

所有请求都经第一层网关（.116）转发，直连地址全是网关：来源 IP 取 X-Forwarded-For 里从右往左第一个
不是可信代理（MT_SSO_TRUSTED）的地址，最左边那个客户端自己能伪造，不用。
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
import time
from collections import deque
from typing import Callable

from aiohttp import web

from .sso import SsoIdentity, peer_address, trusted

log = logging.getLogger("entry.client")

TYPES = frozenset({"boot", "reload", "link"})
MAX_BODY = 4096
MAX_FIELDS = 24
MAX_VALUE = 80
_KEY = re.compile(r"[a-z][a-z0-9_]{0,23}")
_UNSAFE = re.compile(r"[\s=\x00-\x1f\x7f]+")
_BROWSER = re.compile(r"(Edg|OPR|Firefox|Chrome|Version)/(\d+)")
_SYSTEMS = (("Windows", "Win"), ("Mac OS X", "Mac"), ("Android", "Android"), ("iPhone", "iOS"),
            ("iPad", "iOS"), ("Linux", "Linux"))


def short_agent(user_agent: str) -> str:
    """User-Agent 只留浏览器大版本和系统，够分辨"哪台电脑"，日志不至于一行几百字。"""
    found = dict(_BROWSER.findall(user_agent))
    for name, label in (("Edg", "Edge"), ("OPR", "Opera"), ("Firefox", "Firefox"), ("Chrome", "Chrome"),
                        ("Version", "Safari")):
        if name in found:
            browser = f"{label}/{found[name]}"
            break
    else:
        browser = "-"
    system = next((label for marker, label in _SYSTEMS if marker in user_agent), "-")
    return f"{browser}/{system}"


def clean_fields(body: dict) -> list[tuple[str, str]]:
    """白名单之外的键、不是标量的值都丢掉；值截短，去掉会破坏一行日志格式的字符。"""
    fields: list[tuple[str, str]] = []
    for key, value in body.items():
        if key == "type" or not isinstance(key, str) or not _KEY.fullmatch(key):
            continue
        if isinstance(value, bool):
            text = "1" if value else "0"
        elif isinstance(value, (int, float)):
            text = str(round(value)) if isinstance(value, float) else str(value)
        elif isinstance(value, str):
            text = _UNSAFE.sub("_", value)[:MAX_VALUE]
        else:
            continue
        if text:
            fields.append((key, text))
        if len(fields) >= MAX_FIELDS:
            break
    return fields


def describe(identity: SsoIdentity | None) -> str:
    if identity is None:
        return "who=-"
    who = identity.uid if identity.account_type == "personal" else f"{identity.tenant_id}:{identity.uid}"
    return f"who={identity.account_type}:{who[:48]} sid={identity.sid[:6]}"


def client_address(request: web.Request, networks) -> str:
    """真实来源：直连的是可信代理时，X-Forwarded-For 从右往左跳过可信代理，取第一个；否则就是直连地址。"""
    peer = peer_address(request)
    if not trusted(request, networks):
        return peer
    for item in reversed(request.headers.get("X-Forwarded-For", "").split(",")):
        try:
            address = ipaddress.ip_address(item.strip())
        except ValueError:
            break  # 写坏了的链不可信：停在这里，退回直连地址
        if not any(address in network for network in networks):
            return str(address)
    return peer


class ClientEvents:
    """``identity_of``：读当前请求的可信身份（入口的 ``_sso_identity``），没有就 None；
    ``networks_of``：可信代理网段（入口的 MT_SSO_TRUSTED）。"""

    # 每个会话每分钟最多记这么多条。不按 IP：同一出口 IP 后面可能是一整个办公室，而且直连地址全是网关
    PER_MINUTE = 30

    def __init__(self, identity_of: Callable[[web.Request], SsoIdentity | None],
                 networks_of: Callable[[], list] = list,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._identity_of = identity_of
        self._networks_of = networks_of
        self._clock = clock
        self._recent: dict[str, deque[float]] = {}
        self._dropped: dict[str, int] = {}  # 每个会话被限频丢掉几条，它下一条记上的日志里带出来

    def _allow(self, key: str) -> bool:
        now = self._clock()
        if len(self._recent) > 10_000:  # 不让一堆只来过一次的会话一直占着内存
            self._recent = {k: hits for k, hits in self._recent.items() if hits and now - hits[-1] < 60}
            self._dropped = {k: count for k, count in self._dropped.items() if k in self._recent}
        hits = self._recent.setdefault(key, deque())
        while hits and now - hits[0] >= 60:
            hits.popleft()
        if len(hits) >= self.PER_MINUTE:
            self._dropped[key] = self._dropped.get(key, 0) + 1
            return False
        hits.append(now)
        return True

    async def handle(self, request: web.Request) -> web.Response:
        address = client_address(request, self._networks_of())[:64] or "-"
        identity = self._identity_of(request)
        key = f"session:{identity.session_key}" if identity else f"ip:{address}"
        raw = await request.content.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY or not self._allow(key):
            return web.Response(status=204)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return web.Response(status=204)
        if not isinstance(body, dict) or body.get("type") not in TYPES:
            return web.Response(status=204)
        pairs = " ".join(f"{key}={value}" for key, value in clean_fields(body))
        dropped = self._dropped.pop(key, 0)
        log.info("client %s %s ip=%s ua=%s %s%s", body["type"], describe(identity), address,
                 short_agent(request.headers.get("User-Agent", "")), pairs,
                 f" (此前限频丢了 {dropped} 条)" if dropped else "")
        return web.Response(status=204)
