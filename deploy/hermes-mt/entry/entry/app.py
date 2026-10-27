"""提供多租户 Entry 的登录、路由、健康检查和租户代理 HTTP 服务。"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web

from .config import SETTINGS, Settings
from .crypto import CredentialCipher, CredentialError
from .cube_api import Cube
from .db import Database, DatabaseUnavailable
from .docker_api import Docker
from .maas import Maas, MaasError
from .proxy import proxy_http, proxy_ws
from .backup import BackupJob
from .enterprise import EnterpriseSync
from .s3lite import S3Lite
from .service import ServiceApi
from .store import EnterpriseBinding, Session, Store
from .tenants import CredentialSyncError, TenantManager
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

    async def _session(self, request: web.Request) -> Session | None:
        sid = request.cookies.get(self.s.cookie_name, "")
        return await self.store.get_session(sid)

    async def _require(self, request: web.Request) -> Session:
        session = await self._session(request)
        if session is None:
            raise web.HTTPUnauthorized(text="not logged in")
        return session

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

    async def _tenant_for(self, session: Session):
        await self._touch(session.user_id)
        if self.tenants is None:
            raise RuntimeError("租户管理器尚未启动")
        tenant = await self.tenants.ensure_running(session.user_id)
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
        enterprise: EnterpriseBinding | None = None,
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
        response = web.json_response(body)
        self._set_cookie(response, login.session)
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

    async def login_page(self, request: web.Request) -> web.Response:
        html = (STATIC_DIR / "login.html").read_text(encoding="utf-8")
        return web.Response(text=html, content_type="text/html")

    async def config(self, request: web.Request) -> web.Response:
        return web.json_response({"dev": self.s.dev_login, "base": self.s.base_path, "enterprise": self.s.enterprise})

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
        return web.json_response(body)

    async def captcha(self, request: web.Request) -> web.Response:
        if self.maas is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        try:
            return web.json_response(await self.maas.captcha())
        except MaasError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)

    async def send_code(self, request: web.Request) -> web.Response:
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
        if not api_key:
            log.warning("user %s has no new plan key; keeping any stored credential", result.uid)
        else:
            log.info("user %s plan: %s", result.uid, plan.summary())
            if not (endpoint and endpoint[0]):
                log.warning("user %s: my-plan did not provide a plan base URL", result.uid)
        return await self._finish_login(
            result.uid,
            api_key,
            result.expires_at_ms,
            phone=phone,
            endpoint=endpoint,
            catalog=catalog,
            limits=limits,
        )

    async def dev_login(self, request: web.Request) -> web.Response:
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

    async def _enterprise_logout(self, user_id: str) -> None:
        """企业模式退出：吊销平台上的设备令牌（平台连不上也照常退出），绑定记成 unbound。
        这个人别的浏览器上的会话随之被拦，提示重新登录。"""
        if self.uniwork is None or await self.store.get_enterprise_binding(user_id) is None:
            return
        token = (await self.store.get_tenant_context(user_id)).api_key
        if token:
            try:
                await self.uniwork.logout(token)
            except UniworkError as exc:
                log.warning("enterprise logout of %s: revoking device token failed: %s", user_id, exc)
        await self.store.update_enterprise_access(user_id, UNBOUND)
        if self.ent is not None:
            self.ent.forget(user_id)

    async def _end_session(self, request: web.Request) -> str:
        sid = request.cookies.get(self.s.cookie_name, "")
        if not sid:
            return ""
        session = await self.store.get_session(sid)
        await self.store.delete_session(sid)
        if session:
            if self.s.enterprise:
                await self._enterprise_logout(session.user_id)
            await self.store.write_audit(session.user_id, "logout")
            return session.user_id
        return ""

    async def logout(self, request: web.Request) -> web.Response:
        await self._end_session(request)
        response = web.json_response({"ok": True})
        response.del_cookie(self.s.cookie_name, path=self.s.base_path + "/")
        return response

    async def logout_page(self, request: web.Request) -> web.Response:
        await self._end_session(request)
        response = web.HTTPFound(self.s.path("/login"))
        response.del_cookie(self.s.cookie_name, path=self.s.base_path + "/")
        return response

    async def ws(self, request: web.Request) -> web.StreamResponse:
        """聊天：hermes 自己的 /api/ws。"""
        return await self._proxy_tenant_ws(request, "/api/ws", heartbeat=None)

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
            tenant = await self._tenant_for(session)
        except DatabaseUnavailable:
            raise
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
    _BLOCKED_TAILS = ("__mt/", "api/ops/import")

    async def backend(self, request: web.Request) -> web.StreamResponse:
        session = await self._require(request)
        tail = request.match_info.get("tail", "").lstrip("/")
        normalized = tail.replace("//", "/")
        if normalized.startswith(self._BLOCKED_TAILS) or normalized in self._BLOCKED_TAILS:
            raise web.HTTPNotFound()
        reason = self._gate(session)
        if reason:
            return self._blocked(reason)
        try:
            tenant = await self._tenant_for(session)
        except DatabaseUnavailable:
            raise
        except CredentialSyncError as exc:
            log.warning("credential sync for %s failed: %s", session.user_id, type(exc).__name__)
            return web.json_response({"error": "credential_sync_failed"}, status=502)
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

    async def _reconcile(self) -> None:
        try:
            if self.tenants is not None:
                await self.tenants.reconcile()
        except Exception as exc:  # noqa: BLE001
            log.exception("reconcile failed: %s", type(exc).__name__)

    async def on_cleanup(self, app: web.Application) -> None:
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
                await self.store.purge_expired_sessions()
                if self.tenants is not None:
                    await self.tenants.reap_idle(keep=set(self._live_ws))
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


def build_app(settings: Settings = SETTINGS) -> web.Application:
    entry = Entry(settings)
    app = web.Application(
        client_max_size=64 * 1024 * 1024,
        middlewares=[origin_middleware(settings.origin_check), database_error_middleware],
    )
    path = settings.path
    app.router.add_get(path("/login"), entry.login_page)
    app.router.add_get(path("/__entry/config"), entry.config)
    app.router.add_get(path("/__entry/health"), entry.health)
    app.router.add_get(path("/__entry/auth"), entry.auth)
    app.router.add_get(path("/__entry/me"), entry.me)
    app.router.add_get(path("/__entry/captcha"), entry.captcha)
    app.router.add_post(path("/__entry/send-code"), entry.send_code)
    app.router.add_post(path("/__entry/login"), entry.login)
    app.router.add_post(path("/__entry/dev-login"), entry.dev_login)
    # 企业模式（MT_UNIWORK_SERVER）才有用，个人模式回 404
    app.router.add_post(path("/__entry/select-tenant"), entry.select_tenant)
    app.router.add_get(path("/__entry/enterprise"), entry.enterprise)
    app.router.add_post(path("/__entry/logout"), entry.logout)
    app.router.add_get(path("/logout"), entry.logout_page)
    app.router.add_get(path("/api/ws"), entry.ws)
    # 要在下面那条「其余全部转给实例」之前注册：路由按注册顺序匹配。
    app.router.add_get(path("/__hermes_backend/__mt_user/terminal"), entry.terminal)
    app.router.add_route("*", path("/__hermes_backend/{tail:.*}"), entry.backend)
    # 平台调用云端运行智能体（docs/企业版对接/15）；没配 MT_UNIWORK_SERVICE_SECRET 时整组回 404
    svc = ServiceApi(entry)
    runtimes = path("/__entry/service/v1/runtimes")
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
        "entry starting: base=%s image=%s dev_login=%s enterprise=%s",
        SETTINGS.base_path,
        SETTINGS.image,
        SETTINGS.dev_login,
        SETTINGS.uniwork_server or "off",
    )
    web.run_app(
        build_app(),
        host="0.0.0.0",
        port=SETTINGS.listen_port,
        access_log_format='%a "%r" %s %b %Tfs',
    )


if __name__ == "__main__":
    main()
