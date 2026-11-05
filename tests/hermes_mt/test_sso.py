"""统一登录（MT_SSO=1，entry/sso.py）：入口读网关的身份请求头，个人账号按 sid 调 12.4，企业账号凭成员 ID 换设备令牌。

真路由 + 真 PostgreSQL + 假网关（12.4、my-plan）+ 假平台，实例换成记账的假货。本机没有测试用的 PostgreSQL 时跳过
（见 conftest.py 的 MT_TEST_PG_DSN）；不连库的单元测试照常跑。
"""

from __future__ import annotations

import asyncio
import secrets
import time
from urllib.parse import parse_qs, urlsplit

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer, make_mocked_request
from cryptography.fernet import Fernet

from entry.app import Entry, build_app
from entry.config import Settings
from entry.maas import Maas
from entry.proxy import _upstream_headers
from entry.sso import (
    CredentialFailure,
    MaasCredentials,
    SsoIdentity,
    identity_from,
    member_device_id,
    member_user_id,
    trusted,
    parse_networks,
)
from entry.uniwork import Uniwork, device_id, user_id_for
from uniwork_fake import FakePlatform

ME = "/agents/api/__entry/me"
LOGOUT = "/agents/api/__entry/logout"
BACKEND = "/agents/api/__hermes_backend/api/sessions"
CREDENTIAL_TOKEN = "credential-test-token"
PHONE = "13800000001"


# ---- 假网关：12.4 和 my-plan ------------------------------------------------------------


class FakeGateway:
    """网关的 12.4（按 sid 签 MaaS 令牌）和 MaaS 的 my-plan（按令牌给套餐）。"""

    def __init__(self) -> None:
        self.sessions: dict[str, tuple[str, str]] = {}  # sid → (uid, 手机号)，只有个人账号
        self.calls: list[str] = []
        self.issued: dict[str, str] = {}  # MaaS 令牌 → uid
        self.down = False
        self.delay = 0.0
        self.server: TestServer | None = None

    @property
    def url(self) -> str:
        assert self.server is not None
        return str(self.server.make_url("")).rstrip("/")

    async def start(self) -> "FakeGateway":
        app = web.Application()
        app.router.add_post("/app/gateway/sso/internal/maas-credential", self.credential)
        app.router.add_get("/my-plan", self.my_plan)
        self.server = TestServer(app)
        await self.server.start_server()
        return self

    async def close(self) -> None:
        if self.server is not None:
            await self.server.close()

    def sign_in(self, uid: str, phone: str = PHONE) -> str:
        sid = "sid-" + secrets.token_hex(8)
        self.sessions[sid] = (uid, phone)
        return sid

    async def credential(self, request: web.Request) -> web.Response:
        if self.down:
            return web.json_response({"error": "INTERNAL_ERROR"}, status=500)
        if self.delay:
            await asyncio.sleep(self.delay)
        if request.headers.get("X-Internal-Token") != CREDENTIAL_TOKEN:
            return web.json_response({"code": 401, "error": "INTERNAL_TOKEN_INVALID"}, status=401)
        sid = (await request.json()).get("sid", "")
        self.calls.append(sid)
        if sid not in self.sessions:
            return web.json_response({"code": 401, "error": "LOGIN_REQUIRED", "data": None}, status=401)
        uid, phone = self.sessions[sid]
        token = "maas-" + secrets.token_hex(8)
        self.issued[token] = uid
        return web.json_response({"code": 0, "msg": "ok", "data": {
            "uid": uid, "phone": phone, "token": token, "expiresAt": int(time.time() * 1000) + 7 * 86400_000}})

    async def my_plan(self, request: web.Request) -> web.Response:
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip()
        if token not in self.issued:
            return web.json_response({"code": 500, "msg": "bad token"}, status=500)
        models = '{"models": [{"id": "m1", "model": "deepseek-v4-flash", "base_url": "https://example.test/v1", ' \
                 '"context_window": 128000}], "main_model_id": "m1"}'
        return web.json_response({"code": 0, "data": {"apiKey": f"plan-key-{self.issued[token]}", "models": models}})


# ---- 入口 ------------------------------------------------------------------------------


