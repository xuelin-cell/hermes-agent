"""本机联调用的假统一登录网关：只做云端用到的那几个接口，形状照《统一登录方案》v2.3。不上任何服务器。

- ``GET  /login/``：登录页。不发短信，直接列出 accounts.json 里的测试账号，点一个就登录（种 Cookie ``yj_token``）。
- ``GET  /app/gateway/access/management/api/validate``：nginx 的 auth_request。登录了回 200 和四个身份头。
- ``GET  /app/gateway/sso/me``、``POST /app/gateway/sso/logout``：页面用（方案 11.6、11.7）。
- ``POST /app/gateway/sso/internal/maas-credential``：12.4，个人账号的后端按 sid 取 MaaS 令牌（要 X-Internal-Token）。
- ``GET  /fake/my-plan``：假的 MaaS my-plan，认 12.4 发的令牌，给一把固定的模型 key（个人版入口的 MT_MYPLAN_URL 指这里）。

用法见同目录 README.md。只依赖 aiohttp。
"""

from __future__ import annotations

import argparse
import html
import json
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

from aiohttp import web

COOKIE = "yj_token"
SESSION_TTL_MS = 7 * 86400 * 1000


class Gateway:
    def __init__(self, accounts: list[dict], credential_token: str, plan: dict):
        self.accounts = accounts
        self.credential_token = credential_token
        self.plan = plan
        self.sessions: dict[str, dict] = {}  # sid → 账号
        self.maas_tokens: dict[str, str] = {}  # 12.4 发的令牌 → uid

    # ---- 会话 --------------------------------------------------------------------------

    def current(self, request: web.Request) -> tuple[str, dict] | None:
        sid = request.cookies.get(COOKIE, "")
        account = self.sessions.get(sid)
        if account is None or account["expiresAt"] < time.time() * 1000:
            return None
        return sid, account

    @staticmethod
    def safe_redirect(target: str) -> str:
        return target if target.startswith("/") and not target.startswith("//") and "\\" not in target else "/agents/"

    # ---- 登录页 ------------------------------------------------------------------------

    async def login_page(self, request: web.Request) -> web.Response:
        target = self.safe_redirect(request.query.get("redirect_uri", "/agents/"))
        signed_in = self.current(request)
        if signed_in and not request.query.get("prompt"):
            raise web.HTTPFound(target)  # 方案第 05 节：有有效会话、没带 prompt 就直接回跳
        rows = []
        for index, account in enumerate(self.accounts):
            label = account["name"]
            if account["accountType"] == "enterprise":
                label += f" · {account.get('tenantName', '')}"
            else:
                label += f"（个人 {account.get('phone', '')[:3]}****{account.get('phone', '')[-4:]}）"
            rows.append(
                f'<form method="post" action="/login/select"><input type="hidden" name="i" value="{index}">'
                f'<input type="hidden" name="redirect_uri" value="{html.escape(target)}">'
                f'<button type="submit">{html.escape(label)}</button></form>'
            )
        body = (
            "<!doctype html><meta charset=utf-8><title>假统一登录</title>"
            "<style>body{font:14px system-ui;max-width:420px;margin:10vh auto}button{display:block;width:100%;"
            "margin:6px 0;padding:10px;text-align:left;cursor:pointer}</style>"
            "<h1>假统一登录（本机联调）</h1><p>选一个账号登录：</p>" + "".join(rows)
        )
        return web.Response(text=body, content_type="text/html")

    async def select(self, request: web.Request) -> web.Response:
        form = await request.post()
        try:
            account = self.accounts[int(str(form.get("i", "")))]
        except (ValueError, IndexError):
            raise web.HTTPBadRequest(text="unknown account")
        previous = request.cookies.get(COOKIE, "")
        self.sessions.pop(previous, None)  # 切换账号：旧会话作废，整站只有一个当前账号
        sid = secrets.token_hex(16)
        self.sessions[sid] = {**account, "expiresAt": int(time.time() * 1000) + SESSION_TTL_MS}
        response = web.HTTPFound(self.safe_redirect(str(form.get("redirect_uri", "/agents/"))))
        response.set_cookie(COOKIE, sid, httponly=True, path="/", samesite="Lax")  # 本机是 http，不带 Secure
        return response

    # ---- 给 nginx 和页面的接口 ------------------------------------------------------------

    async def validate(self, request: web.Request) -> web.Response:
        signed_in = self.current(request)
        if signed_in is None:
            return web.Response(status=401, headers={"X-Auth-Error": "LOGIN_REQUIRED"})
        sid, account = signed_in
        return web.Response(status=200, headers={
            "X-Uid": account["accountId"], "X-Account-Type": account["accountType"],
            "X-Tenant-Id": account.get("tenantId", ""), "X-Sid": sid,
        })

    async def me(self, request: web.Request) -> web.Response:
        signed_in = self.current(request)
        if signed_in is None:
            return web.json_response({"code": 401, "error": "LOGIN_REQUIRED", "data": None}, status=401)
        sid, account = signed_in
        phone = account.get("phone", "")
        data = {"sid": sid, "accountType": account["accountType"], "accountId": account["accountId"],
                "name": account["name"], "phoneMasked": f"{phone[:3]}****{phone[-4:]}" if phone else "",
                "expiresAt": account["expiresAt"]}
        if account["accountType"] == "enterprise":
            data.update(tenantId=account.get("tenantId", ""), tenantName=account.get("tenantName", ""))
        return web.json_response({"code": 0, "msg": "ok", "data": data})

    async def logout(self, request: web.Request) -> web.Response:
        self.sessions.pop(request.cookies.get(COOKIE, ""), None)
        response = web.json_response({"code": 0, "msg": "ok", "data": None})
        response.del_cookie(COOKIE, path="/")
        return response

    # ---- 12.4 和假 my-plan ----------------------------------------------------------------

    async def maas_credential(self, request: web.Request) -> web.Response:
        if request.headers.get("X-Internal-Token") != self.credential_token:
            return web.json_response({"code": 401, "error": "INTERNAL_TOKEN_INVALID", "data": None}, status=401)
        sid = str((await request.json()).get("sid") or "")
        account = self.sessions.get(sid)
        if account is None:
            return web.json_response({"code": 401, "error": "LOGIN_REQUIRED", "data": None}, status=401)
        if account["accountType"] != "personal":
            return web.json_response({"code": 403, "error": "ACCOUNT_NOT_ALLOWED", "data": None}, status=403)
        token = "fake-maas-" + secrets.token_hex(12)
        self.maas_tokens[token] = account["accountId"]
        return web.json_response({"code": 0, "msg": "ok", "data": {
            "uid": account["accountId"], "phone": account.get("phone", ""), "token": token,
            "expiresAt": account["expiresAt"]}})

    async def my_plan(self, request: web.Request) -> web.Response:
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if token not in self.maas_tokens:
            return web.json_response({"code": 500, "msg": "token invalid"}, status=500)  # 上游对坏令牌就是回 500
        return web.json_response({"code": 0, "data": {"apiKey": self.plan["apiKey"],
                                                      "models": json.dumps(self.plan["models"])}})


async def _login_slash(request: web.Request) -> web.Response:
    raise web.HTTPFound("/login/?" + urlencode(request.query))


def build_app(gateway: Gateway) -> web.Application:
    app = web.Application()
    app.router.add_get("/login/", gateway.login_page)
    app.router.add_get("/login", _login_slash)
    app.router.add_post("/login/select", gateway.select)
    app.router.add_get("/app/gateway/access/management/api/validate", gateway.validate)
    app.router.add_get("/app/gateway/sso/me", gateway.me)
    app.router.add_post("/app/gateway/sso/logout", gateway.logout)
    app.router.add_post("/app/gateway/sso/internal/maas-credential", gateway.maas_credential)
    app.router.add_get("/fake/my-plan", gateway.my_plan)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--accounts", type=Path, required=True, help="测试账号和假套餐，见 accounts.example.json")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=18096)
    args = parser.parse_args()
    config = json.loads(args.accounts.read_text(encoding="utf-8"))
    gateway = Gateway(config["accounts"], config["credentialToken"], config["plan"])
    web.run_app(build_app(gateway), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
