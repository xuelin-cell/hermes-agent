"""测试用的假 UNIWORK 企业管理平台：只做入口用到的几个 /api/client 接口，返回形状照平台的 api_client.py。

- 短信码 ``246810`` 才算对，别的回元景的业务错误（code≠0）。
- 成员关系在 ``members[(手机号, 企业编号)]`` 里，值是平台的访问状态（active / pending / disabled …），测试里可以随时改。
- 同一个（成员, deviceId）只留一个有效令牌：重新登录吊销旧的。
"""

from __future__ import annotations

import secrets

from aiohttp import web
from aiohttp.test_utils import TestServer

SMS_CODE = "246810"


class FakePlatform:
    def __init__(self) -> None:
        self.tenants = {"T1": {"id": "tid-1", "name": "一号企业"}, "T2": {"id": "tid-2", "name": "二号企业"}}
        self.members: dict[tuple[str, str], str] = {}
        self.tokens: dict[str, tuple[str, str, str]] = {}  # 令牌 → (手机号, 企业编号, deviceId)
        self.revoked: set[str] = set()
        self.tickets: dict[str, str] = {}  # 票据 → 手机号
        self.requests: list[tuple[str, dict]] = []
        self.server: TestServer | None = None

    @property
    def url(self) -> str:
        assert self.server is not None
        return str(self.server.make_url("")).rstrip("/")

    async def start(self) -> "FakePlatform":
        app = web.Application()
        app.router.add_post("/api/client/sms-login", self.sms_login)
        app.router.add_post("/api/client/select-tenant", self.select_tenant)
        app.router.add_get("/api/client/policy", self.policy)
        app.router.add_post("/api/client/logout", self.logout)
        self.server = TestServer(app)
        await self.server.start_server()
        return self

    async def close(self) -> None:
        if self.server is not None:
            await self.server.close()

    # ---- 平台的样子 --------------------------------------------------------------

    def _code_of(self, tenant_id: str) -> str:
        return next((code for code, t in self.tenants.items() if t["id"] == tenant_id), "")

    def build_policy(self, phone: str, code: str) -> dict:
        status = self.members.get((phone, code), "not_member")
        allowed = status == "active"
        policy = {
            "revision": f"rev-{code}-{status}",
            "enterprise": {"name": self.tenants[code]["name"], "tenantId": self.tenants[code]["id"],
                           "tenantCode": code, "serverUrl": self.url},
            "member": {"id": f"m-{phone[-4:]}", "name": f"用户{phone[-4:]}", "status": "在职" if allowed else status},
            "access": {"allowed": allowed, "reason": "" if allowed else status},
        }
        if allowed:
            policy["models"] = {
                "models": [
                    {"id": "uniwork-glm", "display_name": "GLM", "api_key": "", "base_url": f"{self.url}/v1",
                     "model": "glm-5.2", "context_window": 240000},
                    {"id": "uniwork-ds", "display_name": "DeepSeek", "api_key": "", "base_url": f"{self.url}/v1",
                     "model": "deepseek-v4-flash", "context_window": 300000},
                ],
                "main_model_id": "uniwork-ds",
                "fast_model_id": "",
            }
        else:
            policy["models"] = {"models": [], "main_model_id": "", "fast_model_id": ""}
        return policy

    def _enroll(self, phone: str, code: str, device: str) -> dict:
        if (phone, code) not in self.members:
            self.members[(phone, code)] = "pending"  # 不是成员：提交加入申请
        for token, (p, c, d) in list(self.tokens.items()):
            if (p, c, d) == (phone, code, device):
                self.revoked.add(token)
                del self.tokens[token]
        token = "dev_" + secrets.token_hex(12)
        self.tokens[token] = (phone, code, device)
        status = self.members[(phone, code)]
        return {"status": status, "deviceToken": token, "serverUrl": self.url, "tenantId": self.tenants[code]["id"],
                "tenantCode": code, "tenantName": self.tenants[code]["name"], "policy": self.build_policy(phone, code)}

    @staticmethod
    def _login_data(phone: str) -> dict:
        return {"uid": f"uid-{phone}", "token": "yj-jwt", "username": phone, "expires_in": 7 * 86400}

    def _token(self, request: web.Request) -> tuple[str, str, str]:
        auth = request.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if token not in self.tokens:
            raise web.HTTPUnauthorized(text='{"detail": "设备未绑定企业或登录已失效，请重新登录"}',
                                       content_type="application/json")
        return self.tokens[token]

    # ---- 接口 -----------------------------------------------------------------

    async def sms_login(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.requests.append(("sms-login", body))
        phone = body["phone"]
        if body.get("smsCode") != SMS_CODE:
            return web.json_response({"code": 1001, "msg": "验证码错误或已过期"})
        result = {"code": 0, "msg": "ok", "data": self._login_data(phone)}
        wanted = str(body.get("tenantCode") or "")
        choices = [code for (p, code) in self.members if p == phone]
        if wanted and wanted in self.tenants:
            result["enterprise"] = self._enroll(phone, wanted, body["deviceId"])
            return web.json_response(result)
        if not wanted and len(choices) == 1:
            result["enterprise"] = self._enroll(phone, choices[0], body["deviceId"])
            return web.json_response(result)
        ticket = "tk_" + secrets.token_hex(8)
        self.tickets[ticket] = phone
        status = "tenant_not_found" if wanted else "choose_tenant" if choices else "tenant_required"
        result["enterprise"] = {
            "status": status, "loginTicket": ticket, "tenantCode": wanted,
            "tenants": [{"tenantId": self.tenants[c]["id"], "tenantCode": c, "tenantName": self.tenants[c]["name"],
                         "memberName": f"用户{phone[-4:]}", "memberStatus": "在职", "extra": "x"} for c in choices],
        }
        return web.json_response(result)

    async def select_tenant(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.requests.append(("select-tenant", body))
        phone = self.tickets.get(body.get("loginTicket", ""))
        if phone is None:
            return web.json_response({"detail": "登录已超时，请重新获取验证码"}, status=401)
        code = self._code_of(body["tenantId"]) if body.get("tenantId") else str(body.get("tenantCode") or "")
        if code not in self.tenants:
            return web.json_response({"detail": "找不到这个企业编号，请向企业管理员确认"}, status=404)
        del self.tickets[body["loginTicket"]]
        return web.json_response({"code": 0, "msg": "ok", "data": self._login_data(phone),
                                  "enterprise": self._enroll(phone, code, body["deviceId"])})

    async def policy(self, request: web.Request) -> web.Response:
        phone, code, _ = self._token(request)
        return web.json_response(self.build_policy(phone, code))

    async def logout(self, request: web.Request) -> web.Response:
        auth = request.headers.get("Authorization", "")
        self._token(request)
        token = auth[7:]
        self.revoked.add(token)
        del self.tokens[token]
        return web.json_response({"ok": True})