class FakeTenants:
    """只记谁被拉起过、谁被暂停过；拉起本身失败，代理请求停在 502。"""

    def __init__(self) -> None:
        self.started: list[str] = []
        self.stopped: list[tuple[str, str]] = []

    async def ensure_running(self, user_id: str, *, touch: bool = True):
        self.started.append(user_id)
        raise RuntimeError("no tenants in this test")

    async def stop(self, user_id: str, reason: str = "") -> None:
        self.stopped.append((user_id, reason))


class Harness:
    def __init__(self, entry: Entry, tenants: FakeTenants, server: TestServer):
        self.entry, self.tenants, self.server = entry, tenants, server
        self.client: TestClient | None = None

    @property
    def store(self):
        return self.entry.store

    async def settle(self) -> None:
        await asyncio.gather(*self.entry._bg, return_exceptions=True)  # noqa: SLF001

    async def request(self, method: str, path: str, identity: dict | None = None, **kwargs):
        assert self.client is not None
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.update(identity or {})
        return await self.client.request(method, path, headers=headers, **kwargs)


def personal(uid: str, sid: str) -> dict:
    return {"X-Uid": uid, "X-Account-Type": "personal", "X-Sid": sid}


def enterprise(member: str, tenant: str, sid: str) -> dict:
    return {"X-Uid": member, "X-Account-Type": "enterprise", "X-Tenant-Id": tenant, "X-Sid": sid}


async def _harness(database_url: str, *, platform: FakePlatform | None = None, gateway: FakeGateway | None = None,
                   sso: bool = True, **overrides) -> Harness:
    settings = Settings(
        base_path="/agents",
        database_url=database_url,
        credential_key=Fernet.generate_key().decode(),
        uniwork_server=platform.url if platform else "",
        sso=sso,
        sso_trusted="127.0.0.1/32,::1/128",
        sso_credential_url=f"{gateway.url}/app/gateway/sso/internal/maas-credential" if gateway else "",
        sso_credential_token=CREDENTIAL_TOKEN,
        myplan_url=f"{gateway.url}/my-plan" if gateway else "",
        uniwork_internal_token=platform.internal_token if platform else "",
        **overrides,
    )
    app = build_app(settings)
    hook = next(h for h in app.on_startup if isinstance(getattr(h, "__self__", None), Entry))
    entry = hook.__self__
    tenants = FakeTenants()

    async def startup(_app) -> None:
        await entry.database.connect()
        entry.http = aiohttp.ClientSession()
        entry.maas = Maas(settings, entry.http)
        entry.uniwork = Uniwork(settings, entry.http) if settings.enterprise else None
        entry.credentials = MaasCredentials(settings.sso_credential_url, settings.sso_credential_token, entry.http)
        entry.tenants = tenants

    app.on_startup.remove(hook)
    app.on_startup.append(startup)
    h = Harness(entry, tenants, TestServer(app))
    h.client = TestClient(h.server)
    await h.client.start_server()
    return h


@pytest_asyncio.fixture
async def gateway():
    fake = await FakeGateway().start()
    try:
        yield fake
    finally:
        await fake.close()


@pytest_asyncio.fixture
async def platform():
    fake = await FakePlatform().start()
    try:
        yield fake
    finally:
        await fake.close()


@pytest_asyncio.fixture
async def personal_entry(postgres_database_url: str, gateway: FakeGateway):
    h = await _harness(postgres_database_url, gateway=gateway)
    try:
        yield h
    finally:
        await h.client.close()


@pytest_asyncio.fixture
async def enterprise_entry(postgres_database_url: str, platform: FakePlatform):
    h = await _harness(postgres_database_url, platform=platform)
    try:
        yield h
    finally:
        await h.client.close()


# ---- 身份头 ----------------------------------------------------------------------------


