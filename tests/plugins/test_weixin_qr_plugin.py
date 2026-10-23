"""微信扫码连接插件：模拟 iLink 返回，验证状态流转、配置写入和解绑。"""
from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from hermes_cli.config import load_config, load_env, save_env_value
from hermes_constants import get_hermes_home
from plugins.weixin_qr.dashboard import plugin_api as qr


class _FakeSession:
    """代替 aiohttp 会话；请求由下面的假函数回答。"""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeIlink:
    """按顺序回答扫码状态，并记录每次轮询的服务器地址和当时的登录状态。"""

    def __init__(self, statuses, qrs=None):
        self.statuses = list(statuses)
        self.qrs = list(qrs or [("qr-1", "https://liteapp.weixin.qq.com/q/qr-1")])
        self.polled: list[tuple[str, str, str]] = []

    async def fetch_qr(self, session, bot_type):
        assert bot_type == qr.BOT_TYPE
        return self.qrs.pop(0) if self.qrs else ("", "")

    async def api_get(self, session, *, base_url, endpoint, timeout_ms):
        login = next(iter(qr._logins.values()))
        self.polled.append((base_url, endpoint, login.state))
        if not self.statuses:
            raise asyncio.CancelledError
        return self.statuses.pop(0)


@pytest.fixture
def ilink(monkeypatch):
    """装上假 iLink，清空登录记录，并让轮询不等待、重启只返回结果。"""
    qr._logins.clear()
    monkeypatch.setattr(qr, "POLL_INTERVAL_S", 0)
    monkeypatch.setattr(qr.wx, "_new_session", lambda **_: _FakeSession())
    monkeypatch.setattr(qr.wx, "check_weixin_requirements", lambda: True)
    monkeypatch.setattr(qr, "_restart", lambda profile: {"restart_started": False, "restart_error": "no supervisor"})

    def install(statuses, qrs=None):
        fake = _FakeIlink(statuses, qrs)
        monkeypatch.setattr(qr.wx, "_fetch_qr", fake.fetch_qr)
        monkeypatch.setattr(qr.wx, "_api_get", fake.api_get)
        return fake

    yield install
    qr._logins.clear()


def _run_login():
    """开始一次登录并等后台轮询结束，返回开始时的响应和最终状态。"""

    async def scenario():
        started = await qr.start_login(None)
        login = qr._logins[started["session_id"]]
        try:
            await login.task
        except asyncio.CancelledError:
            pass
        return started, await qr.login_status(started["session_id"])

    return asyncio.run(scenario())


CONFIRMED = {
    "status": "confirmed", "ilink_bot_id": "bot123@im.bot", "bot_token": "SECRET-TOKEN",
    "baseurl": "https://redirect.example", "ilink_user_id": "wxid_owner"}


def test_confirmed_login_saves_owner_only_access_and_never_returns_the_token(ilink):
    fake = ilink([
        {"status": "wait"}, {"status": "scaned"},
        {"status": "scaned_but_redirect", "redirect_host": "redirect.example"}, CONFIRMED])

    started, final = _run_login()

    assert started["state"] == "wait"
    assert started["qr_content"] == "https://liteapp.weixin.qq.com/q/qr-1"
    # 已扫码后状态变为 scanned；换服务器后从新地址继续查询。
    assert [state for _, _, state in fake.polled] == ["wait", "wait", "scanned", "scanned"]
    assert fake.polled[-1][0] == "https://redirect.example"
    assert final["state"] == "confirmed"
    assert final["needs_restart"] is True
    assert "SECRET-TOKEN" not in str(final) and "SECRET-TOKEN" not in str(started)

    env = load_env()
    assert env["WEIXIN_ACCOUNT_ID"] == "bot123@im.bot"
    assert env["WEIXIN_TOKEN"] == "SECRET-TOKEN"
    assert env["WEIXIN_BASE_URL"] == "https://redirect.example"
    assert env["WEIXIN_DM_POLICY"] == "allowlist"
    assert env["WEIXIN_ALLOWED_USERS"] == "wxid_owner"
    assert env["WEIXIN_ALLOW_ALL_USERS"] == "false"
    assert env["WEIXIN_GROUP_POLICY"] == "disabled"
    assert env["WEIXIN_HOME_CHANNEL"] == "wxid_owner"
    assert load_config()["platforms"]["weixin"]["enabled"] is True
    assert (Path(get_hermes_home()) / "weixin" / "accounts" / "bot123@im.bot.json").is_file()


