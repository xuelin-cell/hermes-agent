"""提供多租户 Entry 的登录、路由、健康检查和租户代理 HTTP 服务。"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

import aiohttp
from aiohttp import web

from .config import SETTINGS, Settings
from .crypto import CredentialCipher
from .db import Database, DatabaseUnavailable
from .docker_api import Docker
from .maas import Maas, MaasError
from .proxy import proxy_http, proxy_ws
from .store import Session, Store
from .tenants import CredentialSyncError, TenantManager

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
            CredentialCipher(settings.credential_key, settings.credential_key_id),
        )
        # aiohttp 客户端必须在事件循环中创建，因此在 on_startup 里赋值。
        self.http: aiohttp.ClientSession | None = None
        self.docker: Docker | None = None
        self.maas: Maas | None = None
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
        return await self.tenants.ensure_running(session.user_id)

    async def _finish_login(
        self,
        user_id: str,
        api_key: str,
        upstream_expires_ms: int | None,
        phone: str = "",
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> web.Response:
        login = await self.store.finish_login(
            user_id=user_id,
            phone=phone,
            api_key=api_key,
            endpoint=endpoint,
            catalog=catalog,
            ttl_s=self.s.session_ttl_s,
            upstream_expires_at_ms=upstream_expires_ms,
            login_method="sms" if phone else "dev",
        )
        # 登录事务提交后后台预热；预热失败不撤销已经建立的平台登录。
        self._bg.append(asyncio.create_task(self._warm(user_id)))
        response = web.json_response(
            {
                "ok": True,
                "redirect": self.s.base_path + "/",
                "user_id": user_id,
                "has_key": login.has_api_key,
            }
        )
        self._set_cookie(response, login.session)
        return response

    async def _warm(self, user_id: str) -> None:
        try:
            if self.tenants is None:
                raise RuntimeError("租户管理器尚未启动")
            await self.tenants.ensure_running(user_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("warm-up of tenant %s failed: %s", user_id, type(exc).__name__)

    async def login_page(self, request: web.Request) -> web.Response:
        html = (STATIC_DIR / "login.html").read_text(encoding="utf-8")
        return web.Response(text=html, content_type="text/html")

    async def config(self, request: web.Request) -> web.Response:
        return web.json_response({"dev": self.s.dev_login, "base": self.s.base_path})

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
        if session is None:
            return web.Response(status=401, text="unauthorized")
        return web.Response(status=200, headers={"X-MT-User": session.user_id})

    async def me(self, request: web.Request) -> web.Response:
        session = await self._require(request)
        states = {user: (state, timestamp) for user, state, timestamp in await self.store.all_tenant_states()}
        state = states.get(session.user_id, ("none", 0))
        return web.json_response(
            {
                "user_id": session.user_id,
                "display": await self.store.display_name(session.user_id) or session.user_id,
                "tenant_state": state[0],
                "last_seen_at": state[1],
            }
        )

    async def badge_js(self, request: web.Request) -> web.Response:
        """返回由 Nginx 注入原生 SPA 的登录用户角标脚本。"""
        javascript = (STATIC_DIR / "badge.js").read_text(encoding="utf-8").replace(
            "__BASE__",
            self.s.base_path,
        )
        return web.Response(
            text=javascript,
            content_type="application/javascript",
            charset="utf-8",
            headers={"Cache-Control": "no-cache"},
        )

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
        )

    async def dev_login(self, request: web.Request) -> web.Response:
        if not self.s.dev_login:
            raise web.HTTPNotFound()
        body = await request.json()
        user = str(body.get("user", "")).strip()
        if not user:
            return web.json_response({"error": "缺少用户名"}, status=400)
        return await self._finish_login(user, self.s.dev_api_key, None)

    async def _end_session(self, request: web.Request) -> str:
        sid = request.cookies.get(self.s.cookie_name, "")
        if not sid:
            return ""
        session = await self.store.get_session(sid)
        await self.store.delete_session(sid)
        if session:
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
        session = await self._require(request)
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
        self._live_ws[user_id] = self._live_ws.get(user_id, 0) + 1
        if self.http is None:
            raise web.HTTPServiceUnavailable(text="entry not ready")
        try:
            return await proxy_ws(
                request,
                self.s,
                self.http,
                tenant,
                on_activity=lambda: self._touch(user_id),
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

    async def backend(self, request: web.Request) -> web.StreamResponse:
        session = await self._require(request)
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
            self.docker = Docker(self.s.docker_sock)
            self.maas = Maas(self.s, self.http)
            self.tenants = TenantManager(self.s, self.docker, self.store, self.http)
        except Exception:
            if self.http is not None:
                await self.http.close()
            await self.database.close()
            raise
        self._bg.append(asyncio.create_task(self._reconcile()))
        self._bg.append(asyncio.create_task(self._reaper()))

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


def build_app(settings: Settings = SETTINGS) -> web.Application:
    entry = Entry(settings)
    app = web.Application(
        client_max_size=64 * 1024 * 1024,
        middlewares=[database_error_middleware],
    )
    path = settings.path
    app.router.add_get(path("/login"), entry.login_page)
    app.router.add_get(path("/__entry/config"), entry.config)
    app.router.add_get(path("/__entry/health"), entry.health)
    app.router.add_get(path("/__entry/auth"), entry.auth)
    app.router.add_get(path("/__entry/me"), entry.me)
    app.router.add_get(path("/__entry/badge.js"), entry.badge_js)
    app.router.add_get(path("/__entry/captcha"), entry.captcha)
    app.router.add_post(path("/__entry/send-code"), entry.send_code)
    app.router.add_post(path("/__entry/login"), entry.login)
    app.router.add_post(path("/__entry/dev-login"), entry.dev_login)
    app.router.add_post(path("/__entry/logout"), entry.logout)
    app.router.add_get(path("/logout"), entry.logout_page)
    app.router.add_get(path("/api/ws"), entry.ws)
    app.router.add_route("*", path("/__hermes_backend/{tail:.*}"), entry.backend)
    app.on_startup.append(entry.on_startup)
    app.on_cleanup.append(entry.on_cleanup)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info(
        "entry starting: base=%s image=%s dev_login=%s",
        SETTINGS.base_path,
        SETTINGS.image,
        SETTINGS.dev_login,
    )
    web.run_app(
        build_app(),
        host="0.0.0.0",
        port=SETTINGS.listen_port,
        access_log_format='%a "%r" %s %b %Tfs',
    )


if __name__ == "__main__":
    main()