def test_identity_headers_are_parsed_strictly() -> None:
    def parse(headers: dict) -> SsoIdentity | None:
        return identity_from(make_mocked_request("GET", "/", headers=headers))

    assert parse(personal("u1", "s1")) == SsoIdentity("u1", "personal", "", "s1")
    assert parse({**personal("u1", "s1"), "X-Tenant-Id": "t9"}).tenant_id == ""  # 个人账号不带企业
    assert parse(enterprise("m1", "t1", "s1")) == SsoIdentity("m1", "enterprise", "t1", "s1")
    assert parse({"X-Uid": "m1", "X-Account-Type": "enterprise", "X-Sid": "s1"}) is None  # 企业账号缺企业 ID
    assert parse({"X-Uid": "u1", "X-Account-Type": "operator", "X-Sid": "s1"}) is None  # 运营账号不用工作台
    assert parse({"X-Account-Type": "personal", "X-Sid": "s1"}) is None
    assert parse(personal("u1", "")) is None
    assert parse(personal("u:1", "s1")) is None  # 冒号会和会话键的分隔混淆
    assert parse(personal("u" * 300, "s1")) is None
    # 身份和 sid 都进会话键：换了谁都是另一个会话
    assert SsoIdentity("u1", "personal", "", "s1").session_key != SsoIdentity("u2", "personal", "", "s1").session_key


def test_only_the_gateway_is_trusted() -> None:
    networks = parse_networks("192.168.2.0/24, 10.1.2.3")
    gateway = make_mocked_request("GET", "/", headers={"X-Real-IP": "192.168.2.71"})
    stranger = make_mocked_request("GET", "/", headers={"X-Real-IP": "192.168.0.9"})
    garbage = make_mocked_request("GET", "/", headers={"X-Real-IP": "not-an-ip"})
    assert trusted(gateway, networks) and not trusted(stranger, networks) and not trusted(garbage, networks)
    assert not trusted(gateway, [])  # 没配就谁都不信
    with pytest.raises(ValueError):
        parse_networks("192.168.2.0/33")


def test_new_member_ids_do_not_collide_with_old_ones() -> None:
    assert member_user_id("t1", "m1") == "ent:t1:member:m1" != user_id_for("t1", "m1")
    assert member_device_id("t1", "m1") == member_device_id("t1", "m1") != member_device_id("t1", "m2")
    assert member_device_id("t1", "m1").startswith("cloud-") and len(member_device_id("t1", "m1")) == len(device_id(PHONE))


def test_every_nginx_route_to_the_entry_overwrites_x_real_ip() -> None:
    """入口按 X-Real-IP 认网关来源（MT_SSO_TRUSTED）：哪个 location 漏写，客户端自带的这个头就会原样透传，
    直连 18081/18082 的人填上网关的地址就能冒充任何人。"""
    import re
    from pathlib import Path

    conf = (Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "nginx" / "hermes-mt.conf").read_text(
        encoding="utf-8")
    blocks = re.findall(r"(    location [^\n]*\{\n(?:.*?\n)*?    \})", conf)
    to_entry = [b for b in blocks if "proxy_pass http://entry:9400" in b]
    assert len(to_entry) >= 10
    missing = [b.splitlines()[0].strip() for b in to_entry if "proxy_set_header X-Real-IP $remote_addr;" not in b]
    assert missing == []


def test_proxy_does_not_pass_identity_headers_to_the_instance() -> None:
    class Tenant:
        host_header, token, traffic_token = "", "tok", ""

    request = make_mocked_request("GET", "/", headers={**enterprise("m1", "t1", "s1"), "Accept": "application/json"})
    headers = {k.lower() for k in _upstream_headers(request, Settings(), Tenant())}
    assert "accept" in headers
    assert not headers & {"x-uid", "x-account-type", "x-tenant-id", "x-sid"}


# ---- 12.4 缓存（不连库） -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_maas_credentials_fetch_once_per_session_and_forget_on_drop(gateway: FakeGateway) -> None:
    sid = gateway.sign_in("u-1")
    gateway.delay = 0.05
    async with aiohttp.ClientSession() as http:
        credentials = MaasCredentials(f"{gateway.url}/app/gateway/sso/internal/maas-credential", CREDENTIAL_TOKEN, http)
        results = await asyncio.gather(*(credentials.get(sid) for _ in range(5)))
        assert len({r.token for r in results}) == 1 and gateway.calls == [sid]  # 同时来五个只调一次
        assert (await credentials.get(sid)).token == results[0].token and gateway.calls == [sid]  # 之后走缓存
        assert "maas-" not in repr(results[0])  # 令牌不进日志

        # 退出时丢掉；丢掉之前发出去的请求回来了也不再进缓存
        other = gateway.sign_in("u-2")
        pending = asyncio.ensure_future(credentials.get(other))
        await asyncio.sleep(0.01)  # 请求已经发出去了（网关那头要 0.05 秒）
        credentials.drop(other)
        await pending
        await credentials.get(other)
        assert gateway.calls.count(other) == 2  # 没进缓存：再取又调了一次网关

        gateway.sessions.clear()  # 网关上的会话没了（用户退出了）
        credentials.drop(sid)
        with pytest.raises(CredentialFailure) as caught:
            await credentials.get(sid)
        assert caught.value.status == 401


