"""入口服务 HTTP 面。

路由（都挂在 MT_BASE_PATH 下，默认 /hermes）：
  GET  /login                      登录页（静态 HTML）
  GET  /__entry/config             登录页要的开关（是否 dev 模式）
  GET  /__entry/health             入口自身健康
  GET  /__entry/auth               给 Nginx auth_request 用：200 已登录 / 401 未登录
  GET  /__entry/captcha            代理 MaaS 图形验证码
  POST /__entry/send-code          代理 MaaS 短信发码
  POST /__entry/login              短信登录 → 取套餐 key → 建会话 → 后台拉起容器
  POST /__entry/dev-login          仅 MT_DEV_LOGIN=1：任意用户名直接进
  POST /__entry/logout             退出（前端 fetch 用）
  GET  /logout                     退出（地址栏直接访问，清 cookie 后回登录页）
  GET  /__entry/me                 当前登录的是谁
  GET  /__entry/badge.js           注入 SPA 的角标脚本（谁在登录 + 退出）
  GET  /api/ws                     ws 透传到该用户容器
  *    /__hermes_backend/{tail}    REST 透传到该用户容器
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

import aiohttp
from aiohttp import web

from .config import SETTINGS, Settings
from .docker_api import Docker
from .maas import Maas, MaasError
from .proxy import proxy_http, proxy_ws
from .store import Session, Store
from .tenants import TenantManager

log = logging.getLogger("entry.app")
STATIC_DIR = Path(__file__).resolve().parent / "static"


class Entry:
    def __init__(self, settings: Settings):
        self.s = settings
        self.store = Store(settings.state_db)
        # aiohttp 的客户端必须在事件循环里创建，所以这些在 on_startup 里赋值
        self.http: aiohttp.ClientSession = None  # type: ignore[assignment]
        self.docker: Docker = None  # type: ignore[assignment]
        self.maas: Maas = None  # type: ignore[assignment]
        self.tenants: TenantManager = None  # type: ignore[assignment]
        # 用户的模型 key 只在内存里留一份（容器首次建卷时要写进 .env）；不落库。
        self._keys: dict[str, str] = {}
        # 该用户套餐给的 (base_url, model)——必须用它，不能用手写的通用网关，见 maas.Plan.endpoint
        self._endpoints: dict[str, tuple[str, str]] = {}
        # 套餐里全部可选模型 [(name, base_url)]，写进 config.yaml 的 providers.<key>.models
        self._catalogs: dict[str, list[tuple[str, str]]] = {}
        self._last_touch: dict[str, float] = {}
        # 当前挂着几条 ws：只要 > 0 就算这个人在线，空闲回收不碰他的容器
        self._live_ws: dict[str, int] = {}
        self._bg: list[asyncio.Task] = []

    # ---- helpers ----------------------------------------------------------------
    def _session(self, request: web.Request) -> Session | None:
        sid = request.cookies.get(self.s.cookie_name, "")
        return self.store.get_session(sid)

    def _require(self, request: web.Request) -> Session:
        sess = self._session(request)
        if sess is None:
            raise web.HTTPUnauthorized(text="not logged in")
        return sess

    def _set_cookie(self, resp: web.Response, sess: Session) -> None:
        resp.set_cookie(
            self.s.cookie_name,
            sess.sid,
            max_age=max(0, sess.expires_at - int(time.time())),
            path=self.s.base_path + "/",
            httponly=True,
            secure=self.s.cookie_secure,
            samesite="Lax",
        )

    def _touch(self, user_id: str) -> None:
        now = time.monotonic()
        if now - self._last_touch.get(user_id, 0) > 30:
            self._last_touch[user_id] = now
            self.store.touch_tenant(user_id)

    async def _tenant_for(self, sess: Session):
        self._touch(sess.user_id)
        return await self.tenants.ensure_running(
            sess.user_id,
            self._keys.get(sess.user_id, ""),
            self._endpoints.get(sess.user_id),
            self._catalogs.get(sess.user_id),
        )

    async def _finish_login(
        self,
        user_id: str,
        api_key: str,
        upstream_expires_ms: int | None,
        phone: str = "",
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> web.Response:
        self.store.upsert_user(user_id, phone)
        if api_key:
            self._keys[user_id] = api_key
        if endpoint and endpoint[0]:
            self._endpoints[user_id] = endpoint
        if catalog:
            self._catalogs[user_id] = catalog
        sess = self.store.create_session(user_id, self.s.session_ttl_s, upstream_expires_ms)
        self.store.audit(user_id, "login", "dev" if not phone else "sms")
        # 后台预热容器，登录响应不等它
        self._bg.append(asyncio.create_task(self._warm(user_id)))
        resp = web.json_response({"ok": True, "redirect": self.s.base_path + "/", "user_id": user_id, "has_key": bool(api_key)})
        self._set_cookie(resp, sess)
        return resp

    async def _warm(self, user_id: str) -> None:
        try:
            await self.tenants.ensure_running(
                user_id,
                self._keys.get(user_id, ""),
                self._endpoints.get(user_id),
                self._catalogs.get(user_id),
            )
        except Exception:  # noqa: BLE001
            log.exception("warm-up of tenant %s failed", user_id)

    # ---- handlers: pages / meta ------------------------------------------------
    async def login_page(self, request: web.Request) -> web.Response:
        html = (STATIC_DIR / "login.html").read_text(encoding="utf-8")
        return web.Response(text=html, content_type="text/html")

    async def config(self, request: web.Request) -> web.Response:
        return web.json_response({"dev": self.s.dev_login, "base": self.s.base_path})

    async def health(self, request: web.Request) -> web.Response:
        return web.json_response(
            {"ok": True, "tenants": self.store.all_tenant_states(), "live_ws": dict(self._live_ws)}
        )

    async def auth(self, request: web.Request) -> web.Response:
        sess = self._session(request)
        if sess is None:
            return web.Response(status=401, text="unauthorized")
        return web.Response(status=200, headers={"X-MT-User": sess.user_id})

    async def me(self, request: web.Request) -> web.Response:
        sess = self._require(request)
        states = {u: (st, ts) for u, st, ts in self.store.all_tenant_states()}
        st = states.get(sess.user_id, ("none", 0))
        return web.json_response(
            {
                "user_id": sess.user_id,
                "display": self.store.display_name(sess.user_id) or sess.user_id,
                "tenant_state": st[0],
                "last_seen_at": st[1],
            }
        )

    async def badge_js(self, request: web.Request) -> web.Response:
        """注入到 SPA 里的一小段脚本：右下角显示「当前登录的是谁」+ 退出按钮。

        ★ 由 Nginx 的 sub_filter 插进 index.html，**前端源码与构建产物一个字节不动**。
        前端是 hermes 原生 SPA，它不知道入口的存在，界面上不会有任何跟我们登录体系
        相关的元素，所以只能从外面贴一个。
        """
        js = (STATIC_DIR / "badge.js").read_text(encoding="utf-8").replace("__BASE__", self.s.base_path)
        return web.Response(
            text=js,
            content_type="application/javascript",
            charset="utf-8",
            headers={"Cache-Control": "no-cache"},
        )

    # ---- handlers: login --------------------------------------------------------------
    async def captcha(self, request: web.Request) -> web.Response:
        try:
            return web.json_response(await self.maas.captcha())
        except MaasError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)

    async def send_code(self, request: web.Request) -> web.Response:
        body = await request.json()
        try:
            data = await self.maas.send_code(str(body.get("phone", "")), str(body.get("captchaCode", "")), str(body.get("captchaId", "")))
            return web.json_response(data)
        except MaasError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)

    async def login(self, request: web.Request) -> web.Response:
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
            log.warning("user %s has no plan key (no plan = no credentials)", result.uid)
        else:
            # 只记形状，不记 key
            log.info("user %s plan: %s", result.uid, plan.summary())
            if not (endpoint and endpoint[0]):
                log.warning(
                    "user %s: my-plan 没给 base_url，退回 MT_MODEL_BASE_URL；"
                    "套餐 key 在通用网关上会被回 1004（TokenPlan 专用路径）",
                    result.uid,
                )
        return await self._finish_login(
            result.uid, api_key, result.expires_at_ms, phone=phone, endpoint=endpoint, catalog=catalog
        )

    async def dev_login(self, request: web.Request) -> web.Response:
        if not self.s.dev_login:
            raise web.HTTPNotFound()
        body = await request.json()
        user = str(body.get("user", "")).strip()
        if not user:
            return web.json_response({"error": "缺少用户名"}, status=400)
        return await self._finish_login(user, self.s.dev_api_key, None)

    def _end_session(self, request: web.Request) -> str:
        sid = request.cookies.get(self.s.cookie_name, "")
        if not sid:
            return ""
        sess = self.store.get_session(sid)
        self.store.delete_session(sid)
        if sess:
            self.store.audit(sess.user_id, "logout")
            return sess.user_id
        return ""

    async def logout(self, request: web.Request) -> web.Response:
        self._end_session(request)
        resp = web.json_response({"ok": True})
        resp.del_cookie(self.s.cookie_name, path=self.s.base_path + "/")
        return resp

    async def logout_page(self, request: web.Request) -> web.Response:
        """``GET <base>/logout`` —— 浏览器地址栏直接可用的退出。

        ★ 前端是 hermes 原生 SPA，它不知道入口的存在，界面上不会有「退出」按钮；
        没有这条 GET 路由，用户就只能自己清 cookie 或找人去数据库删会话。
        """
        self._end_session(request)
        resp = web.HTTPFound(self.s.path("/login"))
        resp.del_cookie(self.s.cookie_name, path=self.s.base_path + "/")
        return resp

    # ---- handlers: passthrough --------------------------------------------------------
    async def ws(self, request: web.Request) -> web.StreamResponse:
        sess = self._require(request)
        try:
            tenant = await self._tenant_for(sess)
        except Exception as exc:  # noqa: BLE001
            log.exception("tenant for %s not ready", sess.user_id)
            raise web.HTTPBadGateway(text=f"tenant not ready: {type(exc).__name__}")
        # 连接期间登记在册（回收线程据此跳过），每帧再打点让断开后的计时从最后一帧算起
        user = sess.user_id
        self._live_ws[user] = self._live_ws.get(user, 0) + 1
        try:
            return await proxy_ws(request, self.s, self.http, tenant, on_activity=lambda: self._touch(user))
        finally:
            remaining = self._live_ws.get(user, 1) - 1
            if remaining > 0:
                self._live_ws[user] = remaining
            else:
                self._live_ws.pop(user, None)
            self.store.touch_tenant(user)  # 断开这一刻起算闲置

    async def backend(self, request: web.Request) -> web.StreamResponse:
        sess = self._require(request)
        try:
            tenant = await self._tenant_for(sess)
        except Exception as exc:  # noqa: BLE001
            log.exception("tenant for %s not ready", sess.user_id)
            return web.json_response({"error": "tenant_not_ready", "detail": type(exc).__name__}, status=502)
        return await proxy_http(request, self.s, self.http, tenant, request.match_info.get("tail", ""))

    # ---- lifecycle ------------------------------------------------------------------------
    async def on_startup(self, app: web.Application) -> None:
        self.http = aiohttp.ClientSession()
        self.docker = Docker(self.s.docker_sock)
        self.maas = Maas(self.s, self.http)
        self.tenants = TenantManager(self.s, self.docker, self.store, self.http)
        # reconcile 放后台：它要逐个 stop 容器，租户多时是几十秒，挡在这里 = 同样长的 502 窗口
        self._bg.append(asyncio.create_task(self._reconcile()))
        self._bg.append(asyncio.create_task(self._reaper()))

    async def _reconcile(self) -> None:
        try:
            await self.tenants.reconcile()
        except Exception:  # noqa: BLE001
            log.exception("reconcile failed (docker socket reachable?)")

    async def on_cleanup(self, app: web.Application) -> None:
        for t in self._bg:
            t.cancel()
        await self.http.close()
        await self.docker.close()

    async def _reaper(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                self.store.purge_expired_sessions()
                await self.tenants.reap_idle(keep=set(self._live_ws))
            except Exception:  # noqa: BLE001
                log.exception("reaper tick failed")


def build_app(settings: Settings = SETTINGS) -> web.Application:
    entry = Entry(settings)
    app = web.Application(client_max_size=64 * 1024 * 1024)
    p = settings.path
    app.router.add_get(p("/login"), entry.login_page)
    app.router.add_get(p("/__entry/config"), entry.config)
    app.router.add_get(p("/__entry/health"), entry.health)
    app.router.add_get(p("/__entry/auth"), entry.auth)
    app.router.add_get(p("/__entry/me"), entry.me)
    app.router.add_get(p("/__entry/badge.js"), entry.badge_js)
    app.router.add_get(p("/__entry/captcha"), entry.captcha)
    app.router.add_post(p("/__entry/send-code"), entry.send_code)
    app.router.add_post(p("/__entry/login"), entry.login)
    app.router.add_post(p("/__entry/dev-login"), entry.dev_login)
    app.router.add_post(p("/__entry/logout"), entry.logout)
    app.router.add_get(p("/logout"), entry.logout_page)
    app.router.add_get(p("/api/ws"), entry.ws)
    app.router.add_route("*", p("/__hermes_backend/{tail:.*}"), entry.backend)
    app.on_startup.append(entry.on_startup)
    app.on_cleanup.append(entry.on_cleanup)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info("entry starting: base=%s image=%s dev_login=%s", SETTINGS.base_path, SETTINGS.image, SETTINGS.dev_login)
    web.run_app(build_app(), host="0.0.0.0", port=SETTINGS.listen_port, access_log_format='%a "%r" %s %b %Tfs')


if __name__ == "__main__":
    main()
