"""企业模式：入口调 UNIWORK 企业管理平台的客户端（entry/uniwork.py），对着假平台跑。"""

from __future__ import annotations

import aiohttp
import pytest
import pytest_asyncio

from entry.config import Settings
from entry.uniwork import (
    Binding,
    Choice,
    Uniwork,
    UniworkError,
    access_status,
    device_id,
    plan_of,
    user_id_for,
)
from uniwork_fake import SMS_CODE, FakePlatform

PHONE = "13800000001"


@pytest_asyncio.fixture
async def platform():
    fake = await FakePlatform().start()
    try:
        yield fake
    finally:
        await fake.close()


@pytest_asyncio.fixture
async def client(platform):
    async with aiohttp.ClientSession() as http:
        yield Uniwork(Settings(uniwork_server=platform.url), http)


def test_device_id_is_stable_and_does_not_carry_the_phone() -> None:
    assert device_id(PHONE) == device_id(" 138-0000-0001 ")
    assert device_id(PHONE) != device_id("13800000002")
    assert device_id(PHONE).startswith("cloud-")
    assert PHONE not in device_id(PHONE)


def test_user_id_is_scoped_to_the_enterprise() -> None:
    assert user_id_for("tid-1", "uid-9") != user_id_for("tid-2", "uid-9")
    assert ":" in user_id_for("tid-1", "uid-9")  # 个人模式的元景 uid 不带冒号，不会撞


@pytest.mark.parametrize(
    ("policy", "status", "want"),
    [
        ({"access": {"allowed": True, "reason": ""}}, "active", "active"),
        ({"access": {"allowed": False, "reason": "no_seat"}}, "active", "no_seat"),
        ({"access": {"allowed": True}}, "pending", "pending"),  # 登录给的状态说不行就不行
        ({"access": {"allowed": False}}, "active", "not_member"),
        ({}, "active", "active"),
    ],
)
def test_access_status(policy: dict, status: str, want: str) -> None:
    assert access_status(policy, status) == want


def test_plan_of_maps_policy_models_like_a_personal_plan() -> None:
    base = "http://platform:11220/v1"
    policy = {"models": {"main_model_id": "uniwork-ds", "models": [
        {"id": "uniwork-glm", "model": "glm-5.2", "base_url": base, "context_window": 240000},
        {"id": "uniwork-ds", "model": "deepseek-v4-flash", "base_url": base, "context_window": 300000},
    ]}}
    plan = plan_of(policy, "device-token")
    assert plan is not None and plan.api_key == "device-token"
    assert plan.endpoint() == (base, "deepseek-v4-flash")  # main_model_id 指的那一项，不是第一项
    assert plan.catalog() == [("glm-5.2", base), ("deepseek-v4-flash", base)]
    assert plan.limits() == {"glm-5.2": 240000, "deepseek-v4-flash": 300000}
    assert plan_of({"models": {"models": [], "main_model_id": ""}}, "device-token") is None  # 被拦的人没有模型


@pytest.mark.asyncio
async def test_single_enterprise_login_returns_binding_and_sends_cloud_device(client, platform) -> None:
    platform.members[(PHONE, "T1")] = "active"
    outcome = await client.sms_login(PHONE, SMS_CODE)
    assert isinstance(outcome, Binding)
    assert outcome.status == "active" and outcome.access == "active"
    assert outcome.tenant_id == "tid-1" and outcome.tenant_code == "T1" and outcome.tenant_name == "一号企业"
    assert outcome.login.uid == f"uid-{PHONE}"
    assert outcome.device_token in platform.tokens
    sent = platform.requests[-1][1]
    assert sent["deviceId"] == device_id(PHONE) and sent["platform"] == "cloud" and sent["appVersion"]
    assert "tenantCode" not in sent


@pytest.mark.asyncio
async def test_blocked_member_still_gets_a_token(client, platform) -> None:
    platform.members[(PHONE, "T1")] = "disabled"
    outcome = await client.sms_login(PHONE, SMS_CODE)
    assert isinstance(outcome, Binding) and outcome.access == "disabled" and outcome.device_token
    assert plan_of(outcome.policy, outcome.device_token) is None