# ---- 个人账号 -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_without_trusted_identity_nobody_is_signed_in(personal_entry: Harness, gateway: FakeGateway) -> None:
    h = personal_entry
    response = await h.request("GET", ME)
    assert response.status == 401 and (await response.json())["error"] == "LOGIN_REQUIRED"
    sid = gateway.sign_in("u-1")
    # 头是对的，但不是网关发来的（我们的 nginx 写的 X-Real-IP 不在 MT_SSO_TRUSTED 里）
    forged = await h.request("GET", ME, personal("u-1", sid), headers={"X-Real-IP": "192.168.0.99"})
    assert forged.status == 401 and gateway.calls == []
    # 静态页不鉴权：页面自己问 /sso/me；配置里告诉页面这是统一登录
    assert (await h.request("GET", "/agents/api/__entry/auth")).status == 200
    assert (await (await h.request("GET", "/agents/api/__entry/config")).json())["sso"] is True


@pytest.mark.asyncio
async def test_personal_first_request_takes_the_maas_token_from_12_4(personal_entry: Harness,
                                                                      gateway: FakeGateway) -> None:
    h = personal_entry
    sid = gateway.sign_in("u-1")
    who = personal("u-1", sid)
    responses = await asyncio.gather(*(h.request("GET", ME, who) for _ in range(4)))
    assert [r.status for r in responses] == [200] * 4
    assert gateway.calls == [sid]  # 同一个会话同时来的请求只准备一次
    me = await responses[0].json()
    assert me["user_id"] == "u-1" and me["sso"] is True and me["expires_at"] == 0
    assert me["display"] == "138****0001"

    context = await h.store.get_tenant_context("u-1")
    assert context.api_key == "plan-key-u-1"  # 按 12.4 的令牌查到的套餐 key
    assert context.endpoint == ("https://example.test/v1", "deepseek-v4-flash")
    await h.settle()
    assert h.tenants.started == ["u-1"]

    # 账号业务接口：浏览器带的 Authorization 不看，令牌在入口内存里
    status = await h.request("POST", "/agents/api/__entry/maas-auth", who, headers={"Authorization": "Bearer sso"})
    body = await status.json()
    assert status.status == 200 and body["user_id"] == "u-1" and body["login_id"]
    for token in gateway.issued:
        assert token not in str(me) and token not in str(body)
    # 会话存的是摘要，不是网关的 sid
    async with h.store.database.acquire() as connection:
        stored = await connection.fetch("SELECT session_token_hash FROM auth_sessions")
    assert len(stored) == 1 and sid.encode() not in bytes(stored[0]["session_token_hash"])

    # 换了个人（同一个 sid 冒充别的 uid）对不上：12.4 给的 uid 不是这个人
    other = await h.request("GET", ME, personal("u-2", sid))
    assert other.status == 401


@pytest.mark.asyncio
async def test_personal_session_ended_at_the_gateway_is_login_required(personal_entry: Harness,
                                                                       gateway: FakeGateway) -> None:
    h = personal_entry
    response = await h.request("GET", ME, personal("u-1", "sid-unknown"))
    assert response.status == 401  # 12.4 说这个会话不存在
    gateway.down = True
    down = await h.request("GET", ME, personal("u-1", gateway.sign_in("u-1")))
    assert down.status == 503 and (await down.json())["error"] == "login_service_unavailable"


