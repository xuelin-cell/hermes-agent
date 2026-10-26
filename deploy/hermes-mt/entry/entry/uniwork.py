"""企业模式：UNIWORK 企业管理平台的客户端接口（``/api/client/*``）。

为什么这样接，见 docs/企业版对接/14-云端版接入UNIWORK企业管理平台.md。契约以平台代码为准
（UniClaw 仓库 uniwork_client 分支的 ``libs/uniwork_admin/server/uniwork_admin/api_client.py``）：

- 短信登录交给平台：平台自己去元景校验短信码（码只能用一次，入口不能再调元景）。返回值是元景的原样结果
  （``code`` / ``msg`` / ``data``），外加 ``enterprise``。``code≠0`` 是元景的错误，原样给用户看。
- ``enterprise`` 有两种：选定了企业 = 设备令牌 + 状态 + 策略；还要选企业 = 一次性的 ``loginTicket`` + 企业列表，
  入口拿票据调 select-tenant，不用再收一次短信。
- **被拦的成员（待审核、停用、没席位……）也拿得到令牌**，原因写在 ``status`` 和 ``policy.access`` 里。
- 一个云端用户 = 平台上的一个设备。同一个（成员, deviceId）只留一个有效令牌，重新登录会吊销旧的，
  所以 deviceId 必须稳定。入口登录前还不知道 uid，只能用手机号派生。
- 令牌失效（在别处重新登录、被管理员重置、已退出、人已不在企业）时平台回 401。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from .config import Settings
from .maas import LoginResult, MaasError, Plan, parse_login

log = logging.getLogger("entry.uniwork")

# 平台后台的设备列表按 platform 区分云端和桌面端
PLATFORM = "cloud"
APP_VERSION = "hermes-cloud"
# 登录要等平台调完元景（平台那头的超时是 30 秒）
LOGIN_TIMEOUT_S = 40
# 还要选企业：列出所属企业让用户选 / 没有所属企业，让用户填编号 / 填的编号不对
CHOOSE_STATES = frozenset({"choose_tenant", "tenant_required", "tenant_not_found"})
ACTIVE = "active"
# 设备令牌已失效，要重新登录（平台的拦截原因里没有这一项，是入口自己的）
UNBOUND = "unbound"
# 拦截原因的说明，照平台 api_client.py 的 ACCESS_MESSAGES
ACCESS_MESSAGES = {
    "pending": "你的加入申请还在等待管理员审批",
    "not_member": "你的加入申请还在等待管理员审批",
    "rejected": "你的加入申请未通过，请联系企业管理员",
    "disabled": "你的账号已被企业管理员停用",
    "no_seat": "你还没有分配企业席位，请联系管理员",
    "tenant_suspended": "企业的 UNIWORK 服务已停用",
    UNBOUND: "企业登录已失效（可能在别处重新登录、被管理员重置或已退出），请重新登录",
}


class UniworkError(Exception):
    """平台没给出可用的结果。``status`` 是入口回给浏览器的状态码：401 / 403 / 404 照平台的，其余一律 502。"""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def user_id_for(tenant_id: str, uid: str) -> str:
    """企业模式下入口里的用户 ID：按企业隔离，同一个人在不同企业里是不同的用户（实例、数据都分开）。

    带冒号，和个人模式的元景 uid 不会撞；容器名、卷名另按摘要算（tenants.tenant_slug / cube_volume_name）。
    """
    return f"ent:{tenant_id}:{uid}"


def device_id(phone: str) -> str:
    """这个手机号在平台上的云端设备号：同一个人每次登录都一样。"""
    digits = "".join(ch for ch in phone if ch.isdigit())
    return "cloud-" + hashlib.sha256(digits.encode("utf-8")).hexdigest()[:16]


def access_status(policy: dict, status: str = ACTIVE) -> str:
    """``active`` = 放行，其余是拦截原因。登录给的 status 和策略里的 access，有一个说不行就不行。"""
    if status and status != ACTIVE:
        return status
    access = policy.get("access") if isinstance(policy.get("access"), dict) else {}
    if access.get("allowed") is False:
        return str(access.get("reason") or "not_member")
    return ACTIVE


def plan_of(policy: dict, device_token: str) -> Plan | None:
    """策略里的模型清单换成入口现有的格式（和个人套餐的 my-plan 同一种条目：id / model / base_url / context_window）。

    被拦的成员策略里没有模型，返回 None。
    """
    models = policy.get("models") if isinstance(policy.get("models"), dict) else {}
    entries = [m for m in models.get("models") or [] if isinstance(m, dict)]
    if not entries:
        return None
    return Plan(api_key=device_token, models=entries, main_model_id=str(models.get("main_model_id") or ""))


def member_of(policy: dict) -> tuple[str, str]:
    """(成员编号, 成员名字)。"""
    member = policy.get("member") if isinstance(policy.get("member"), dict) else {}
    return str(member.get("id") or ""), str(member.get("name") or "")


@dataclass
class Binding:
    """登录选定了一个企业：成员身份、设备令牌和策略。"""

    login: LoginResult
    device_token: str
    status: str
    tenant_id: str
    tenant_code: str
    tenant_name: str
    policy: dict = field(default_factory=dict)

    @property
    def access(self) -> str:
        return access_status(self.policy, self.status)


@dataclass
class Choice:
    """还要选企业：一次性票据和这个手机号所属的企业。"""

    status: str
    ticket: str
    tenant_code: str
    tenants: list[dict]


def _detail(data: Any) -> str:
    """平台的报错文字：FastAPI 的 ``detail``、模型代理的 ``error.message``，或元景的 ``msg``。"""
    if not isinstance(data, dict):
        return ""
    detail = data.get("detail")
    if isinstance(detail, str):
        return detail
    error = data.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"]
    return str(data.get("msg") or "")


class Uniwork:
    def __init__(self, settings: Settings, session: aiohttp.ClientSession):
        self.base = settings.uniwork_server
        self.http = session
        self.timeout = aiohttp.ClientTimeout(total=settings.upstream_timeout_s)

    async def _call(self, method: str, path: str, *, body: Any = None, token: str = "",
                    timeout_s: float | None = None) -> dict:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        timeout = aiohttp.ClientTimeout(total=timeout_s) if timeout_s else self.timeout
        try:
            async with self.http.request(method, self.base + path, json=body, headers=headers,
                                         timeout=timeout) as resp:
                text = await resp.text()
                try:
                    data = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    data = None
                if resp.status >= 400:
                    message = _detail(data) or f"企业管理平台返回 HTTP {resp.status}"
                    log.warning("uniwork %s %s -> %s %s", method, path, resp.status, message[:200])
                    raise UniworkError(message, status=resp.status if resp.status in (401, 403, 404) else 502)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.warning("uniwork %s %s network error: %s", method, path, type(exc).__name__)
            raise UniworkError(f"企业管理平台暂时连不上（{type(exc).__name__}）") from exc
        if not isinstance(data, dict):
            raise UniworkError("企业管理平台返回的不是 JSON 对象")
        return data

    @staticmethod
    def _outcome(data: dict) -> Binding | Choice:
        if data.get("code") not in (0, "0"):
            # 元景的业务错误（验证码错、过期……），原样给用户看
            raise UniworkError(str(data.get("msg") or "登录失败"), status=401)
        enterprise = data.get("enterprise") if isinstance(data.get("enterprise"), dict) else None
        if enterprise is None:
            raise UniworkError("企业管理平台没有返回企业信息")
        status = str(enterprise.get("status") or "")
        if status in CHOOSE_STATES:
            ticket = str(enterprise.get("loginTicket") or "")
            if not ticket:
                raise UniworkError("企业管理平台没有返回登录票据")
            tenants = [
                {key: str(item.get(key) or "") for key in ("tenantId", "tenantCode", "tenantName", "memberName",
                                                           "memberStatus")}
                for item in enterprise.get("tenants") or [] if isinstance(item, dict)
            ]
            return Choice(status=status, ticket=ticket, tenant_code=str(enterprise.get("tenantCode") or ""),
                          tenants=tenants)
        try:
            login = parse_login(data.get("data") if isinstance(data.get("data"), dict) else {})
        except MaasError as exc:
            raise UniworkError(str(exc)) from exc
        token = str(enterprise.get("deviceToken") or "")
        tenant_id = str(enterprise.get("tenantId") or "")
        if not token or not tenant_id:
            raise UniworkError("企业管理平台没有发设备令牌")
        return Binding(
            login=login,
            device_token=token,
            status=status or ACTIVE,
            tenant_id=tenant_id,
            tenant_code=str(enterprise.get("tenantCode") or ""),
            tenant_name=str(enterprise.get("tenantName") or ""),
            policy=enterprise.get("policy") if isinstance(enterprise.get("policy"), dict) else {},
        )

    @staticmethod
    def _device(phone: str) -> dict:
        return {"deviceId": device_id(phone), "platform": PLATFORM, "appVersion": APP_VERSION}

    async def sms_login(self, phone: str, sms_code: str, tenant_code: str = "") -> Binding | Choice:
        body = {"phone": phone, "smsCode": sms_code, **self._device(phone)}
        if tenant_code:
            body["tenantCode"] = tenant_code
        data = await self._call("POST", "/api/client/sms-login", body=body, timeout_s=LOGIN_TIMEOUT_S)
        return self._outcome(data)

    async def select_tenant(self, ticket: str, phone: str, *, tenant_id: str = "", tenant_code: str = "") -> Binding:
        """选企业或按编号加入。票据过期回 401（要重新收短信），编号不存在回 404（票据还能用，换个编号再试）。"""
        body = {"loginTicket": ticket, **self._device(phone)}
        if tenant_id:
            body["tenantId"] = tenant_id
        else:
            body["tenantCode"] = tenant_code
        data = await self._call("POST", "/api/client/select-tenant", body=body, timeout_s=LOGIN_TIMEOUT_S)
        outcome = self._outcome(data)
        if not isinstance(outcome, Binding):
            raise UniworkError("企业管理平台没有发设备令牌")
        return outcome

    async def policy(self, token: str) -> dict:
        return await self._call("GET", "/api/client/policy", token=token)

    async def logout(self, token: str) -> None:
        """吊销设备令牌。令牌本来就失效了（401）也算成功。"""
        try:
            await self._call("POST", "/api/client/logout", token=token)
        except UniworkError as exc:
            if exc.status != 401:
                raise
