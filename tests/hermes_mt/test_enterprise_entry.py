"""企业模式下入口的登录、选企业、拦截、复查和退出：真路由 + 真 PostgreSQL + 假平台，实例换成记账的假货。

本机没有测试用的 PostgreSQL 时跳过（见 conftest.py 的 MT_TEST_PG_DSN）。
"""

from __future__ import annotations

import asyncio

import aiohttp
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry.app import Entry, build_app
from entry.config import Settings
from entry.uniwork import Uniwork, device_id, user_id_for
from uniwork_fake import SMS_CODE, FakePlatform

PHONE = "13800000001"
LOGIN = "/hermes/__entry/login"
SELECT = "/hermes/__entry/select-tenant"


class FakeTenants:
    """只记谁被拉起过；拉起本身失败，这样代理请求停在 502 而不是真去连实例。"""

    def __init__(self) -> None:
        self.started: list[str] = []

    async def ensure_running(self, user_id: str, *, touch: bool = True):
        self.started.append(user_id)
        raise RuntimeError("no tenants in this test")


class Harness:
    def __init__(self, entry, tenants: FakeTenants, server: TestServer, platform: FakePlatform | None):
        self.entry, self.tenants, self.server, self.platform = entry, tenants, server, platform
        self.clients: list[TestClient] = []

    async def client(self) -> TestClient:
        """一个浏览器（各自的 cookie）。"""
        client = TestClient(self.server)
        await client.start_server()
        self.clients.append(client)
        return client

    async def settle(self) -> None:
        """等登录后的后台预热跑完。"""
        await asyncio.gather(*self.entry._bg, return_exceptions=True)

    @property
    def store(self):
        return self.entry.store


async def _harness(database_url: str, platform: FakePlatform | None, **overrides) -> Harness:
    settings = Settings(
        base_path="/hermes",
        database_url=database_url,
        credential_key=Fernet.generate_key().decode(),
        uniwork_server=platform.url if platform else "",
        **overrides,
    )
    app = build_app(settings)
    hook = next(h for h in app.on_startup if isinstance(getattr(h, "__self__", None), Entry))
    entry = hook.__self__
    tenants = FakeTenants()

    async def startup(_app) -> None:
        # 不连 Docker / 沙箱，不跑对账和回收：只要登录相关的部分
        await entry.database.connect()
        entry.http = aiohttp.ClientSession()
        entry.uniwork = Uniwork(settings, entry.http) if settings.enterprise else None
        entry.tenants = tenants

    app.on_startup.remove(hook)
    app.on_startup.append(startup)
    server = TestServer(app)
    return Harness(entry, tenants, server, platform)


@pytest_asyncio.fixture
async def platform():
    fake = await FakePlatform().start()
    try:
        yield fake
    finally:
        await fake.close()


@pytest_asyncio.fixture
async def harness(postgres_database_url: str, platform: FakePlatform):
    h = await _harness(postgres_database_url, platform)
    try:
        yield h
    finally:
        for client in h.clients:
            await client.close()


async def _login(client: TestClient, phone: str = PHONE, code: str = SMS_CODE, **extra):
    response = await client.post(LOGIN, json={"phone": phone, "smsCode": code, **extra})
    return response.status, await response.json()