@pytest.mark.asyncio
async def test_own_login_is_gone_and_pages_go_to_the_gateway(personal_entry: Harness, gateway: FakeGateway) -> None:
    h = personal_entry
    for method, path in (("POST", "/agents/api/__entry/login"), ("GET", "/agents/api/__entry/captcha"),
                         ("POST", "/agents/api/__entry/send-code"), ("POST", "/agents/api/__entry/dev-login")):
        assert (await h.request(method, path, json={})).status == 404, path

    page = await h.request("GET", "/agents/login?redirect_uri=/agents/chat%3Fid%3D1", allow_redirects=False)
    target = urlsplit(page.headers["Location"])
    assert page.status == 302 and target.path == "/login/"
    assert parse_qs(target.query) == {"platform": ["agents"], "redirect_uri": ["/agents/chat?id=1"]}
    evil = await h.request("GET", "/agents/login?redirect_uri=https://evil.test/agents/", allow_redirects=False)
    assert parse_qs(urlsplit(evil.headers["Location"]).query)["redirect_uri"] == ["/agents/"]
    # 切换账号：prompt 只转方案里的 select_account
    switch = await h.request("GET", "/agents/login?redirect_uri=/agents/%23/&prompt=select_account", allow_redirects=False)
    assert parse_qs(urlsplit(switch.headers["Location"]).query) == {
        "platform": ["agents"], "redirect_uri": ["/agents/#/"], "prompt": ["select_account"]}
    odd = await h.request("GET", "/agents/login?prompt=consent", allow_redirects=False)
    assert "prompt" not in parse_qs(urlsplit(odd.headers["Location"]).query)

    logout_page = await h.request("GET", "/agents/logout")
    html = await logout_page.text()
    assert logout_page.status == 200 and "/app/gateway/sso/logout" in html and '"/login/?platform=agents' in html
    assert "__LOGIN_URL__" not in html and logout_page.headers["Cache-Control"] == "no-store"


@pytest.mark.asyncio
async def test_the_login_page_address_is_configured_once(postgres_database_url: str, gateway: FakeGateway) -> None:
    """页面去登录页都经过入口的 /agents/login，退出页最后也跳同一个地址：MT_SSO_LOGIN_URL 改了，两处一起变。"""
    h = await _harness(postgres_database_url, gateway=gateway, sso_login_url="https://login.example.test/sso/")
    try:
        page = await h.request("GET", "/agents/login?redirect_uri=/agents/", allow_redirects=False)
        target = urlsplit(page.headers["Location"])
        assert page.status == 302 and (target.scheme, target.netloc, target.path) == ("https", "login.example.test", "/sso/")
        html = await (await h.request("GET", "/agents/logout")).text()
        assert '"https://login.example.test/sso/?platform=agents' in html
    finally:
        await h.client.close()


@pytest.mark.asyncio
async def test_personal_logout_forgets_the_session(personal_entry: Harness, gateway: FakeGateway) -> None:
    h = personal_entry
    sid = gateway.sign_in("u-1")
    who = personal("u-1", sid)
    assert (await h.request("GET", ME, who)).status == 200
    body = await (await h.request("POST", LOGOUT, who, json={})).json()
    assert body == {"ok": True, "revoked": True}
    # 网关的 /sso/logout 还没生效时，同一个会话的请求不能又把会话建回来
    assert (await h.request("GET", ME, who)).status == 401
    assert gateway.calls == [sid]


# ---- 企业账号 -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_member_gets_a_device_token_by_member_id(enterprise_entry: Harness, platform: FakePlatform) -> None:
    h = enterprise_entry
    platform.members[(PHONE, "T1")] = "active"
    member = platform.member_id(PHONE)
    who = enterprise(member, "tid-1", "sid-a")
    me = await (await h.request("GET", ME, who)).json()
    user_id = member_user_id("tid-1", member)
    assert me["user_id"] == user_id and me["enterprise"]["allowed"] is True
    assert me["display"] == "用户0001" and me["enterprise"]["tenantName"] == "一号企业"

    grants = [body for kind, body in platform.requests if kind == "device-token"]
    assert grants == [{"tenantId": "tid-1", "memberId": member, "deviceId": member_device_id("tid-1", member),
                       "platform": "cloud", "appVersion": "hermes-cloud"}]
    token = (await h.store.get_tenant_context(user_id)).api_key
    assert token in platform.tokens
    binding = await h.store.get_enterprise_binding(user_id)
    assert binding.member_id == member and binding.tenant_code == "T1" and binding.access_status == "active"
    await h.settle()
    assert h.tenants.started == [user_id]

    # 同一个人换个浏览器（新的 sid）：存着的令牌还能用就不换发（换发会让实例里正在用的那把作废）
    assert (await h.request("GET", ME, enterprise(member, "tid-1", "sid-b"))).status == 200
    assert len([1 for kind, _ in platform.requests if kind == "device-token"]) == 1
    assert (await h.store.get_tenant_context(user_id)).api_key == token