@pytest.mark.asyncio
async def test_yuanjing_error_is_passed_through(client, platform) -> None:
    with pytest.raises(UniworkError) as caught:
        await client.sms_login(PHONE, "000000")
    assert caught.value.status == 401 and "验证码" in str(caught.value)


@pytest.mark.asyncio
async def test_several_enterprises_ask_to_choose_then_select_by_id(client, platform) -> None:
    platform.members[(PHONE, "T1")] = "active"
    platform.members[(PHONE, "T2")] = "pending"
    outcome = await client.sms_login(PHONE, SMS_CODE)
    assert isinstance(outcome, Choice) and outcome.status == "choose_tenant" and outcome.ticket
    assert [t["tenantCode"] for t in outcome.tenants] == ["T1", "T2"]
    assert set(outcome.tenants[0]) == {"tenantId", "tenantCode", "tenantName", "memberName", "memberStatus"}
    binding = await client.select_tenant(outcome.ticket, PHONE, tenant_id="tid-2")
    assert binding.tenant_code == "T2" and binding.access == "pending"
    assert platform.requests[-1][1]["deviceId"] == device_id(PHONE)


@pytest.mark.asyncio
async def test_unknown_code_is_404_and_the_ticket_still_works(client, platform) -> None:
    outcome = await client.sms_login(PHONE, SMS_CODE)
    assert isinstance(outcome, Choice) and outcome.status == "tenant_required"
    with pytest.raises(UniworkError) as caught:
        await client.select_tenant(outcome.ticket, PHONE, tenant_code="NOPE")
    assert caught.value.status == 404 and "企业编号" in str(caught.value)
    binding = await client.select_tenant(outcome.ticket, PHONE, tenant_code="T1")
    assert binding.access == "pending"  # 不是成员：提交了加入申请
    with pytest.raises(UniworkError) as again:
        await client.select_tenant(outcome.ticket, PHONE, tenant_code="T1")  # 票据用过了
    assert again.value.status == 401


@pytest.mark.asyncio
async def test_login_with_unknown_tenant_code_reports_not_found(client, platform) -> None:
    platform.members[(PHONE, "T1")] = "active"
    outcome = await client.sms_login(PHONE, SMS_CODE, tenant_code="NOPE")
    assert isinstance(outcome, Choice) and outcome.status == "tenant_not_found" and outcome.tenant_code == "NOPE"


@pytest.mark.asyncio
async def test_policy_and_logout(client, platform) -> None:
    platform.members[(PHONE, "T1")] = "active"
    binding = await client.sms_login(PHONE, SMS_CODE)
    assert isinstance(binding, Binding)
    assert access_status(await client.policy(binding.device_token)) == "active"
    await client.logout(binding.device_token)
    assert binding.device_token in platform.revoked
    with pytest.raises(UniworkError) as caught:
        await client.policy(binding.device_token)
    assert caught.value.status == 401
    await client.logout(binding.device_token)  # 已经失效的令牌再退出也不报错


@pytest.mark.asyncio
async def test_relogin_revokes_the_previous_token(client, platform) -> None:
    platform.members[(PHONE, "T1")] = "active"
    first = await client.sms_login(PHONE, SMS_CODE)
    second = await client.sms_login(PHONE, SMS_CODE)
    assert isinstance(first, Binding) and isinstance(second, Binding)
    assert first.device_token in platform.revoked and second.device_token in platform.tokens


@pytest.mark.asyncio
async def test_unreachable_platform_is_a_502() -> None:
    async with aiohttp.ClientSession() as http:
        dead = Uniwork(Settings(uniwork_server="http://127.0.0.1:9", upstream_timeout_s=3), http)
        with pytest.raises(UniworkError) as caught:
            await dead.policy("token")
    assert caught.value.status == 502 and "连不上" in str(caught.value)