@pytest.mark.asyncio
async def test_active_member_login_stores_device_token_models_and_binding(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    browser = await harness.client()
    status, body = await _login(browser)
    assert status == 200 and body["ok"] is True
    assert body["enterprise"]["allowed"] is True and body["enterprise"]["tenantName"] == "一号企业"
    user_id = user_id_for("tid-1", f"uid-{PHONE}")
    assert body["user_id"] == user_id

    token = next(t for t, (p, c, d) in harness.platform.tokens.items() if p == PHONE)
    context = await harness.store.get_tenant_context(user_id)
    assert context.api_key == token  # 设备令牌就是实例的模型 key
    assert context.endpoint == (f"{harness.platform.url}/v1", "deepseek-v4-flash")
    assert [name for name, _ in context.catalog] == ["glm-5.2", "deepseek-v4-flash"]
    assert context.limits == {"glm-5.2": 240000, "deepseek-v4-flash": 300000}

    binding = await harness.store.get_enterprise_binding(user_id)
    assert binding is not None and binding.access_status == "active"
    assert binding.device_id == device_id(PHONE) and binding.tenant_code == "T1" and binding.member_name == "用户0001"
    assert binding.policy_revision == "rev-T1-active"

    await harness.settle()
    assert harness.tenants.started == [user_id]  # 放行的人登录后预热实例
    assert (await browser.get("/hermes/__entry/auth")).status == 200
    me = await (await browser.get("/hermes/__entry/me")).json()
    assert me["enterprise"]["status"] == "active" and me["display"] == "138****0001"
    assert token not in str(me) and token not in str(body)


@pytest.mark.asyncio
async def test_blocked_member_is_gated_until_the_platform_lets_them_in(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "pending"
    browser = await harness.client()
    status, body = await _login(browser)
    assert status == 200 and body["ok"] is True
    assert body["enterprise"] == {**body["enterprise"], "status": "pending", "allowed": False}
    user_id = body["user_id"]
    await harness.settle()
    assert harness.tenants.started == []  # 被拦的人不拉起实例
    assert (await harness.store.get_tenant_context(user_id)).endpoint is None

    assert (await browser.get("/hermes/__entry/auth")).status == 401  # nginx 送回登录页
    blocked = await browser.get("/hermes/__hermes_backend/api/sessions")
    assert blocked.status == 403 and (await blocked.json())["reason"] == "pending"
    ws = await browser.get("/hermes/api/ws")
    assert ws.status == 403
    assert harness.tenants.started == []

    # 复查：平台还没批
    check = await (await browser.get("/hermes/__entry/enterprise")).json()
    assert check["status"] == "pending" and check["allowed"] is False

    # 管理员批了：复查后放行，模型清单补上，实例预热
    harness.platform.members[(PHONE, "T1")] = "active"
    check = await (await browser.get("/hermes/__entry/enterprise")).json()
    assert check["status"] == "active" and check["allowed"] is True
    await harness.settle()
    assert harness.tenants.started == [user_id]
    assert (await harness.store.get_tenant_context(user_id)).endpoint == (
        f"{harness.platform.url}/v1", "deepseek-v4-flash")
    assert (await browser.get("/hermes/__entry/auth")).status == 200
    passed = await browser.get("/hermes/__hermes_backend/api/sessions")
    assert passed.status == 502  # 过了拦截，停在假实例上


@pytest.mark.asyncio
async def test_choose_tenant_then_select_by_id(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    harness.platform.members[(PHONE, "T2")] = "pending"
    browser = await harness.client()
    status, body = await _login(browser)
    assert status == 200 and body["ok"] is False
    choice = body["enterprise"]
    assert choice["status"] == "choose_tenant" and [t["tenantCode"] for t in choice["tenants"]] == ["T1", "T2"]
    ticket = next(iter(harness.platform.tickets))
    assert ticket not in str(body)  # 票据封在 pending 里，浏览器看不到原文
    assert (await browser.get("/hermes/__entry/auth")).status == 401  # 还没建会话

    response = await browser.post(SELECT, json={"pending": choice["pending"], "tenantId": "tid-1"})
    picked = await response.json()
    assert response.status == 200 and picked["ok"] is True and picked["enterprise"]["tenantName"] == "一号企业"
    assert picked["user_id"] == user_id_for("tid-1", f"uid-{PHONE}")
    assert harness.platform.requests[-1][1]["deviceId"] == device_id(PHONE)
    assert (await browser.get("/hermes/__entry/auth")).status == 200


@pytest.mark.asyncio
async def test_unknown_code_keeps_the_ticket_then_join_files_a_request(harness: Harness) -> None:
    browser = await harness.client()
    _, body = await _login(browser)
    assert body["enterprise"]["status"] == "tenant_required"
    pending = body["enterprise"]["pending"]

    wrong = await browser.post(SELECT, json={"pending": pending, "tenantCode": "NOPE"})
    assert wrong.status == 404 and "企业编号" in (await wrong.json())["error"]

    joined = await browser.post(SELECT, json={"pending": pending, "tenantCode": "T1"})
    body = await joined.json()
    assert joined.status == 200 and body["enterprise"]["status"] == "pending"
    assert harness.platform.members[(PHONE, "T1")] == "pending"

    tampered = await browser.post(SELECT, json={"pending": pending[:-4] + "AAAA", "tenantCode": "T1"})
    assert tampered.status == 401


@pytest.mark.asyncio
async def test_login_with_tenant_code_and_yuanjing_errors(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    browser = await harness.client()
    status, body = await _login(browser, code="000000")
    assert status == 401 and "验证码" in body["error"]
    assert (await browser.get("/hermes/__entry/auth")).status == 401

    status, body = await _login(browser, tenantCode="NOPE")
    assert status == 200 and body["enterprise"]["status"] == "tenant_not_found"
    assert harness.platform.requests[-1][1]["tenantCode"] == "NOPE"

    status, body = await _login(browser, tenantCode="T2")  # 填了别的企业的编号：在那边提交加入申请
    assert status == 200 and body["enterprise"]["status"] == "pending"
    assert body["user_id"] == user_id_for("tid-2", f"uid-{PHONE}")


@pytest.mark.asyncio
async def test_logout_revokes_the_device_token_and_gates_other_browsers(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    first, second = await harness.client(), await harness.client()
    await _login(first)
    _, body = await _login(second)  # 同一个人在第二个浏览器登录：令牌换新，两边都还能用
    user_id = body["user_id"]
    token = (await harness.store.get_tenant_context(user_id)).api_key
    assert token in harness.platform.tokens
    assert (await first.get("/hermes/__entry/auth")).status == 200

    assert (await first.post("/hermes/__entry/logout", json={})).status == 200
    assert token in harness.platform.revoked  # 平台上的设备令牌吊销了
    assert (await harness.store.get_enterprise_binding(user_id)).access_status == "unbound"  # type: ignore[union-attr]
    assert (await first.get("/hermes/__entry/auth")).status == 401
    gated = await second.get("/hermes/__hermes_backend/api/sessions")
    assert gated.status == 403 and (await gated.json())["reason"] == "unbound"

    check = await (await second.get("/hermes/__entry/enterprise")).json()
    assert check["status"] == "unbound"  # 令牌已失效：复查也救不回来，只能重新登录
    _, again = await _login(second)
    assert again["enterprise"]["allowed"] is True
    assert (await second.get("/hermes/__entry/auth")).status == 200


@pytest.mark.asyncio
async def test_member_disabled_mid_session_is_blocked_after_a_background_recheck(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    browser = await harness.client()
    await _login(browser)
    harness.entry._RECHECK_S = 0  # 测试里不等一分钟
    harness.platform.members[(PHONE, "T1")] = "disabled"  # 管理员在后台停用了他

    stale = await browser.get("/hermes/__hermes_backend/api/sessions")
    assert stale.status == 502  # 这一次还按库里的旧状态放行（停在假实例上），同时在后台问了平台
    await harness.settle()
    blocked = await browser.get("/hermes/__hermes_backend/api/sessions")
    assert blocked.status == 403 and (await blocked.json())["reason"] == "disabled"
    assert (await browser.get("/hermes/__entry/auth")).status == 401


@pytest.mark.asyncio
async def test_background_recheck_is_throttled_and_survives_a_down_platform(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    browser = await harness.client()
    await _login(browser)
    policy_calls = []
    original = harness.entry.uniwork.policy

    async def counting(token: str):
        policy_calls.append(token)
        return await original(token)

    harness.entry.uniwork.policy = counting
    for _ in range(5):
        await browser.get("/hermes/__entry/auth")
    await harness.settle()
    assert len(policy_calls) == 1  # 一分钟内只问一次

    await harness.platform.close()  # 平台挂了：照常按库里的状态放行
    harness.entry._RECHECK_S = 0
    assert (await browser.get("/hermes/__entry/auth")).status == 200
    await harness.settle()
    assert (await browser.get("/hermes/__entry/auth")).status == 200


@pytest.mark.asyncio
async def test_recheck_marks_a_revoked_token_unbound(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    browser = await harness.client()
    await _login(browser)
    harness.platform.tokens.clear()  # 管理员在后台重置了设备
    check = await (await browser.get("/hermes/__entry/enterprise")).json()
    assert check["status"] == "unbound" and check["allowed"] is False
    assert (await browser.get("/hermes/__entry/auth")).status == 401


@pytest.mark.asyncio
async def test_disabled_member_cron_is_not_woken(harness: Harness) -> None:
    harness.platform.members[(PHONE, "T1")] = "active"
    browser = await harness.client()
    _, body = await _login(browser)
    user_id = body["user_id"]
    await harness.store.ensure_tenant_token(user_id)
    async with harness.store.database.acquire() as connection:
        await connection.execute(
            "UPDATE tenant_runtime SET next_cron_at = now() + interval '10 seconds' WHERE user_id = $1", user_id)
    assert [u for u, _ in await harness.store.cron_due_tenants(60)] == [user_id]
    harness.platform.members[(PHONE, "T1")] = "disabled"
    await browser.get("/hermes/__entry/enterprise")
    assert await harness.store.cron_due_tenants(60) == []


@pytest.mark.asyncio
async def test_personal_mode_is_unchanged(postgres_database_url: str) -> None:
    h = await _harness(postgres_database_url, None, dev_login=True, dev_api_key="dev-key")
    try:
        browser = await h.client()
        config = await (await browser.get("/hermes/__entry/config")).json()
        assert config["enterprise"] is False
        assert (await browser.post(SELECT, json={})).status == 404
        assert (await browser.get("/hermes/__entry/enterprise")).status == 404
        response = await browser.post("/hermes/__entry/dev-login", json={"user": "alice"})
        body = await response.json()
        assert response.status == 200 and "enterprise" not in body
        assert (await browser.get("/hermes/__entry/auth")).status == 200
        me = await (await browser.get("/hermes/__entry/me")).json()
        assert "enterprise" not in me
        await h.settle()
        assert h.tenants.started == ["alice"]
    finally:
        for client in h.clients:
            await client.close()


@pytest.mark.asyncio
async def test_enterprise_mode_gates_sessions_without_a_binding(postgres_database_url: str, platform) -> None:
    """切到企业模式前登录的个人用户：会话还在，但没有平台绑定，要重新登录。开发模式登录的例外。"""
    h = await _harness(postgres_database_url, platform)
    try:
        browser = await h.client()  # 先起服务（连上库），再造一个个人模式留下的会话
        legacy = await h.store.finish_login(
            user_id="old-personal-user", phone="13900000000", api_key="plan-key", endpoint=None, catalog=None,
            ttl_s=3600, upstream_expires_at_ms=None, login_method="sms")
        browser.session.cookie_jar.update_cookies({h.entry.s.cookie_name: legacy.session.sid})
        assert (await browser.get("/hermes/__entry/auth")).status == 401
        gated = await browser.get("/hermes/__hermes_backend/api/sessions")
        assert gated.status == 403 and (await gated.json())["reason"] == "unbound"
    finally:
        for client in h.clients:
            await client.close()