@pytest.mark.asyncio
async def test_member_who_signed_in_before_keeps_user_id_device_and_token(enterprise_entry: Harness,
                                                                          platform: FakePlatform) -> None:
    from entry.store import EnterpriseBinding

    h = enterprise_entry
    platform.members[(PHONE, "T1")] = "active"
    old_user = user_id_for("tid-1", f"uid-{PHONE}")
    old_device = device_id(PHONE)
    grant = platform._enroll(PHONE, "T1", old_device)  # noqa: SLF001 — 统一登录前那次短信登录拿到的令牌
    await h.store.finish_login(
        user_id=old_user, phone=PHONE, api_key=grant["deviceToken"], endpoint=None, catalog=None, ttl_s=3600,
        upstream_expires_at_ms=None, login_method="uniwork",
        enterprise=EnterpriseBinding(tenant_id="tid-1", tenant_code="T1", tenant_name="一号企业", uid=f"uid-{PHONE}",
                                     device_id=old_device, member_id=platform.member_id(PHONE), member_name="用户0001",
                                     access_status="active"))

    me = await (await h.request("GET", ME, enterprise(platform.member_id(PHONE), "tid-1", "sid-a"))).json()
    assert me["user_id"] == old_user  # 老员工的数据、实例接着用
    assert not [1 for kind, _ in platform.requests if kind == "device-token"]  # 令牌还能用：没换发
    assert (await h.store.get_tenant_context(old_user)).api_key == grant["deviceToken"]

    # 令牌在平台上作废了（比如别处退出时吊销了）：新会话来时用老设备号换发
    platform.revoked.add(grant["deviceToken"])
    del platform.tokens[grant["deviceToken"]]
    assert (await h.request("GET", ME, enterprise(platform.member_id(PHONE), "tid-1", "sid-b"))).status == 200
    grants = [body for kind, body in platform.requests if kind == "device-token"]
    assert [g["deviceId"] for g in grants] == [old_device]
    assert (await h.store.get_tenant_context(old_user)).api_key != grant["deviceToken"]


@pytest.mark.asyncio
async def test_blocked_member_signs_in_and_sees_the_reason_in_the_page(enterprise_entry: Harness,
                                                                       platform: FakePlatform) -> None:
    h = enterprise_entry
    platform.members[(PHONE, "T1")] = "pending"
    who = enterprise(platform.member_id(PHONE), "tid-1", "sid-a")
    me = await (await h.request("GET", ME, who)).json()
    assert me["enterprise"]["allowed"] is False and me["enterprise"]["status"] == "pending"
    assert me["enterprise"]["message"] == "你的加入申请还在等待管理员审批"
    gated = await h.request("GET", BACKEND, who)
    assert gated.status == 403 and (await gated.json())["reason"] == "pending"
    await h.settle()
    assert h.tenants.started == []  # 被拦的人不拉起实例


@pytest.mark.asyncio
async def test_unavailable_member_and_down_platform_are_not_a_login_loop(enterprise_entry: Harness,
                                                                         platform: FakePlatform) -> None:
    h = enterprise_entry
    platform.members[(PHONE, "T1")] = "left"
    who = enterprise(platform.member_id(PHONE), "tid-1", "sid-a")
    refused = await h.request("GET", ME, who)
    body = await refused.json()
    # 403 而不是 401：401 会让页面跳登录页，网关看会话还有效又跳回来
    assert refused.status == 403 and body["error"] == "enterprise_access_denied" and "离职" in body["message"]
    calls = len(platform.requests)
    assert (await h.request("GET", ME, who)).status == 403
    assert len(platform.requests) == calls  # 刚失败过：过一会儿再试，不是每个请求都打平台

    platform.internal_token = "rotated"  # 入口的密钥不对：平台回 401，不能当成用户没登录
    wrong = await h.request("GET", ME, enterprise(platform.member_id(PHONE), "tid-1", "sid-b"))
    assert wrong.status == 503 and (await wrong.json())["error"] == "enterprise_unavailable"