def test_missing_owner_id_leaves_binding_incomplete(ilink):
    """扫码人缺失时不启用或覆盖旧配置，不把终端配对当成成功。"""
    ilink([{**CONFIRMED, "ilink_user_id": ""}])

    _, final = _run_login()

    env = load_env()
    assert final["state"] == "error"
    assert "WEIXIN_TOKEN" not in env
    assert "WEIXIN_DM_POLICY" not in env


def test_expired_qr_ends_the_login(ilink):
    # 与 UniWork 相同：过期就结束，由用户在页面上重新生成，不自动换码。
    fake = ilink([{"status": "expired"}, CONFIRMED], [("qr-1", "u1"), ("qr-2", "u2")])

    _, final = _run_login()

    assert final["state"] == "expired"
    assert len(fake.polled) == 1 and fake.qrs == [("qr-2", "u2")]
    assert "WEIXIN_TOKEN" not in load_env()


def test_incomplete_credentials_stop_without_writing(ilink):
    ilink([{**CONFIRMED, "bot_token": ""}])

    _, final = _run_login()

    assert final["state"] == "error"
    assert "WEIXIN_ACCOUNT_ID" not in load_env()


def test_new_login_replaces_the_previous_one(ilink):
    ilink([{"status": "wait"}] * 1000, [("qr-1", "u1"), ("qr-2", "u2")])

    async def scenario():
        first = await qr.start_login(None)
        await asyncio.sleep(0)
        second = await qr.start_login(None)
        await asyncio.sleep(0)
        states = [(await qr.login_status(item["session_id"]))["state"] for item in (first, second)]
        qr._cancel(qr._logins[second["session_id"]])
        return states

    # 旧二维码作废，免得之后被扫时覆盖新连接。
    assert asyncio.run(scenario()) == ["cancelled", "wait"]


def test_unbind_clears_credentials_and_only_that_accounts_files(ilink):
    home = Path(get_hermes_home())
    accounts = home / "weixin" / "accounts"
    accounts.mkdir(parents=True, exist_ok=True)
    for name in ("bot123@im.bot.json", "bot123@im.bot.sync.json", "other@im.bot.json"):
        (accounts / name).write_text("{}", encoding="utf-8")
    for key, value in {"WEIXIN_ACCOUNT_ID": "bot123@im.bot", "WEIXIN_TOKEN": "SECRET", "WEIXIN_BASE_URL": "https://x"}.items():
        save_env_value(key, value)

    result = asyncio.run(qr.unbind(None))

    env = load_env()
    assert result["ok"] is True and result["needs_restart"] is True
    assert not {"WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN", "WEIXIN_BASE_URL"} & set(env)
    assert load_config()["platforms"]["weixin"]["enabled"] is False
    assert sorted(p.name for p in accounts.iterdir()) == ["other@im.bot.json"]


def test_account_files_refuse_path_like_ids(tmp_path):
    assert qr._account_files(tmp_path, "../evil") == []
    assert qr._account_files(tmp_path, "a/b") == []
    assert qr._account_files(tmp_path, "") == []
    assert len(qr._account_files(tmp_path, "bot@im.bot")) == len(qr._ACCOUNT_FILE_SUFFIXES)


def test_routes_mount_under_the_plugin_prefix(ilink):
    ilink([{"status": "wait"}] * 1000)
    app = FastAPI()
    app.include_router(qr.router, prefix="/api/plugins/weixin-qr")

    with TestClient(app) as client:
        started = client.post("/api/plugins/weixin-qr/login/start")
        assert started.status_code == 200
        session_id = started.json()["session_id"]
        assert client.get(f"/api/plugins/weixin-qr/login/{session_id}").json()["state"] in {"wait", "scanned"}
        assert client.get("/api/plugins/weixin-qr/login/missing").status_code == 404


