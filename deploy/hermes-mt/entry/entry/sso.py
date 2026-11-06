"""统一登录（docs/企业版对接/统一登录方案.html，v2.3）：网关验完登录，用身份请求头告诉入口是谁。

开关 ``MT_SSO=1``，默认关；关着时还是入口自己的短信登录（app.py）。开了以后：

- 入口不再写自己的登录 Cookie。网关 nginx 对 ``/agents/api/`` 做 auth_request，转发时带四个头：
  ``X-Uid``、``X-Account-Type``（personal / enterprise）、``X-Tenant-Id``（只有企业账号有）、``X-Sid``。缺头就是没登录。
- 只信网关发来的头：我们自己的 nginx 把 TCP 来源写进 ``X-Real-IP``，来源不在 ``MT_SSO_TRUSTED`` 里的请求当没登录。
  ``MT_SSO_TRUSTED`` 为空时谁的头都不信，否则有人直连 18081/18082 就能冒充任何人。
- 同一个 ``X-Sid`` 第一次来时，做原来登录时做的事（个人：12.4 取 MaaS 令牌 → my-plan；企业：换设备令牌 → 策略），
  之后按会话认人。``auth_sessions`` 里存的是身份和 sid 拼起来的摘要（``SsoIdentity.session_key``），身份头换了就对不上。
- 个人账号的 MaaS 令牌（12.4）只放在这个进程的内存里，按 sid 缓存到快过期：网关不校验这种令牌的过期时间，
  签出后退出了也不失效，所以不落库、不写日志、不发给浏览器。
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import time
from dataclasses import dataclass, field

import aiohttp
from aiohttp import web

log = logging.getLogger("entry.sso")

PERSONAL = "personal"
ENTERPRISE = "enterprise"
# 网关注入的身份请求头；反代不往实例里转（proxy.py）
IDENTITY_HEADERS = ("x-uid", "x-account-type", "x-tenant-id", "x-sid")
# 网关登录页的平台标识（方案第 05 节）
PLATFORM = "agents"
_MAX_HEADER = 256


@dataclass(frozen=True)
class SsoIdentity:
    """网关告诉我们的当前账号。``uid`` 对个人账号是元景 uid，对企业账号是成员 ID（membership.id）。"""

    uid: str
    account_type: str
    tenant_id: str
    sid: str = field(repr=False)

    @property
    def session_key(self) -> str:
        """入口按这个串的摘要存会话：身份头和 sid 都对上才是同一个会话。"""
        return f"sso:{self.account_type}:{self.tenant_id}:{self.uid}:{self.sid}"


def parse_networks(text: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """``MT_SSO_TRUSTED`` → 网段列表；写错的条目启动时就报错，不悄悄放过。"""
    return [ipaddress.ip_network(item.strip(), strict=False) for item in text.split(",") if item.strip()]


def peer_address(request: web.Request) -> str:
    """请求的真实来源：我们自己的 nginx 写的 X-Real-IP（入口不对外暴露端口，只有它连得上）。"""
    return (request.headers.get("X-Real-IP") or request.remote or "").strip()


def trusted(request: web.Request, networks) -> bool:
    if not networks:
        return False
    try:
        address = ipaddress.ip_address(peer_address(request))
    except ValueError:
        return False
    return any(address in network for network in networks)


def identity_from(request: web.Request) -> SsoIdentity | None:
    """读四个身份头；缺了、类型不认识、企业账号没带企业 ID，都当没登录。来源检查由调用方先做。"""
    uid = request.headers.get("X-Uid", "").strip()
    account_type = request.headers.get("X-Account-Type", "").strip().lower()
    tenant_id = request.headers.get("X-Tenant-Id", "").strip()
    sid = request.headers.get("X-Sid", "").strip()
    if not uid or not sid or account_type not in (PERSONAL, ENTERPRISE):
        return None
    if account_type == ENTERPRISE and not tenant_id:
        return None
    if account_type == PERSONAL:
        tenant_id = ""  # 个人账号不属于企业：网关也不该给，给了也不用
    if any(len(value) > _MAX_HEADER or ":" in value for value in (uid, tenant_id, sid)):
        return None
    return SsoIdentity(uid=uid, account_type=account_type, tenant_id=tenant_id, sid=sid)


def member_user_id(tenant_id: str, member_id: str) -> str:
    """统一登录后第一次进来的企业成员在入口里的用户 ID。

    以前登录过的员工沿用老 ID（``ent:<企业>:<元景 uid>``，按 enterprise_binding.member_id 找回来）；新员工身份头里
    只有成员 ID，没有元景 uid。中间多一段 ``member``，和老 ID 不会撞。
    """
    return f"ent:{tenant_id}:member:{member_id}"


def member_device_id(tenant_id: str, member_id: str) -> str:
    """新员工在平台上的云端设备号：身份头里没有手机号，按成员 ID 派生，每次都一样（34 号第 1 节）。"""
    return "cloud-" + hashlib.sha256(f"member:{tenant_id}:{member_id}".encode("utf-8")).hexdigest()[:16]


# ---- 个人账号：12.4 按会话取 MaaS 令牌 -------------------------------------------------


class CredentialFailure(Exception):
    """12.4 没给令牌。``status``：401 = 会话已失效（要重新登录），403 = 不是个人账号，其余一律 502。"""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class MaasCredential:
    uid: str
    expires_at_ms: int
    token: str = field(repr=False)
    phone: str = field(default="", repr=False)


class MaasCredentials:
    """12.4 的客户端，带按 sid 的内存缓存。同一个 sid 同时来很多请求时只调一次网关。"""

    # 离过期不到这么久就重新取（12.4 每次调用都重新签发）
    REFRESH_BEFORE_MS = 10 * 60 * 1000

    def __init__(self, url: str, token: str, http: aiohttp.ClientSession, timeout_s: float = 15):
        self.url = url
        self._token = token
        self.http = http
        self.timeout = aiohttp.ClientTimeout(total=timeout_s)
        self._cache: dict[str, MaasCredential] = {}
        self._inflight: dict[str, asyncio.Task] = {}
        self._drops: dict[str, int] = {}  # 每个 sid 被丢弃过几次：丢弃前发出的请求回来了也不再进缓存

    @staticmethod
    def _key(sid: str) -> str:
        return hashlib.sha256(sid.encode("utf-8")).hexdigest()

    @property
    def configured(self) -> bool:
        return bool(self.url and self._token)

    async def get(self, sid: str) -> MaasCredential:
        key = self._key(sid)
        cached = self._cache.get(key)
        if cached is not None and cached.expires_at_ms - time.time() * 1000 > self.REFRESH_BEFORE_MS:
            return cached
        task = self._inflight.get(key)
        if task is None:
            # 单独的任务：发起它的请求中途断了，别的请求照样等到结果
            task = asyncio.create_task(self._fetch(sid))
            self._inflight[key] = task
            drops = self._drops.get(key, 0)
            task.add_done_callback(lambda done: self._fetched(key, drops, done))
        return await asyncio.shield(task)

    def _fetched(self, key: str, drops: int, task: asyncio.Task) -> None:
        self._inflight.pop(key, None)
        if task.cancelled() or task.exception() is not None:  # 取一下异常：没人在等时也别报「never retrieved」
            return
        if self._drops.get(key, 0) == drops:
            self._cache[key] = task.result()

    def drop(self, sid: str) -> None:
        key = self._key(sid)
        self._cache.pop(key, None)
        self._drops[key] = self._drops.get(key, 0) + 1

    def purge(self) -> None:
        now_ms = time.time() * 1000
        for key in [k for k, v in self._cache.items() if v.expires_at_ms <= now_ms]:
            del self._cache[key]
        for key in [k for k in self._drops if k not in self._inflight]:
            del self._drops[key]

    async def _fetch(self, sid: str) -> MaasCredential:
        if not self.configured:
            raise CredentialFailure("没有配置统一登录的 12.4 接口（MT_SSO_CREDENTIAL_URL / MT_SSO_CREDENTIAL_TOKEN）")
        headers = {"Accept": "application/json", "X-Internal-Token": self._token}
        try:
            async with self.http.post(self.url, json={"sid": sid}, headers=headers, timeout=self.timeout) as resp:
                text = await resp.text()
                status = resp.status
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.warning("12.4 network error: %s", type(exc).__name__)
            raise CredentialFailure(f"统一登录服务暂时连不上（{type(exc).__name__}）") from exc
        try:
            body = json.loads(text) if text else {}
        except json.JSONDecodeError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        if status >= 400:
            error = str(body.get("error") or body.get("msg") or "")[:80]
            log.warning("12.4 -> HTTP %s %s", status, error)
            raise CredentialFailure(error or f"统一登录服务返回 HTTP {status}", status=status if status in (401, 403) else 502)
        data = body.get("data") if isinstance(body.get("data"), dict) else None
        if body.get("code") not in (0, "0", None) or data is None:
            raise CredentialFailure("统一登录服务没有返回令牌")
        uid = str(data.get("uid") or "").strip()
        token = str(data.get("token") or "").strip()
        expires_at = data.get("expiresAt")
        if not uid or not token or not isinstance(expires_at, (int, float)) or expires_at <= time.time() * 1000:
            raise CredentialFailure("统一登录服务返回的令牌不完整或已过期")
        return MaasCredential(uid=uid, expires_at_ms=int(expires_at), token=token,
                              phone=str(data.get("phone") or "").strip())