@pytest.mark.asyncio
async def test_logout_revokes_the_device_token_and_other_browsers_get_a_new_one(enterprise_entry: Harness,
                                                                                platform: FakePlatform) -> None:
    h = enterprise_entry
    platform.members[(PHONE, "T1")] = "active"
    member = platform.member_id(PHONE)
    first, second = enterprise(member, "tid-1", "sid-a"), enterprise(member, "tid-1", "sid-b")
    assert (await h.request("GET", ME, first)).status == 200
    assert (await h.request("GET", ME, second)).status == 200
    user_id = member_user_id("tid-1", member)
    token = (await h.store.get_tenant_context(user_id)).api_key

    body = await (await h.request("POST", LOGOUT, first, json={})).json()
    assert body == {"ok": True, "revoked": True}
    assert token in platform.revoked
    assert (await h.request("GET", ME, first)).status == 401  # 退出的会话不再建回来

    # 另一个浏览器的统一登录会话还在：下一个请求凭成员 ID 换发新令牌，接着用
    again = await h.request("GET", ME, second)
    assert again.status == 200 and (await again.json())["enterprise"]["allowed"] is True
    fresh = (await h.store.get_tenant_context(user_id)).api_key
    assert fresh and fresh != token and fresh in platform.tokens


@pytest.mark.asyncio
async def test_logout_with_the_platform_down_says_so_and_revokes_later(enterprise_entry: Harness,
                                                                       platform: FakePlatform) -> None:
    h = enterprise_entry
    platform.members[(PHONE, "T1")] = "active"
    who = enterprise(platform.member_id(PHONE), "tid-1", "sid-a")
    assert (await h.request("GET", ME, who)).status == 200
    user_id = member_user_id("tid-1", platform.member_id(PHONE))
    await h.store.ensure_tenant_token(user_id)  # 起过实例的人才有容器令牌
    token = (await h.store.get_tenant_context(user_id)).api_key

    platform.logout_down = True
    body = await (await h.request("POST", LOGOUT, who, json={})).json()
    assert body["ok"] is True and body["revoked"] is False and "自动重试" in body["message"]
    assert token in platform.tokens  # 平台上还没吊销
    assert (await h.store.get_tenant_context(user_id)).api_key == ""  # 入口自己不再用它
    assert await h.store.revocation_pending(user_id)
    await h.settle()
    assert h.tenants.stopped == [(user_id, "logout: device token revocation pending")]  # 实例里那份也停下
    assert (await h.store.get_enterprise_binding(user_id)).access_status == "unbound"

    await h.entry._retry_revocations()  # noqa: SLF001 — 平台还是连不上：记一次失败，往后推
    assert await h.store.revocation_pending(user_id) and token in platform.tokens
    platform.logout_down = False
    async with h.store.database.acquire() as connection:
        await connection.execute("UPDATE device_token_revocations SET next_attempt_at = now()")
    await h.entry._retry_revocations()  # noqa: SLF001
    assert token in platform.revoked and not await h.store.revocation_pending(user_id)


@pytest.mark.asyncio
async def test_old_login_logout_also_reports_a_pending_revocation(postgres_database_url: str,
                                                                  platform: FakePlatform) -> None:
    """开关关着（入口自己的短信登录）时退出的处理一样，登录页上如实提示。"""
    from uniwork_fake import SMS_CODE

    h = await _harness(postgres_database_url, platform=platform, sso=False)
    try:
        platform.members[(PHONE, "T1")] = "active"
        login = await h.request("POST", "/agents/api/__entry/login", json={"phone": PHONE, "smsCode": SMS_CODE})
        assert login.status == 200
        user_id = (await login.json())["user_id"]
        await h.store.ensure_tenant_token(user_id)
        platform.logout_down = True
        page = await h.request("GET", "/agents/logout", allow_redirects=False)
        assert page.status == 302 and "revoke_pending=1" in page.headers["Location"]
        assert await h.store.revocation_pending(user_id)
    finally:
        await h.client.close()
