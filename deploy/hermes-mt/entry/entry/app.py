"""提供多租户 Entry 的登录、路由、健康检查和租户代理 HTTP 服务。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from urllib.parse import unquote, urlencode, urlsplit

import aiohttp
from aiohttp import web

from .config import SETTINGS, Settings
from .browser_auth import BrowserAuth, BrowserIdentity
from .langfuse_routes import LangfuseRoutes
from .drive_routes import DriveRoutes
from .messaging_notifications import MessagingNotifications
from .account_routes import AccountRoutes
from .plan_routes import PlanRoutes
from .welcome_routes import WelcomeRoutes
from .timing_routes import TimingRoutes
from .usage_routes import UsageRoutes
from .client_events import ClientEvents
from .skill_routes import SkillRoutes, MUTATIONS as SKILL_MUTATIONS
from .crypto import CredentialCipher, CredentialError
from .connector_oauth import ConnectorAccessLogger
from .cube_api import Cube, CubeError
from .backend_errors import cube_failure_reason
from .db import Database, DatabaseUnavailable
from .docker_api import Docker
from .maas import Maas, MaasError
from .proxy import proxy_http, proxy_ws
from .backup import BackupJob
from .enterprise import EnterpriseSync
from .s3lite import S3Lite
from .service import RUNTIMES_PATH, ServiceApi
from .sso import (
    ENTERPRISE,
    PERSONAL,
    PLATFORM as SSO_PLATFORM,
    CredentialFailure,
    MaasCredentials,
    SsoIdentity,
    identity_from,
    member_device_id,
    member_user_id,
    parse_networks,
    peer_address,
    trusted,
)
from .store import EnterpriseBinding, Session, Store
from .share_store import ShareStore
from .share_gateway import ShareGateway
from .share_routes import ShareRoutes
from .mail_routes import MailRoutes
from .connector_routes import ConnectorRoutes
from .messaging_routes import MessagingRoutes
from .cloud_binding_routes import CloudBindingRoutes
from .shares import Shares
from .tenants import CredentialSyncError, RequestAbandoned, TenantManager
from .uniwork import (
    ACCESS_MESSAGES,
    ACTIVE,
    UNBOUND,
    Binding,
    Choice,
    Uniwork,
    UniworkError,
    access_status,
    device_id,
    member_of,
    plan_of,
    user_id_for,
)

log = logging.getLogger("entry.app")
STATIC_DIR = Path(__file__).resolve().parent / "static"

# 退出时设备令牌没吊销掉（平台连不上）：页面照这句提示，不说「退出成功」（38 号第 5 节）
REVOKE_PENDING_MESSAGE = "已退出登录，但企业设备令牌暂时没能吊销（企业管理平台连不上）。系统会自动重试，直到吊销成功。"


class SsoRefused(Exception):
    """统一登录下准备会话失败，要回给页面的错误（JSON：error / message）。每次回都新建响应。"""

    def __init__(self, status: int, error: str, message: str, **extra):
        super().__init__(message)
        self.status, self.error, self.message, self.extra = status, error, message, extra

    def response(self) -> web.HTTPException:
        cls = {401: web.HTTPUnauthorized, 403: web.HTTPForbidden, 503: web.HTTPServiceUnavailable}.get(
            self.status, web.HTTPBadGateway)
        body = json.dumps({"error": self.error, "message": self.message, **self.extra}, ensure_ascii=False)
        return cls(text=body, content_type="application/json")


@web.middleware
async def database_error_middleware(request: web.Request, handler):
    """把运行期 PostgreSQL 故障统一转换为不泄露内部信息的 503。"""
    try:
        return await handler(request)
    except DatabaseUnavailable as exc:
        log.warning("database request failed: %s", type(exc).__name__)
        return web.json_response({"error": "database_unavailable"}, status=503)


_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def origin_allowed(request: web.Request) -> bool:
    """这个请求是不是本站页面发起的。没有 Origin 的（非浏览器客户端）放行：浏览器发写请求和 WebSocket 一定带。

    比对的是浏览器地址栏里的「主机:端口」：nginx 用 X-Forwarded-Host 传过来（$http_host 带端口）。
    没有这个头（nginx 还没升级）就只比主机名——同主机别的端口挡不住，但不至于把正常请求全拒了。
    沙箱里的预览页（iframe sandbox、没有 allow-same-origin）发的 Origin 是 "null"，一律不放。
    """
    origin = request.headers.get("Origin")
    if origin is None:
        return True
    try:
        got = urlsplit(origin)
    except ValueError:
        return False
    if not got.netloc:
        return False
    forwarded = request.headers.get("X-Forwarded-Host", "").strip()
    if forwarded:
        return got.netloc.lower() == forwarded.lower()
    return (got.hostname or "").lower() == (urlsplit(f"//{request.host}").hostname or "").lower()


def origin_middleware(enabled: bool):
    """写请求（非 GET/HEAD/OPTIONS）和 WebSocket 握手：不是本站页面发起的一律 403。

    挡的是「借用户登录态的跨站请求」：cookie 是 SameSite=Lax，跨站页面带不上，但浏览器把同一主机
    不同端口的页面算同站（.7 上 18080 的单用户版就是这种），它们能带着我们的登录态连聊天、调上传、开终端。
    """

    @web.middleware
    async def middleware(request: web.Request, handler):
        upgrade = request.headers.get("Upgrade", "").lower() == "websocket"
        if enabled and (upgrade or request.method not in _SAFE_METHODS) and not origin_allowed(request):
            log.warning("refused cross-origin %s %s from origin %r", request.method, request.path,
                        request.headers.get("Origin", "")[:80])
            return web.json_response({"error": "cross_origin"}, status=403)
        return await handler(request)

    return middleware


class Entry:
    """协调平台数据库、MaaS、Docker 和用户 Hermes 容器。"""

    def __init__(self, settings: Settings):
        self.s = settings
        self.database = Database(
            settings.database_url,
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
            command_timeout_s=settings.db_command_timeout_s,
        )
        self.store = Store(
            self.database,
            CredentialCipher(settings.credential_key),
        )
        self.browser_auth = BrowserAuth(self.store.cipher)
        self.langfuse_routes = LangfuseRoutes(self)
        self.share_routes = ShareRoutes(self)
        self.mail_routes = MailRoutes(self)
        self.connector_routes = ConnectorRoutes(self)
        self.messaging_routes = MessagingRoutes(self)
        self.drive_routes = DriveRoutes(self)
        self.notifications = MessagingNotifications(self)
        self.account_routes = AccountRoutes(self)
        self.plan_routes = PlanRoutes(self)
        self.welcome_routes = WelcomeRoutes(self)
        self.timing_routes = TimingRoutes(self)
        self.usage_routes = UsageRoutes(self)
        self.client_events = ClientEvents(self._sso_identity, lambda: self._sso_networks)
        self.skill_routes = SkillRoutes(self)
        self.shares: Shares | None = None
        # aiohttp 客户端必须在事件循环中创建，因此在 on_startup 里赋值。
        self.http: aiohttp.ClientSession | None = None
        self.docker: Docker | None = None
        self.cube: Cube | None = None
        self.maas: Maas | None = None
        self.uniwork: Uniwork | None = None  # 企业模式才有
        self.ent: EnterpriseSync | None = None  # 企业模式：企业资源清单（Agent、技能、连接器……）送进实例
        self._last_recheck: dict[str, float] = {}  # 企业模式：每个用户上次在后台复查平台的时间
        self._rechecking: set[str] = set()
        self.tenants: TenantManager | None = None
        self._last_touch: dict[str, float] = {}
        self._live_ws: dict[str, int] = {}
        self._bg: list[asyncio.Task] = []
        # 统一登录（MT_SSO=1，见 sso.py）：信哪些来源的身份头；个人账号的 12.4 令牌缓存（on_startup 里建）；
        # 同一个会话只准备一次；刚失败的过一会儿再试；刚退出的会话不再准备（网关那边还没退完）。
        self._sso_networks = parse_networks(settings.sso_trusted) if settings.sso else []
        self.credentials: MaasCredentials | None = None
        self._provisioning: dict[str, asyncio.Future] = {}
        self._provision_failures: dict[str, tuple[float, SsoRefused]] = {}
        self._signed_out: dict[str, float] = {}
        self._untrusted_warned = -1e9

    async def _session(self, request: web.Request) -> Session | None:
        if self.s.sso:
            return await self._sso_session(request)
        sid = request.cookies.get(self.s.cookie_name, "")
        return await self.store.get_session(sid)

    async def _require(self, request: web.Request) -> Session:
        session = await self._session(request)
        if session is None:
            if self.s.sso:
                # 和网关未登录时回的一样：页面拿到 401 就去统一登录页
                raise web.HTTPUnauthorized(text='{"error": "LOGIN_REQUIRED"}', content_type="application/json")
            raise web.HTTPUnauthorized(text="not logged in")
        return session

    # ---- 统一登录（MT_SSO=1）：网关验登录，入口读身份头 ----------------------------------------
    #
    # 会话按（身份, 网关 sid）认：同一个 X-Sid 第一次来时做原来登录时做的事，存一行 auth_sessions（存摘要），之后照旧按会话
    # 走 _gate / _tenant_for。企业员工的令牌失效了（别的浏览器退出时吊销了、平台重置了设备）就在下一个请求时重新换发。

    _PROVISION_RETRY_S = 15.0  # 准备失败后多久再试
    _SIGNED_OUT_S = 120.0  # 退出后这么久里同一个会话的请求一律当没登录（网关 /sso/logout 还没生效时别又把令牌换发回来）

    def _sso_identity(self, request: web.Request) -> SsoIdentity | None:
        identity = identity_from(request)
        if identity is None:
            return None
        if not trusted(request, self._sso_networks):
            now = time.monotonic()
            if now - self._untrusted_warned > 60:
                self._untrusted_warned = now
                log.warning("sso: identity headers from %s ignored: not in MT_SSO_TRUSTED", peer_address(request)[:64])
            return None
        return identity

    async def _sso_session(self, request: web.Request) -> Session | None:
        identity = self._sso_identity(request)
        if identity is None:
            return None
        key = identity.session_key
        if time.monotonic() - self._signed_out.get(key, -1e9) < self._SIGNED_OUT_S:
            return None
        session = await self.store.get_session(key)
        if session is not None and not (identity.account_type == ENTERPRISE and session.enterprise_status in ("", UNBOUND)):
            return session
        try:
            return await self._provision_once(identity)
        except SsoRefused as exc:
            raise exc.response() from None

    async def _provision_once(self, identity: SsoIdentity) -> Session | None:
        """同一个会话同时来的请求只准备一次；刚失败过的过一会儿再试，别每个请求都去打平台。

        准备放在单独的任务里跑：发起它的那个请求中途断了（浏览器跳走了），别的请求照样等到结果。
        """
        key = identity.session_key
        failed = self._provision_failures.get(key)
        if failed is not None and time.monotonic() - failed[0] < self._PROVISION_RETRY_S:
            raise failed[1]
        task = self._provisioning.get(key)
        if task is None:
            task = asyncio.create_task(self._provision(identity))
            self._provisioning[key] = task
            task.add_done_callback(lambda done: self._provision_done(key, done))
        return await asyncio.shield(task)

    async def _provision(self, identity: SsoIdentity) -> Session | None:
        if identity.account_type == PERSONAL:
            return await self._provision_personal(identity)
        return await self._provision_enterprise(identity)

    def _provision_done(self, key: str, task: asyncio.Task) -> None:
        self._provisioning.pop(key, None)
        if task.cancelled():
            return
        error = task.exception()  # 取一下：没有请求在等时也别报「exception was never retrieved」
        if isinstance(error, SsoRefused):
            self._provision_failures[key] = (time.monotonic(), error)
        elif error is None:
            self._provision_failures.pop(key, None)

    async def _provision_personal(self, identity: SsoIdentity) -> Session | None:
        """个人账号的会话第一次来：按 sid 调 12.4 拿 MaaS 令牌和手机号，再按令牌查套餐，和短信登录后做的一样。

        12.4 说会话已失效（401）、或者给的 uid 和身份头对不上，都当没登录。
        """
        if self.credentials is None or self.maas is None:
            raise SsoRefused(503, "entry_not_ready", "入口还没准备好，请稍后重试")
        started = time.monotonic()
        try:
            credential = await self.credentials.get(identity.sid)
        except CredentialFailure as exc:
            if exc.status == 401:
                return None
            if exc.status == 403:
                raise SsoRefused(403, "ACCOUNT_NOT_ALLOWED", "当前账号不能使用工作台") from None
            raise SsoRefused(503, "login_service_unavailable", "统一登录服务暂时不可用，请稍后重试") from None
        if credential.uid != identity.uid:
            log.warning("sso: 12.4 answered another uid for this session; refused")
            self.credentials.drop(identity.sid)
            return None
        got_credential = time.monotonic()
        plan = await self.maas.my_plan(credential.token)
        # 切换账号慢时分得清是不是慢在这两步；sid 前 6 位和页面报的事件（client_events）对得上
        timing = (f"sid={identity.sid[:6]} 12.4={got_credential - started:.1f}s "
                  f"套餐={time.monotonic() - got_credential:.1f}s")
        api_key = plan.api_key if plan else ""
        if not api_key:
            log.warning("user %s has no new plan key; keeping any stored credential (%s)", identity.uid, timing)
        else:
            log.info("user %s plan (sso) %s: %s", identity.uid, timing, plan.summary())
        try:
            await self.store.finish_login(
                user_id=identity.uid,
                phone=credential.phone,
                api_key=api_key,
                endpoint=plan.endpoint() if plan else None,
                catalog=plan.catalog() if plan else None,
                ttl_s=self.s.session_ttl_s,
                upstream_expires_at_ms=credential.expires_at_ms,
                login_method="sso",
                limits=plan.limits() if plan else None,
                vision=plan.vision() if plan else None,
                sid=identity.session_key,
            )
        except ValueError:
            # 令牌（也就是网关会话）只剩几分钟：当没登录，页面去登录页续上
            self.credentials.drop(identity.sid)
            return None
        self.langfuse_routes.remember(identity.uid, credential.token, credential.expires_at_ms)
        self._spawn(self._warm(identity.uid))
        return await self.store.get_session(identity.session_key)

    async def _provision_enterprise(self, identity: SsoIdentity) -> Session | None:
        """企业员工的会话第一次来（或者令牌失效了）：找回以前登录过的用户 ID 和设备号；存着的令牌还能用就接着用
        （换发会让实例里正在用的令牌作废），没有或平台回 401 才凭成员 ID 换发（34 号第 1 节）。被拦的成员照样建会话，
        由 _gate 在页面里显示原因。"""
        if not self.s.enterprise or self.uniwork is None:
            raise SsoRefused(403, "ACCOUNT_NOT_ALLOWED", "这套工作台不接企业账号")
        if not self.s.uniwork_internal_token:
            log.error("sso: MT_UNIWORK_INTERNAL_TOKEN is not set; enterprise members cannot get a device token")
            raise SsoRefused(503, "entry_not_ready", "入口还没配好换设备令牌的密钥，请联系管理员")
        started = time.monotonic()
        found = await self.store.find_member_user(identity.tenant_id, identity.uid)
        if found:
            user_id, device = found
            before = await self.store.get_enterprise_binding(user_id)
            token = (await self.store.get_tenant_context(user_id)).api_key
        else:
            user_id = member_user_id(identity.tenant_id, identity.uid)
            device = member_device_id(identity.tenant_id, identity.uid)
            before, token = None, ""
        tenant_code = before.tenant_code if before else ""
        tenant_name = before.tenant_name if before else ""
        policy: dict = {}
        status = ""
        if token:
            try:
                policy = await self.uniwork.policy(token)
            except UniworkError as exc:
                if exc.status != 401:
                    raise self._platform_unavailable(exc) from None
                token = ""  # 令牌已失效：换发
            else:
                status = access_status(policy)
                if member_of(policy)[0] not in ("", identity.uid):
                    token = ""  # 存着的令牌不是这个成员的（不该发生）：换发
        if not token:
            try:
                grant = await self.uniwork.device_token(identity.tenant_id, identity.uid, device,
                                                        self.s.uniwork_internal_token)
            except UniworkError as exc:
                if exc.status == 409:
                    raise SsoRefused(403, "enterprise_access_denied",
                                     "企业账号不可用：成员不存在、不属于这个企业或已离职，请联系企业管理员",
                                     reason="unavailable") from None
                raise self._platform_unavailable(exc) from None
            token, policy, status = grant.device_token, grant.policy, grant.access
            tenant_code, tenant_name = grant.tenant_code or tenant_code, grant.tenant_name or tenant_name
        platform_s = time.monotonic() - started
        info = policy.get("enterprise") if isinstance(policy.get("enterprise"), dict) else {}
        tenant_name = tenant_name or str(info.get("name") or "")
        tenant_code = tenant_code or str(info.get("tenantCode") or "")
        _, member_name = member_of(policy)
        plan = plan_of(policy, token) if status == ACTIVE else None
        record = EnterpriseBinding(
            tenant_id=identity.tenant_id,
            tenant_code=tenant_code,
            tenant_name=tenant_name,
            uid=before.uid if before else identity.uid,
            device_id=device,
            member_id=identity.uid,
            member_name=member_name or (before.member_name if before else ""),
            access_status=status,
            policy_revision=str(policy.get("revision") or ""),
        )
        await self.store.finish_login(
            user_id=user_id,
            phone="",
            api_key=token,
            endpoint=plan.endpoint() if plan else None,
            catalog=plan.catalog() if plan else None,
            ttl_s=self.s.session_ttl_s,
            upstream_expires_at_ms=None,
            login_method="sso",
            limits=plan.limits() if plan else None,
            enterprise=record,
            sid=identity.session_key,
        )
        log.info("sso enterprise %s tenant=%s status=%s sid=%s 平台=%.1fs %s", user_id, tenant_code, status,
                 identity.sid[:6], platform_s, plan.summary() if plan else "(no models)")
        if status == ACTIVE:
            self._spawn(self._warm(user_id))
        return await self.store.get_session(identity.session_key)

    @staticmethod
    def _platform_unavailable(exc: UniworkError) -> SsoRefused:
        # 平台回的 401 / 403 是入口和平台之间的事（比如换设备令牌的密钥不对），不能当成用户没登录回给页面
        log.warning("sso: enterprise platform refused or unreachable: %s", exc)
        return SsoRefused(503, "enterprise_unavailable", "企业管理平台暂时连不上，请稍后重试")

    def _set_cookie(self, response: web.Response, session: Session) -> None:
        response.set_cookie(
            self.s.cookie_name,
            session.sid,
            max_age=max(0, session.expires_at - int(time.time())),
            path=self.s.base_path + "/",
            httponly=True,
            secure=self.s.cookie_secure,
            samesite="Lax",
        )

    async def _touch(self, user_id: str) -> None:
        now = time.monotonic()
        if now - self._last_touch.get(user_id, 0) <= 30:
            return
        await self.store.touch_tenant(user_id)
        self._last_touch[user_id] = now

    @staticmethod
    def _abandoned(session: Session) -> web.Response:
        """浏览器在排队等实例时走了：没人收这个回包，只是别再记成「实例没起来」。"""
        log.info("tenant for %s: client left while queued", session.user_id)
        return web.Response(status=503, text="client gone")

    async def _tenant_for(self, session: Session, request: web.Request | None = None):
        """``request`` 给了，排队等实例时浏览器断开就不再等（``RequestAbandoned``）。

        入口用 run_app 的默认设置，浏览器断开不会取消处理函数，只是 ``request.transport`` 变成 None。"""
        await self._touch(session.user_id)
        if self.tenants is None:
            raise RuntimeError("租户管理器尚未启动")
        if request is None:
            tenant = await self.tenants.ensure_running(session.user_id)
        else:
            def abandoned() -> bool:
                transport = request.transport
                return transport is None or transport.is_closing()
            tenant = await self.tenants.ensure_running(session.user_id, abandoned=abandoned)
        if self.ent is not None:
            self.ent.after_ready(session.user_id, tenant)
        return tenant

    async def _finish_login(
        self,
        user_id: str,
        api_key: str,
        upstream_expires_ms: int | None,
        phone: str = "",
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
        limits: dict[str, int] | None = None,
        vision: dict[str, bool] | None = None,
        enterprise: EnterpriseBinding | None = None,
        maas_token: str = "",
    ) -> web.Response:
        login = await self.store.finish_login(
            user_id=user_id,
            phone=phone,
            api_key=api_key,
            endpoint=endpoint,
            catalog=catalog,
            ttl_s=self.s.session_ttl_s,
            upstream_expires_at_ms=upstream_expires_ms,
            login_method="uniwork" if enterprise else "sms" if phone else "dev",
            limits=limits,
            vision=vision,
            enterprise=enterprise,
        )
        body = {
            "ok": True,
            "redirect": self.s.base_path + "/",
            "user_id": user_id,
            "has_key": login.has_api_key,
        }
        if enterprise is not None:
            body["enterprise"] = self._enterprise_view(enterprise, self._reason(enterprise.access_status))
        # 登录事务提交后后台预热；预热失败不撤销已经建立的平台登录。被企业拦住的人不预热：不给他拉起实例。
        if enterprise is None or enterprise.access_status == ACTIVE:
            self._spawn(self._warm(user_id))
        proof = ""
        if maas_token and upstream_expires_ms:
            proof, body["maas_auth"] = self.browser_auth.issue(
                login.session, maas_token, upstream_expires_ms, phone,
            )
            self.langfuse_routes.remember(user_id, maas_token, upstream_expires_ms)
        response = web.json_response(body, headers={"Cache-Control": "no-store"})
        self._set_cookie(response, login.session)
        if proof:
            response.set_cookie(
                self.s.cookie_name + "_maas", proof,
                max_age=max(0, login.session.expires_at - int(time.time())),
                path=self.s.base_path + "/", httponly=True,
                secure=self.s.cookie_secure, samesite="Lax",
            )
        else:
            response.del_cookie(self.s.cookie_name + "_maas", path=self.s.base_path + "/")
        return response

    # ---- 企业模式：访问拦截 ------------------------------------------------------

    def _reason(self, status: str) -> str:
        """平台状态 → 拦截原因，空串 = 放行。没有绑定（切到企业模式前登录的个人用户）当作 unbound，要重新登录；
        开发模式登录的用户例外（MT_DEV_LOGIN 只在本机开发时开）。个人模式不拦。"""
        if not self.s.enterprise or status == ACTIVE:
            return ""
        if not status and self.s.dev_login:
            return ""
        return status or UNBOUND

    def _gate(self, session: Session) -> str:
        """这个会话现在能不能用实例（看库里的状态），顺手在后台按平台的最新策略复查一次（每人每分钟最多一次）：
        管理员在后台停用、移出成员后，这个人后面的请求就会被拦下。长轮询实时同步是下一阶段的事。"""
        self._recheck_soon(session)
        return self._reason(session.enterprise_status)

    # 复查间隔（秒）。平台连不上时也按这个间隔重试，不会每个请求都打一次平台。
    _RECHECK_S = 60.0

    def _recheck_soon(self, session: Session) -> None:
        # 没有绑定的、令牌已失效的复查也没用（只能重新登录）
        if self.uniwork is None or session.enterprise_status in ("", UNBOUND):
            return
        user_id = session.user_id
        now = time.monotonic()
        if user_id in self._rechecking or now - self._last_recheck.get(user_id, -1e9) < self._RECHECK_S:
            return
        self._last_recheck[user_id] = now
        self._rechecking.add(user_id)
        self._spawn(self._recheck_quietly(user_id))

    def _spawn(self, coro) -> None:
        """后台跑一件事。顺手扔掉已经跑完的：登录预热、复查每个请求都可能起一个，不清会越攒越多。"""
        self._bg = [task for task in self._bg if not task.done()]
        self._bg.append(asyncio.create_task(coro))

    async def _recheck_quietly(self, user_id: str) -> None:
        try:
            await self._refresh_enterprise(user_id)
        except Exception as exc:  # noqa: BLE001 — 平台连不上：保持原状态，下一轮再查
            log.warning("enterprise recheck of %s failed: %s", user_id, exc)
        finally:
            self._rechecking.discard(user_id)

    @staticmethod
    def _blocked(reason: str) -> web.Response:
        return web.json_response(
            {"error": "enterprise_access_denied", "reason": reason,
             "message": ACCESS_MESSAGES.get(reason, "无权访问")},
            status=403,
        )

    @staticmethod
    def _enterprise_view(binding: EnterpriseBinding | None, reason: str) -> dict:
        """给登录页和账号栏看的企业信息（不含令牌）。"""
        return {
            "status": reason or ACTIVE,
            "allowed": not reason,
            "message": ACCESS_MESSAGES.get(reason, "") if reason else "",
            "tenantCode": binding.tenant_code if binding else "",
            "tenantName": binding.tenant_name if binding else "",
            "memberName": binding.member_name if binding else "",
        }

    async def _warm(self, user_id: str) -> None:
        try:
            if self.tenants is None:
                raise RuntimeError("租户管理器尚未启动")
            tenant = await self.tenants.ensure_running(user_id)
            if self.ent is not None:
                self.ent.after_ready(user_id, tenant)
        except Exception as exc:  # noqa: BLE001
            log.exception("warm-up of tenant %s failed: %s", user_id, type(exc).__name__)

    def _sso_login_url(self, target: str = "", prompt: str = "") -> str:
        """网关登录页的地址（MT_SSO_LOGIN_URL）；回跳地址只认本站 /agents/ 下的路径，别的一律回首页；
        prompt 只转方案里有的 select_account。"""
        home = self.s.base_path + "/"
        if not target.startswith(home) or "//" in target or "\\" in target:
            target = home
        query = {"platform": SSO_PLATFORM, "redirect_uri": target}
        if prompt == "select_account":
            query["prompt"] = prompt
        return f"{self.s.sso_login_url}?{urlencode(query)}"

    async def login_page(self, request: web.Request) -> web.Response:
        if self.s.sso:
            # 统一登录：登录页是网关的。页面要去登录页时都先到这里（网关不拦 /agents/ 下的页面，没登录也到得了），
            # 所以登录页地址只在 MT_SSO_LOGIN_URL 一处配
            raise web.HTTPFound(self._sso_login_url(request.query.get("redirect_uri", ""),
                                                    request.query.get("prompt", "")))
        # 两种模式各一份，统一登录（MT_SSO）上线后一起删
        name = "login.html" if self.s.enterprise else "login-personal.html"
        html = (STATIC_DIR / name).read_text(encoding="utf-8")
        return web.Response(text=html, content_type="text/html")

    async def browser_auth_script(self, request: web.Request) -> web.Response:
        return web.Response(
            text=(STATIC_DIR / "browser-auth.js").read_text(encoding="utf-8"),
            content_type="application/javascript", headers={"Cache-Control": "no-store"},
        )

    async def _require_maas(self, request: web.Request) -> BrowserIdentity:
        session = await self._require(request)
        if self.s.sso:
            identity = await self._sso_maas_identity(request, session)
        else:
            identity = self.browser_auth.require(
                session, request.cookies.get(self.s.cookie_name + "_maas", ""),
                request.headers.get("Authorization", ""),
            )
        self.langfuse_routes.remember(identity.user_id, identity.token, identity.expires_at)
        return identity

    async def _sso_maas_identity(self, request: web.Request, session: Session) -> BrowserIdentity:
        """统一登录下的 MaaS 令牌：按 X-Sid 从 12.4 取（内存缓存），浏览器不再持有令牌，它带的 Authorization 不看。"""
        sso = self._sso_identity(request)
        if sso is None or sso.account_type != PERSONAL or self.credentials is None:
            raise web.HTTPUnauthorized(text="maas_auth_required")
        try:
            credential = await self.credentials.get(sso.sid)
        except CredentialFailure as exc:
            if exc.status in (401, 403):
                raise web.HTTPUnauthorized(text="maas_auth_required") from None
            raise web.HTTPServiceUnavailable(text="login_service_unavailable") from None
        if credential.uid != session.user_id:
            raise web.HTTPUnauthorized(text="maas_auth_required")
        # 账号业务模块拿 login_id 认「还是不是同一次登录」：同一个网关会话不变
        login_id = hashlib.sha256(sso.session_key.encode("utf-8")).hexdigest()[:24]
        return BrowserIdentity(session.user_id, login_id, credential.expires_at_ms, credential.token, session.sid,
                               credential.phone)

    async def maas_auth_status(self, request: web.Request) -> web.Response:
        """Confirm the browser credential binding without returning the bearer."""
        identity = await self._require_maas(request)
        return web.json_response({
            "user_id": identity.user_id, "login_id": identity.login_id,
            "expires_at": identity.expires_at,
        }, headers={"Cache-Control": "no-store"})

    async def config(self, request: web.Request) -> web.Response:
        # sso：统一登录下这个接口在网关后面，没登录时网关直接回 401，页面看到 401 就知道要去统一登录页
        return web.json_response({"dev": self.s.dev_login and not self.s.sso, "base": self.s.base_path,
                                  "enterprise": self.s.enterprise, "sso": self.s.sso})

    async def health(self, request: web.Request) -> web.Response:
        try:
            await self.database.ping()
            tenants = await self.store.all_tenant_states()
        except DatabaseUnavailable as exc:
            log.warning("database health check failed: %s", type(exc).__name__)
            return web.json_response({"ok": False, "database": "unavailable"}, status=503)
        return web.json_response(
            {"ok": True, "database": "ok", "tenants": tenants, "live_ws": dict(self._live_ws)}
        )

    async def auth(self, request: web.Request) -> web.Response:
        if self.s.sso:
            # 统一登录：静态页不鉴权（网关转静态页时也不带身份头），页面自己问 /sso/me，没登录再去统一登录页
            return web.Response(status=200)
        session = await self._session(request)
        # 企业拦住的人也回 401：nginx 把他送到登录页，登录页显示拦截说明。
        if session is None or self._gate(session):
            return web.Response(status=401, text="unauthorized")
        return web.Response(status=200, headers={"X-MT-User": session.user_id})

    async def me(self, request: web.Request) -> web.Response:
        """当前登录的是谁：页面状态栏的账号那一项（垫片的 getMaasAccount）读它。"""
        session = await self._require(request)
        states = {user: (state, timestamp) for user, state, timestamp in await self.store.all_tenant_states()}
        state = states.get(session.user_id, ("stopped", 0))
        body = {
            "user_id": session.user_id,
            "display": await self.store.masked_phone(session.user_id) or session.user_id,
            "tenant_state": state[0],
            "last_seen_at": state[1],
            # 会话到期时间（秒）：到期后页面在账号旁标「登录已到期」。
            "expires_at": session.expires_at,
        }
        if self.s.enterprise:
            binding = await self.store.get_enterprise_binding(session.user_id)
            body["enterprise"] = self._enterprise_view(binding, self._gate(session))
            # 企业版开放的个人版功能：页面按它逐项挂能力（垫片的 enterpriseCapabilities）
            body["features"] = sorted(self.s.enterprise_features)
            if self.s.sso and binding is not None and binding.member_name:
                body["display"] = binding.member_name  # 统一登录后新员工没有手机号
        if self.s.sso:
            body["sso"] = True
            body["expires_at"] = 0  # 会话由网关续期，入口不知道什么时候到期：页面不提示「登录已到期」
        return web.json_response(body)

    def _no_own_login(self) -> None:
        """统一登录下入口自己的登录接口都不在了：短信、选企业都在网关的登录页上做。"""
        if self.s.sso:
            raise web.HTTPNotFound()

    async def captcha(self, request: web.Request) -> web.Response:
        self._no_own_login()
        if self.maas is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        try:
            return web.json_response(await self.maas.captcha())
        except MaasError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)

    async def send_code(self, request: web.Request) -> web.Response:
        self._no_own_login()
        if self.maas is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        body = await request.json()
        try:
            data = await self.maas.send_code(
                str(body.get("phone", "")),
                str(body.get("captchaCode", "")),
                str(body.get("captchaId", "")),
            )
            return web.json_response(data)
        except MaasError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)

    async def login(self, request: web.Request) -> web.Response:
        self._no_own_login()
        if self.s.enterprise:
            return await self._enterprise_login(request)
        if self.maas is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        body = await request.json()
        phone = str(body.get("phone", "")).strip()
        code = str(body.get("smsCode", "")).strip()
        if not phone or not code:
            return web.json_response({"error": "缺少手机号或验证码"}, status=400)
        try:
            result = await self.maas.sms_login(phone, code)
        except MaasError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        plan = await self.maas.my_plan(result.token)
        api_key = plan.api_key if plan else ""
        endpoint = plan.endpoint() if plan else None
        catalog = plan.catalog() if plan else None
        limits = plan.limits() if plan else None
        vision = plan.vision() if plan else None
        if not api_key:
            log.warning("user %s has no new plan key; keeping any stored credential", result.uid)
        else:
            log.info("user %s plan: %s", result.uid, plan.summary())
            if not (endpoint and endpoint[0]):
                log.warning("user %s: my-plan did not provide a plan base URL", result.uid)
        response = await self._finish_login(
            result.uid,
            api_key,
            result.expires_at_ms,
            phone=phone,
            endpoint=endpoint,
            catalog=catalog,
            limits=limits,
            vision=vision,
            maas_token=result.token,
        )
        try:
            await self.messaging_routes.apply_login(result.uid,result.raw.get('plan'))
        except Exception as error:
            log.warning('channel credential update deferred: %s',type(error).__name__)
        return response

    async def dev_login(self, request: web.Request) -> web.Response:
        self._no_own_login()
        if not self.s.dev_login:
            raise web.HTTPNotFound()
        body = await request.json()
        user = str(body.get("user", "")).strip()
        if not user:
            return web.json_response({"error": "缺少用户名"}, status=400)
        return await self._finish_login(user, self.s.dev_api_key, None)

    # ---- 企业模式：登录经平台 ----------------------------------------------------
    #
    # 短信码交给平台，平台替入口调元景并发设备令牌（uniwork.py）。要选企业时，平台给的一次性票据和手机号
    # 加密后交给登录页（pending），选好后原样带回来调 select-tenant；入口自己不留状态，多副本也不怕。

    _PENDING_TTL_S = 30 * 60

    def _seal(self, payload: dict) -> str:
        blob = json.dumps({**payload, "at": int(time.time())}, separators=(",", ":"))
        return self.store.cipher.encrypt(blob).decode("ascii")

    def _unseal(self, sealed: str) -> dict | None:
        try:
            payload = json.loads(self.store.cipher.decrypt(sealed.encode("ascii")))
        except (CredentialError, UnicodeError, ValueError):
            return None
        if not isinstance(payload, dict) or not payload.get("ticket") or not payload.get("phone"):
            return None
        if time.time() - int(payload.get("at") or 0) > self._PENDING_TTL_S:
            return None
        return payload

    async def _enterprise_login(self, request: web.Request) -> web.Response:
        if self.uniwork is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        body = await request.json()
        phone = str(body.get("phone", "")).strip()
        code = str(body.get("smsCode", "")).strip()
        tenant_code = str(body.get("tenantCode", "")).strip()
        if not phone or not code:
            return web.json_response({"error": "缺少手机号或验证码"}, status=400)
        try:
            outcome = await self.uniwork.sms_login(phone, code, tenant_code)
        except UniworkError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        if isinstance(outcome, Choice):
            # 还要选企业：不建会话，把票据封好交给登录页
            return web.json_response({
                "ok": False,
                "enterprise": {
                    "status": outcome.status,
                    "pending": self._seal({"ticket": outcome.ticket, "phone": phone}),
                    "tenantCode": outcome.tenant_code,
                    "tenants": outcome.tenants,
                },
            })
        return await self._bind(phone, outcome)

    async def select_tenant(self, request: web.Request) -> web.Response:
        """登录页选了企业（tenantId）或填了企业编号（tenantCode）。编号不对回 404，票据还能用，可以换个编号再试。"""
        self._no_own_login()
        if not self.s.enterprise or self.uniwork is None:
            raise web.HTTPNotFound()
        body = await request.json()
        pending = self._unseal(str(body.get("pending", "")))
        if pending is None:
            return web.json_response({"error": "登录已超时，请重新获取验证码"}, status=401)
        tenant_id = str(body.get("tenantId", "")).strip()
        tenant_code = str(body.get("tenantCode", "")).strip()
        if not tenant_id and not tenant_code:
            return web.json_response({"error": "请选择企业或填写企业编号"}, status=400)
        phone = str(pending["phone"])
        try:
            binding = await self.uniwork.select_tenant(
                str(pending["ticket"]), phone, tenant_id=tenant_id, tenant_code=tenant_code)
        except UniworkError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        return await self._bind(phone, binding)

    async def _bind(self, phone: str, binding: Binding) -> web.Response:
        """登录选定了企业：设备令牌当模型 key 存，策略里的模型清单当套餐存，绑定一并写入；被拦住的不预热实例。"""
        access = binding.access
        member_id, member_name = member_of(binding.policy)
        plan = plan_of(binding.policy, binding.device_token) if access == ACTIVE else None
        user_id = user_id_for(binding.tenant_id, binding.login.uid)
        record = EnterpriseBinding(
            tenant_id=binding.tenant_id,
            tenant_code=binding.tenant_code,
            tenant_name=binding.tenant_name,
            uid=binding.login.uid,
            device_id=device_id(phone),
            member_id=member_id,
            member_name=member_name,
            access_status=access,
            policy_revision=str(binding.policy.get("revision") or ""),
        )
        log.info("enterprise login %s tenant=%s status=%s %s", user_id, binding.tenant_code, access,
                 plan.summary() if plan else "(no models)")
        return await self._finish_login(
            user_id,
            binding.device_token,
            binding.login.expires_at_ms,
            phone=phone,
            endpoint=plan.endpoint() if plan else None,
            catalog=plan.catalog() if plan else None,
            limits=plan.limits() if plan else None,
            enterprise=record,
        )

    async def enterprise(self, request: web.Request) -> web.Response:
        """拦截页「重新检查」和定时复查：问平台这个人现在能不能用，更新绑定后返回最新状态。"""
        if not self.s.enterprise or self.uniwork is None:
            raise web.HTTPNotFound()
        session = await self._require(request)
        try:
            status = await self._refresh_enterprise(session.user_id)
        except UniworkError as exc:
            return web.json_response({"error": str(exc)}, status=502)
        binding = await self.store.get_enterprise_binding(session.user_id)
        return web.json_response(self._enterprise_view(binding, self._reason(status)))

    async def _refresh_enterprise(self, user_id: str) -> str:
        """按平台的最新策略更新这个用户的绑定，返回新状态。平台回 401（令牌已失效）记成 unbound；连不上照样抛。"""
        assert self.uniwork is not None
        before = await self.store.get_enterprise_binding(user_id)
        if before is None:
            return ""  # 没有绑定：个人模式留下的会话，没什么可查
        token = (await self.store.get_tenant_context(user_id)).api_key
        if not token:
            await self.store.update_enterprise_access(user_id, UNBOUND)
            return UNBOUND
        try:
            policy = await self.uniwork.policy(token)
        except UniworkError as exc:
            if exc.status != 401:
                raise
            # 刚重新登录过：平台吊销了旧令牌，这次读到的却还是旧的。换了令牌就按新令牌再查一次，别把刚登录的人记成失效
            current = (await self.store.get_tenant_context(user_id)).api_key
            if current and current != token:
                return await self._refresh_enterprise(user_id)
            await self.store.update_enterprise_access(user_id, UNBOUND)
            return UNBOUND
        status = access_status(policy)
        plan = plan_of(policy, token) if status == ACTIVE else None
        _, member_name = member_of(policy)
        info = policy.get("enterprise") if isinstance(policy.get("enterprise"), dict) else {}
        await self.store.update_enterprise_access(
            user_id,
            status,
            policy_revision=str(policy.get("revision") or ""),
            member_name=member_name or None,
            tenant_name=str(info.get("name") or ""),
            endpoint=plan.endpoint() if plan else None,
            catalog=plan.catalog() if plan else None,
            limits=plan.limits() if plan else None,
        )
        if status != before.access_status:
            await self.store.write_audit(user_id, "enterprise.access", {"from": before.access_status, "to": status})
            if status == ACTIVE:
                self._spawn(self._warm(user_id))
        if self.ent is not None:
            # Agent、技能、连接器、企业经验：变了就送进实例（被拦的成员策略里是空的，托管 profile 收起、数据保留）
            await self.ent.note_policy(user_id, policy)
        return status

    async def _enterprise_logout(self, user_id: str) -> bool:
        """企业员工退出：吊销平台上的设备令牌，绑定记成 unbound（这个人别的浏览器随之被拦；统一登录下会重新换发）。

        返回令牌吊销了没有。平台连不上、吊销不掉时照常退出，但如实告诉页面（38 号第 5 节：不能显示退出成功而令牌
        还能用），并且：入口存的令牌清掉、转去后台重试吊销（_revoker），实例暂停（里面的 hermes 拿着这把令牌）。
        unbound 的用户不会被定时任务叫醒（store.cron_due_tenants）。"""
        if self.uniwork is None or await self.store.get_enterprise_binding(user_id) is None:
            return True
        token = (await self.store.get_tenant_context(user_id)).api_key
        revoked = True
        if token:
            try:
                await self.uniwork.logout(token)
            except UniworkError as exc:
                revoked = False
                log.warning("enterprise logout of %s: revoking device token failed, retrying later: %s", user_id, exc)
                await self.store.revoke_later(user_id, token, str(exc))
                self._spawn(self._pause_after_logout(user_id))
        await self.store.update_enterprise_access(user_id, UNBOUND)
        if self.ent is not None:
            self.ent.forget(user_id)
        return revoked

    async def _pause_after_logout(self, user_id: str) -> None:
        try:
            if self.tenants is not None:
                await self.tenants.stop(user_id, reason="logout: device token revocation pending")
        except Exception as exc:  # noqa: BLE001
            log.warning("pausing %s after logout failed: %s", user_id, type(exc).__name__)

    # 吊销没成功的令牌多久重试一次（按次数退避，最长一小时）
    _REVOKE_EVERY_S = 60.0

    async def _revoker(self) -> None:
        while True:
            await asyncio.sleep(self._REVOKE_EVERY_S)
            try:
                await self._retry_revocations()
            except Exception as exc:  # noqa: BLE001
                log.warning("revocation retry tick skipped: %s", type(exc).__name__)

    async def _retry_revocations(self) -> None:
        if self.uniwork is None:
            return
        for revocation_id, user_id, token, attempts in await self.store.due_revocations():
            try:
                await self.uniwork.logout(token)  # 令牌本来就失效了（401）也算吊销成功
            except UniworkError as exc:
                await self.store.revocation_failed(revocation_id, str(exc), min(3600.0, 60.0 * 2 ** min(attempts, 6)))
                continue
            await self.store.revocation_done(revocation_id)
            await self.store.write_audit(user_id, "enterprise.token_revoked_later", {"attempts": attempts + 1})
            log.info("enterprise logout of %s: device token revoked on retry %d", user_id, attempts + 1)

    async def _end_session(self, request: web.Request) -> bool:
        """入口自己的登录退出。返回企业设备令牌吊销了没有（个人模式、本来就没登录都算吊销了）。"""
        sid = request.cookies.get(self.s.cookie_name, "")
        if not sid:
            return True
        session = await self.store.get_session(sid)
        await self.store.delete_session(sid)
        await self.share_routes.agent.logout(sid)
        await self.drive_routes.logout(sid)
        await self.account_routes.worker.logout(sid)
        revoked = True
        if session:
            if self.s.enterprise:
                revoked = await self._enterprise_logout(session.user_id)
            await self.store.write_audit(session.user_id, "logout", {"revoked": revoked})
        return revoked

    async def _sso_logout(self, request: web.Request) -> web.Response:
        """统一登录的退出：页面先调这里，再调网关的 /sso/logout（方案第 22 节：先吊销企业设备令牌）。"""
        identity = self._sso_identity(request)
        if identity is None:
            return web.json_response({"ok": True, "revoked": True}, headers={"Cache-Control": "no-store"})
        key = identity.session_key
        self._signed_out[key] = time.monotonic()
        session = await self.store.get_session(key)
        await self.store.delete_session(key)
        await self.share_routes.agent.logout(key)
        await self.drive_routes.logout(key)
        await self.account_routes.worker.logout(key)
        if self.credentials is not None:
            self.credentials.drop(identity.sid)
        revoked = True
        if session is not None:
            if identity.account_type == ENTERPRISE and self.s.enterprise:
                revoked = await self._enterprise_logout(session.user_id)
            await self.store.write_audit(session.user_id, "logout", {"sso": True, "revoked": revoked})
        body: dict = {"ok": True, "revoked": revoked}
        if not revoked:
            body["message"] = REVOKE_PENDING_MESSAGE
        return web.json_response(body, headers={"Cache-Control": "no-store"})

    async def logout(self, request: web.Request) -> web.Response:
        if self.s.sso:
            return await self._sso_logout(request)
        revoked = await self._end_session(request)
        body: dict = {"ok": True, "revoked": revoked}
        if not revoked:
            body["message"] = REVOKE_PENDING_MESSAGE
        response = web.json_response(body)
        response.del_cookie(self.s.cookie_name, path=self.s.base_path + "/")
        response.del_cookie(self.s.cookie_name + "_maas", path=self.s.base_path + "/")
        return response

    async def logout_page(self, request: web.Request) -> web.Response:
        if self.s.sso:
            # 统一登录：这一页在浏览器里依次调入口的退出和网关的 /sso/logout，再去统一登录页
            html = (STATIC_DIR / "logout-sso.html").read_text(encoding="utf-8")
            login = json.dumps(self._sso_login_url(), ensure_ascii=False).replace("<", "\\u003c")
            html = html.replace("__LOGIN_URL__", login)
            return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})
        revoked = await self._end_session(request)
        response = web.HTTPFound(self.s.path("/login") + ("?signed_out=1" if revoked else "?signed_out=1&revoke_pending=1"))
        response.del_cookie(self.s.cookie_name, path=self.s.base_path + "/")
        response.del_cookie(self.s.cookie_name + "_maas", path=self.s.base_path + "/")
        return response

    async def ws(self, request: web.Request) -> web.StreamResponse:
        """聊天：hermes 自己的 /api/ws。"""
        path = "/api/plugins/uniwork-kits/cloud/ws" if request.query.get("kits") == "1" else "/api/ws"
        return await self._proxy_tenant_ws(request, path, heartbeat=None)

    async def terminal(self, request: web.Request) -> web.StreamResponse:
        """右侧终端面板：实例里转发器的命令行通道。终端可能长时间没有输出，两头每 25 秒发一次心跳。"""
        return await self._proxy_tenant_ws(request, "/__mt_user/terminal", heartbeat=25.0)

    async def _proxy_tenant_ws(self, request: web.Request, path: str, heartbeat: float | None) -> web.StreamResponse:
        """把一条 WebSocket 接到这个用户的实例上。连着的时候算在线：空闲回收不会暂停这台实例。"""
        session = await self._require(request)
        reason = self._gate(session)
        if reason:
            return self._blocked(reason)
        try:
            tenant = await self._tenant_for(session, request)
        except DatabaseUnavailable:
            raise
        except RequestAbandoned:
            return self._abandoned(session)
        except CredentialSyncError as exc:
            log.warning("credential sync for %s failed: %s", session.user_id, type(exc).__name__)
            raise web.HTTPBadGateway(text="tenant credential sync failed") from exc
        except Exception as exc:  # noqa: BLE001
            log.exception("tenant for %s not ready", session.user_id)
            raise web.HTTPBadGateway(text=f"tenant not ready: {type(exc).__name__}") from exc
        user_id = session.user_id
        if self.http is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        self._live_ws[user_id] = self._live_ws.get(user_id, 0) + 1
        try:
            return await proxy_ws(
                request,
                self.s,
                self.http,
                tenant,
                on_activity=lambda: self._touch(user_id),
                path=path,
                heartbeat=heartbeat,
            )
        finally:
            remaining = self._live_ws.get(user_id, 1) - 1
            if remaining > 0:
                self._live_ws[user_id] = remaining
            else:
                self._live_ws.pop(user_id, None)
            try:
                await self.store.touch_tenant(user_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("ws disconnect activity update failed for %s: %s", user_id, type(exc).__name__)

    # 用户经代理打不到的路径：转发器的管理接口（能让自己的实例排空），
    # 以及 hermes 的「导入备份」（它会在库打开时替换 state.db，归档和真实库会分叉）。
    # 注意 ``__mt_user/``（回收站、重命名、命令行）不在其中：那是给用户用的，转发器自己核对会话令牌。
    _BLOCKED_TAILS = ("__mt/", "api/ops/import", "api/plugins/cloud-mail/internal/", "api/plugins/cloud-mail/mcp", "api/plugins/conversation-share/internal/", "api/plugins/cloud-drive/internal/", "api/plugins/cloud-drive/mcp")
    # hermes 的「显示环境变量原值」：浏览器能借它读出 .env 里的设备令牌和别的密钥（按路径结尾挡，带 profile 前缀的也算）。
    _BLOCKED_ENDINGS = ("api/env/reveal",)

    async def backend(self, request: web.Request) -> web.StreamResponse:
        session = await self._require(request)
        tail = request.match_info.get("tail", "").lstrip("/")
        import posixpath
        normalized = tail
        for _ in range(4):
            decoded = unquote(normalized)
            if decoded == normalized:
                break
            normalized = decoded
        normalized = posixpath.normpath(normalized).lstrip('/')
        if "\\" in normalized:
            raise web.HTTPNotFound()
        if not self.s.enterprise and (request.method, normalized) in SKILL_MUTATIONS:
            raise web.HTTPConflict(text='请使用云端技能操作入口，以确认保存后再返回成功。')
        if (normalized.startswith(self._BLOCKED_TAILS) or normalized in self._BLOCKED_TAILS
                or normalized.endswith(self._BLOCKED_ENDINGS)):
            raise web.HTTPNotFound()
        reason = self._gate(session)
        if reason:
            return self._blocked(reason)
        try:
            tenant = await self._tenant_for(session, request)
        except DatabaseUnavailable:
            raise
        except RequestAbandoned:
            return self._abandoned(session)
        except CredentialSyncError as exc:
            log.warning("credential sync for %s failed: %s", session.user_id, type(exc).__name__)
            return web.json_response({"error": "credential_sync_failed"}, status=502)
        except CubeError as exc:
            log.exception("tenant for %s not ready", session.user_id)
            return web.json_response(
                {"error": "tenant_not_ready", "reason": cube_failure_reason(exc.status, exc.message or ""),
                 "upstream_status": exc.status}, status=502,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("tenant for %s not ready", session.user_id)
            return web.json_response(
                {"error": "tenant_not_ready", "detail": type(exc).__name__},
                status=502,
            )
        if self.http is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        return await proxy_http(
            request,
            self.s,
            self.http,
            tenant,
            request.match_info.get("tail", ""),
        )

    async def on_startup(self, app: web.Application) -> None:
        await self.database.connect()
        try:
            self.http = aiohttp.ClientSession()
            self.maas = Maas(self.s, self.http)
            if self.s.enterprise:
                self.uniwork = Uniwork(self.s, self.http)
                self.ent = EnterpriseSync(self)
            if self.s.sso:
                self.credentials = MaasCredentials(self.s.sso_credential_url, self.s.sso_credential_token, self.http,
                                                   timeout_s=self.s.upstream_timeout_s)
                self._check_sso_settings()
            self.shares = Shares(ShareStore(self.database), ShareGateway(self.http), self.share_routes.instance, self.share_routes.authorize)
            # 按后端只建需要的那个客户端：跑沙箱后端时不该去碰 docker.sock
            # （入口容器很可能根本没挂它），反之亦然。
            if self.s.backend == "cube":
                self.cube = Cube(
                    api_base=self.s.cube_api,
                    proxy_base=self.s.cube_proxy,
                    domain=self.s.cube_domain,
                    api_key=self.s.cube_api_key,
                    template=self.s.cube_template,
                )
            else:
                self.docker = Docker(self.s.docker_sock)
            self.tenants = TenantManager(self.s, self.docker, self.store, self.http, self.cube)
        except Exception:
            if self.http is not None:
                await self.http.close()
            await self.database.close()
            raise
        self._bg.append(asyncio.create_task(self._reconcile()))
        self._bg.append(asyncio.create_task(self._reaper()))
        if self.s.enterprise:
            self._bg.append(asyncio.create_task(self._revoker()))
        if self.s.channels_key:
            self._bg.append(asyncio.create_task(self.notifications.loop()))
        if self.s.backend == "cube" and self.s.cron_wake_lead_s > 0:
            self._bg.append(asyncio.create_task(self._cron_waker()))
        # 卷外第二份副本：四项桶配置齐了才跑；只对沙箱后端有意义（归档在卷上）。
        if self.s.backend == "cube" and self.s.backup_enabled and self.tenants is not None:
            self.backup = BackupJob(
                self.s,
                self.store,
                S3Lite(
                    self.http,
                    self.s.backup_s3_endpoint,
                    self.s.backup_s3_bucket,
                    self.s.backup_s3_access_key,
                    self.s.backup_s3_secret_key,
                    region=self.s.backup_s3_region,
                    path_style=self.s.backup_s3_path_style,
                ),
                self.tenants.cube_volume_name,
                self.store.backup_candidates,
            )
            self._bg.append(asyncio.create_task(self.backup.loop(self.s.backup_initial_delay_s)))
            log.info("backup: 卷外副本已启用，每 %d 小时一轮，首轮 %d 秒后", self.s.backup_interval_h, self.s.backup_initial_delay_s)
        else:
            self.backup = None

    def _check_sso_settings(self) -> None:
        """统一登录缺了哪项配置，启动时就说清楚（缺了也照常启动：页面会显示「还没准备好」）。"""
        if not self._sso_networks:
            log.error("sso: MT_SSO_TRUSTED is empty; identity headers are refused from everywhere")
        if not self.s.enterprise and not (self.s.sso_credential_url and self.s.sso_credential_token):
            log.error("sso: MT_SSO_CREDENTIAL_URL / MT_SSO_CREDENTIAL_TOKEN not set; personal accounts cannot sign in")
        if self.s.enterprise and not self.s.uniwork_internal_token:
            log.error("sso: MT_UNIWORK_INTERNAL_TOKEN not set; enterprise members cannot get a device token")

    def _forget_sso_leftovers(self) -> None:
        """回收线程顺手清：过期的 12.4 令牌、过了重试间隔的失败记录、退出够久的会话。"""
        if self.credentials is not None:
            self.credentials.purge()
        now = time.monotonic()
        for key in [k for k, (at, _) in self._provision_failures.items() if now - at > self._PROVISION_RETRY_S]:
            del self._provision_failures[key]
        for key in [k for k, at in self._signed_out.items() if now - at > self._SIGNED_OUT_S]:
            del self._signed_out[key]

    async def _reconcile(self) -> None:
        try:
            if self.tenants is not None:
                await self.tenants.reconcile()
        except Exception as exc:  # noqa: BLE001
            log.exception("reconcile failed: %s", type(exc).__name__)

    async def on_cleanup(self, app: web.Application) -> None:
        await self.messaging_routes.relays.close()
        self.langfuse_routes.close()
        await self.share_routes.agent.close()
        await self.skill_routes.close()
        await self.drive_routes.close()
        await self.account_routes.close()
        for task in self._bg:
            task.cancel()
        if self._bg:
            await asyncio.gather(*self._bg, return_exceptions=True)
        if self.http is not None:
            await self.http.close()
        if self.docker is not None:
            await self.docker.close()
        if self.cube is not None:
            await self.cube.close()
        await self.database.close()

    async def _reaper(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                self._forget_sso_leftovers()
                await self.store.purge_expired_sessions()
                self.langfuse_routes.purge()
                if self.tenants is not None:
                    await self.tenants.reap_idle(keep=set(self._live_ws) | self.skill_routes.active_users)
            except Exception as exc:  # noqa: BLE001
                # idle_tenants 失败发生在任何 stop 前，因此数据库故障只会跳过本轮回收。
                log.warning("reaper tick skipped: %s", type(exc).__name__)

    async def _cron_waker(self) -> None:
        """每 30 秒看一次：实例停着、定时任务快到点的用户，把实例叫起来（见 TenantManager.wake_due_cron）。"""
        while True:
            await asyncio.sleep(30)
            try:
                if self.tenants is not None:
                    await self.tenants.wake_due_cron()
            except Exception as exc:  # noqa: BLE001
                log.warning("cron wake tick skipped: %s", type(exc).__name__)


def _add_skill_routes(app: web.Application, entry: Entry, api) -> None:
    """技能市场装卸和套件动作（同一个接口）：普通版一直有，企业版开了 kits 或 skills 才有。"""
    app.router.add_post(api("/__entry/skills/{operation}"), entry.skill_routes.handle)


def _add_welcome_route(app: web.Application, entry: Entry, api) -> None:
    """首页模板（日常办公 / 学习生活 / 代码开发）：两个版本都有，企业版不要 MaaS 令牌（welcome_routes.py）。"""
    app.router.add_post(api("/__entry/welcome/{locale}"), entry.welcome_routes.handle)


def _add_connector_routes(app: web.Application, entry: Entry, api) -> None:
    """扫码 / OAuth 连接器：普通版一直有，企业版开了 connectors 才有。"""
    app.router.add_post(api("/__entry/connectors"), entry.connector_routes.handle)
    app.router.add_get(api("/__entry/connectors/{provider}/oauth/callback"), entry.connector_routes.oauth.callback)


def _add_personal_routes(app: web.Application, entry: Entry, api) -> None:
    """只有普通版（不连管理后台）才有的路由：云盘、邮箱、分享、套餐、消息平台和它们要的浏览器令牌。
    技能和连接器两组企业版按 MT_CLIENT_FEATURES 也有，首页模板两个版本都有，见 build_app。"""
    app.router.add_get(api("/__entry/browser-auth.js"), entry.browser_auth_script)
    app.router.add_post(api("/__entry/maas-auth"), entry.maas_auth_status)
    app.router.add_post(api("/__entry/langfuse/grant"), entry.langfuse_routes.issue)
    app.router.add_post(api("/__entry/langfuse/api/public/otel/v1/traces"), entry.langfuse_routes.upload)
    app.router.add_post(api("/__entry/{kind:conversation|artifact}-shares/{operation}"), entry.share_routes.handle)
    _add_skill_routes(app, entry, api)
    _add_welcome_route(app, entry, api)
    app.router.add_post(api("/__entry/plan/{operation}"), entry.plan_routes.handle)
    app.router.add_post(api("/__entry/account/{operation}"), entry.account_routes.handle)
    app.router.add_post(api("/__entry/mail"), entry.mail_routes.handle)
    _add_connector_routes(app, entry, api)
    cloud_bindings = CloudBindingRoutes(entry)
    for method in ("PUT", "GET", "DELETE"):
        app.router.add_route(method,api("/channels/uniagentgate/cloud-binding/{user_id}"),cloud_bindings.handle)
    app.router.add_get(api("/__entry/messaging/media/{id}"), entry.messaging_routes.media)
    app.router.add_post(api("/__entry/messaging/wake"), entry.messaging_routes.wake)
    app.router.add_post(api("/__entry/messaging/{operation}"), entry.messaging_routes.handle)
    app.router.add_post(api("/__entry/drive/part/{id}"), entry.drive_routes.part)
    app.router.add_get(api("/__entry/drive/files/{id}"), entry.drive_routes.download)
    app.router.add_post(api("/__entry/drive/{operation}"), entry.drive_routes.handle)


def build_app(settings: Settings = SETTINGS) -> web.Application:
    entry = Entry(settings)
    app = web.Application(
        client_max_size=64 * 1024 * 1024,
        middlewares=[origin_middleware(settings.origin_check), database_error_middleware],
    )
    path = settings.path
    api = settings.api_path
    app.router.add_get(path("/login"), entry.login_page)
    if not settings.enterprise:
        _add_personal_routes(app, entry, api)
    else:
        _add_welcome_route(app, entry, api)
        # 企业版按 MT_CLIENT_FEATURES 开放个人版的技能和连接器；以后改成管理后台下发的 clientFeatures
        features = settings.enterprise_features
        if features & {"kits", "skills"}:
            _add_skill_routes(app, entry, api)
        if "connectors" in features:
            _add_connector_routes(app, entry, api)
    app.router.add_get(api("/__entry/config"), entry.config)
    app.router.add_get(api("/__entry/health"), entry.health)
    app.router.add_get(api("/__entry/auth"), entry.auth)
    app.router.add_get(api("/__entry/me"), entry.me)
    # 前端报来的耗时（两个版本都有，见 timing_routes.py）
    app.router.add_post(api("/__entry/timing"), entry.timing_routes.handle)
    # 页面报的刷新原因、启动耗时、连接断开：两个版本都要，见 client_events.py
    app.router.add_post(api("/__entry/client-event"), entry.client_events.handle)
    app.router.add_get(api("/__entry/captcha"), entry.captcha)
    app.router.add_post(api("/__entry/send-code"), entry.send_code)
    app.router.add_post(api("/__entry/login"), entry.login)
    app.router.add_post(api("/__entry/dev-login"), entry.dev_login)
    # 企业模式（MT_UNIWORK_SERVER）才有用，个人模式回 404
    app.router.add_post(api("/__entry/select-tenant"), entry.select_tenant)
    app.router.add_get(api("/__entry/enterprise"), entry.enterprise)
    app.router.add_get(api("/__entry/usage"), entry.usage_routes.handle)  # 左下角的企业用量和个人用量
    app.router.add_post(api("/__entry/logout"), entry.logout)
    app.router.add_get(path("/logout"), entry.logout_page)
    app.router.add_get(api("/ws"), entry.ws)
    # 要在下面那条「其余全部转给实例」之前注册：路由按注册顺序匹配。
    app.router.add_get(api("/__hermes_backend/__mt_user/terminal"), entry.terminal)
    app.router.add_route("*", api("/__hermes_backend/{tail:.*}"), entry.backend)
    # 平台调用云端运行智能体（docs/企业版对接/15）；没配 MT_UNIWORK_SERVICE_SECRET 时整组回 404
    svc = ServiceApi(entry)
    runtimes = RUNTIMES_PATH
    app.router.add_get(runtimes, svc.list_runtimes)
    app.router.add_put(runtimes + "/{key}", svc.put_runtime)
    app.router.add_delete(runtimes + "/{key}", svc.delete_runtime)
    app.router.add_post(runtimes + "/{key}/restart", svc.restart_runtime)
    app.router.add_post(runtimes + "/{key}/runs", svc.start_run)
    app.router.add_get(runtimes + "/{key}/runs/{run_id}", svc.run_status)
    app.router.add_get(runtimes + "/{key}/runs/{run_id}/events", svc.run_events)
    app.router.add_post(runtimes + "/{key}/runs/{run_id}/stop", svc.stop_run)
    app.router.add_post(runtimes + "/{key}/runs/{run_id}/approval", svc.run_approval)
    app.on_startup.append(entry.on_startup)
    app.on_cleanup.append(entry.on_cleanup)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info(
        "entry starting: base=%s image=%s dev_login=%s enterprise=%s sso=%s",
        SETTINGS.base_path,
        SETTINGS.image,
        SETTINGS.dev_login,
        SETTINGS.uniwork_server or "off",
        "on" if SETTINGS.sso else "off",
    )
    web.run_app(
        build_app(),
        host="0.0.0.0",
        port=SETTINGS.listen_port,
        access_log_format='%a "%r" %s %b %Tfs',
        access_log_class=ConnectorAccessLogger,
    )


if __name__ == "__main__":
    main()