def test_start_reports_unavailable_qr_service(ilink, monkeypatch):
    async def broken(session, bot_type):
        raise OSError("network down")

    monkeypatch.setattr(qr.wx, "_fetch_qr", broken)

    with pytest.raises(qr.HTTPException) as caught:
        asyncio.run(qr.start_login(None))

    assert caught.value.status_code == 502
    assert qr._logins == {}


def test_concurrent_qr_requests_keep_only_latest_home_binding(ilink, monkeypatch):
    """同一 Home 的别名并发取码，迟到响应不能重新激活旧二维码。"""
    ilink([{"status": "wait"}] * 1000)

    async def scenario():
        """让第一个请求晚于第二个请求返回。"""
        entered, release = asyncio.Event(), asyncio.Event()

        async def fetch(session, bot_type):
            """固定取码响应乱序，不访问微信。"""
            if not entered.is_set():
                entered.set()
                await release.wait()
                return "old", "old"
            return "new", "new"

        monkeypatch.setattr(qr.wx, "_fetch_qr", fetch)
        first = asyncio.create_task(qr.start_login(None))
        await entered.wait()
        second = await qr.start_login("default")
        release.set()
        old = await first
        assert old["state"] == "cancelled"
        assert second["state"] == "wait"
        for login in qr._logins.values():
            qr._cancel(login)
        await asyncio.gather(*(x.task for x in qr._logins.values() if x.task), return_exceptions=True)

    asyncio.run(scenario())


def test_unbind_waits_for_inflight_save_and_remains_unbound(ilink, monkeypatch):
    """取消协程不能取消写盘线程；解绑必须排在在途写入之后。"""
    ilink([CONFIRMED])
    entered, release = threading.Event(), threading.Event()
    original = qr._apply
    restarts = []

    def delayed(profile, creds):
        """暂停真实写盘，稳定复现解绑竞争窗口。"""
        entered.set()
        assert release.wait(10)
        original(profile, creds)

    monkeypatch.setattr(qr, "_apply", delayed)
    monkeypatch.setattr(qr, "_restart", lambda profile: restarts.append(profile) or {})

    async def scenario():
        """放行旧线程后核对最终凭据与平台开关。"""
        started = await qr.start_login(None)
        login = qr._logins[started["session_id"]]
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            removing = asyncio.create_task(qr.unbind("default"))
            await asyncio.sleep(0.05)
            release.set()
            await removing
            await asyncio.gather(login.task, return_exceptions=True)
            assert not load_env().get("WEIXIN_TOKEN")
            assert load_config()["platforms"]["weixin"]["enabled"] is False
            assert login.state == "cancelled"
            assert not restarts
        finally:
            release.set()

    asyncio.run(scenario())


def test_unbind_invalidates_pending_qr_fetch_without_affecting_other_profile(ilink, monkeypatch):
    """解绑发生在取码期间，迟到二维码失效，其它 Profile 的二维码仍可用。"""
    from hermes_cli.profiles import create_profile

    create_profile("other")
    ilink([{"status": "wait"}] * 1000)

    async def scenario():
        """以屏障控制取码，不触碰任何真实凭据。"""
        entered, release = asyncio.Event(), asyncio.Event()

        async def fetch(session, bot_type):
            """仅第一个取码请求等待解绑。"""
            if not entered.is_set():
                entered.set()
                await release.wait()
            return "fixture", "fixture"

        async def poll(*args, **kwargs):
            """保持未扫码，不让零等待夹具耗尽响应而自行结束。"""
            await asyncio.Event().wait()

        monkeypatch.setattr(qr.wx, "_fetch_qr", fetch)
        monkeypatch.setattr(qr.wx, "_api_get", poll)
        pending = asyncio.create_task(qr.start_login(None))
        await entered.wait()
        other = await qr.start_login("other")
        await qr.unbind("default")
        release.set()
        assert (await pending)["state"] == "cancelled"
        assert qr._logins[other["session_id"]].state == "wait"
        tasks = [login.task for login in qr._logins.values() if login.task]
        for login in qr._logins.values():
            qr._cancel(login)
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())
