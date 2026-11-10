"""入口什么时候把企业资源清单送进员工实例（entry/enterprise.py 的 EnterpriseSync）。

- 策略变了、实例在跑：马上送；实例还没拿到：等拿到时送。清单没变不重送，实例换代了重送。
- 转发器说要重启 hermes 才生效：Docker 路径由入口重启容器；实例在忙就先不算装好，过一阵的请求再试。
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from entry import enterprise
from entry.config import Settings
from entry.enterprise import EnterpriseSync
from entry.tenants import Tenant


def _policy(instructions: str = "先写结论。") -> dict:
    return {
        "revision": "r1",
        "enterprise": {"tenantId": "tid-1", "serverUrl": "http://platform.test"},
        "models": {"models": [{"id": "uniwork-ds", "model": "deepseek-v4-flash"}], "main_model_id": "uniwork-ds"},
        "skills": [], "plugins": [], "connectors": [], "sharedLayers": [],
        "experts": [{"key": "agent:a1", "kind": "agent", "id": "a1", "name": "助手", "model": "",
                     "instructions": instructions, "skills": [], "plugins": [], "connectors": [],
                     "memory": "session", "approval": "smart", "revision": instructions}],
    }


class Forwarder:
    """转发器的 /__mt/enterprise：记下送来的清单，按设定回「要不要重启」「忙不忙」。"""

    def __init__(self) -> None:
        self.specs: list[dict] = []
        self.reply = {"restart_needed": False, "busy": False}
        self.report: dict = {"errors": []}
        self.server: TestServer | None = None

    async def start(self) -> "Forwarder":
        app = web.Application()
        app.router.add_post("/__mt/enterprise", self.install)
        self.server = TestServer(app)
        await self.server.start_server()
        return self

    async def install(self, request: web.Request) -> web.Response:
        assert request.headers.get("X-MT-Token") == "tok"
        body = await request.json()
        assert body["restart"] is True
        self.specs.append(body["spec"])
        return web.json_response({"ok": True, "report": self.report, "restarted": False, **self.reply})

    def tenant(self, host: str = "9121-sb1.cube.app") -> Tenant:
        assert self.server is not None
        return Tenant(user_id="u1", slug="u1", token="tok", ip="",
                      origin=f"{self.server.host}:{self.server.port}", host_header=host)


class Stub:
    """EnterpriseSync 用到的那一点入口。"""

    def __init__(self, http: aiohttp.ClientSession, use_cube: bool = True) -> None:
        self.s = Settings(uniwork_server="http://host.docker.internal:11220", key_env_name="KEY")
        self.http = http
        self.uniwork = None  # 不开长轮询
        self.tasks: list[asyncio.Task] = []
        self.restarts: list[str] = []
        self.audits: list[str] = []
        self.audit_details: list[tuple[str, dict]] = []
        context = SimpleNamespace(endpoint=None, catalog=[], limits={}, api_key="device-token")
        stub = self

        class Store:
            async def get_tenant_context(self, user_id: str):
                return context

            async def write_audit(self, user_id: str, action: str, detail: dict) -> None:
                stub.audits.append(action)
                stub.audit_details.append((action, detail))

        class Tenants:
            def __init__(self) -> None:
                self.use_cube = use_cube

            def _config_patch_spec(self, *args, **kwargs) -> dict:
                return {"template": "model:\n  default: m\n", "provider_key": "uniwork", "mcp_servers": {}}

            async def restart_container(self, user_id: str) -> Tenant:
                stub.restarts.append(user_id)
                return stub.next_tenant

        self.store, self.tenants = Store(), Tenants()
        self.next_tenant: Tenant | None = None

    def _spawn(self, coro) -> None:
        self.tasks.append(asyncio.ensure_future(coro))

    async def settle(self) -> None:
        while self.tasks:
            await self.tasks.pop(0)


@pytest.mark.asyncio
async def test_pushes_when_an_instance_appears_and_not_again_until_something_changes() -> None:
    fwd = await Forwarder().start()
    async with aiohttp.ClientSession() as http:
        entry = Stub(http)
        sync = EnterpriseSync(entry)  # type: ignore[arg-type]
        assert await sync.note_policy("u1", _policy()) is True
        await entry.settle()
        assert fwd.specs == []  # 还没有在跑的实例
        sync.after_ready("u1", fwd.tenant())
        await entry.settle()
        assert len(fwd.specs) == 1 and fwd.specs[0]["agents"][0]["instructions"] == "先写结论。"
        assert "device-token" not in str(fwd.specs[0])
        sync.after_ready("u1", fwd.tenant())  # 每个请求都会调：没变就不送
        assert await sync.note_policy("u1", {**_policy(), "revision": "r2"}) is False  # 只是版本号变了
        await entry.settle()
        assert len(fwd.specs) == 1
        assert await sync.note_policy("u1", _policy("改了。")) is True  # 实例在跑：马上送
        await entry.settle()
        assert len(fwd.specs) == 2 and fwd.specs[1]["agents"][0]["instructions"] == "改了。"
        sync.after_ready("u1", fwd.tenant("9121-sb2.cube.app"))  # 换代了（新实例从归档恢复）：再送一次
        await entry.settle()
        assert len(fwd.specs) == 3
        assert entry.audits.count("enterprise.apply") == 0  # 假转发器什么都没报「改了」
    assert fwd.server is not None
    await fwd.server.close()


@pytest.mark.asyncio
async def test_docker_restart_and_busy_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    fwd = await Forwarder().start()
    async with aiohttp.ClientSession() as http:
        entry = Stub(http, use_cube=False)
        sync = EnterpriseSync(entry)  # type: ignore[arg-type]
        await sync.note_policy("u1", _policy())
        # 要重启、不忙：Docker 路径由入口重启容器，算装好了
        fwd.reply = {"restart_needed": True, "busy": False}
        entry.next_tenant = fwd.tenant("127.0.0.1:9120")
        sync.after_ready("u1", fwd.tenant("127.0.0.1:9120"))
        await entry.settle()
        assert entry.restarts == ["u1"] and len(fwd.specs) == 1
        sync.after_ready("u1", fwd.tenant("127.0.0.1:9120"))
        await entry.settle()
        assert len(fwd.specs) == 1

        # 要重启、但在忙：不算装好；RETRY_S 之内的请求不重试，过了再试
        entry2 = Stub(http, use_cube=True)
        sync2 = EnterpriseSync(entry2)  # type: ignore[arg-type]
        await sync2.note_policy("u1", _policy())
        fwd.reply = {"restart_needed": True, "busy": True}
        clock = [1000.0]
        monkeypatch.setattr(enterprise.time, "monotonic", lambda: clock[0])
        sync2.after_ready("u1", fwd.tenant())
        await entry2.settle()
        assert len(fwd.specs) == 2 and entry2.restarts == []
        sync2.after_ready("u1", fwd.tenant())
        await entry2.settle()
        assert len(fwd.specs) == 2
        clock[0] += enterprise.RETRY_S + 1
        fwd.reply = {"restart_needed": False, "busy": False}
        sync2.after_ready("u1", fwd.tenant())
        await entry2.settle()
        assert len(fwd.specs) == 3
        sync2.after_ready("u1", fwd.tenant())
        await entry2.settle()
        assert len(fwd.specs) == 3
    assert fwd.server is not None
    await fwd.server.close()


@pytest.mark.asyncio
async def test_items_that_did_not_install_are_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    fwd = await Forwarder().start()
    fwd.report = {"errors": ["技能：下载失败"]}
    async with aiohttp.ClientSession() as http:
        entry = Stub(http)
        sync = EnterpriseSync(entry)  # type: ignore[arg-type]
        clock = [0.0]
        monkeypatch.setattr(enterprise.time, "monotonic", lambda: clock[0])
        await sync.note_policy("u1", _policy())
        for _ in range(2):
            sync.after_ready("u1", fwd.tenant())
            await entry.settle()
        assert len(fwd.specs) == 1  # 两分钟内不重试
        clock[0] += enterprise.ERROR_RETRY_S + 1
        fwd.report = {"errors": []}
        for _ in range(2):
            sync.after_ready("u1", fwd.tenant())
            await entry.settle()
        assert len(fwd.specs) == 2  # 再试一次，这回装齐了，之后不再送
    assert fwd.server is not None
    await fwd.server.close()


@pytest.mark.asyncio
async def test_spec_installed_at_bootstrap_is_not_pushed_again() -> None:
    """引导时已经装好（tenants._bootstrap_cube 调 boot_applied）：实例起来后不再送，平台运行环境的准备也不再
    等装资源、不再重启 hermes；实例换代了（新实例引导时没带清单）照旧再送。"""
    fwd = await Forwarder().start()
    async with aiohttp.ClientSession() as http:
        entry = Stub(http)
        sync = EnterpriseSync(entry)  # type: ignore[arg-type]
        assert sync.boot_spec("u1") is None  # 还没拉到策略：引导不带清单
        await sync.note_policy("u1", _policy())
        boot = sync.boot_spec("u1")
        assert boot is not None and boot[0]["agents"][0]["instructions"] == "先写结论。"
        sync.boot_applied("u1", "9121-sb1.cube.app", boot[1])
        sync.after_ready("u1", fwd.tenant())
        await entry.settle()
        assert await sync.apply_now("u1", fwd.tenant()) == {}
        assert fwd.specs == []
        sync.after_ready("u1", fwd.tenant("9121-sb2.cube.app"))
        await entry.settle()
        assert len(fwd.specs) == 1
    assert fwd.server is not None
    await fwd.server.close()


@pytest.mark.asyncio
async def test_spec_that_changed_during_bootstrap_is_still_pushed() -> None:
    """引导期间策略又变了：引导装的是旧的那份，不记成已装，实例起来后送新的。"""
    fwd = await Forwarder().start()
    async with aiohttp.ClientSession() as http:
        entry = Stub(http)
        sync = EnterpriseSync(entry)  # type: ignore[arg-type]
        await sync.note_policy("u1", _policy())
        boot = sync.boot_spec("u1")
        assert boot is not None
        await sync.note_policy("u1", _policy("改了。"))
        sync.boot_applied("u1", "9121-sb1.cube.app", boot[1])
        sync.after_ready("u1", fwd.tenant())
        await entry.settle()
        assert len(fwd.specs) == 1 and fwd.specs[0]["agents"][0]["instructions"] == "改了。"
    assert fwd.server is not None
    await fwd.server.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("enterprise", [True, False])
async def test_entry_startup_hands_the_spec_hooks_to_the_tenant_manager(monkeypatch: pytest.MonkeyPatch,
                                                                        enterprise: bool) -> None:
    """企业版入口启动时把 EnterpriseSync 的两个钩子接给 TenantManager：没接上，引导就不带清单，hermes 照旧
    装完资源再重启一次。个人版没有 EnterpriseSync，不接。"""
    from cryptography.fernet import Fernet

    from entry.app import Entry, build_app

    settings = Settings(base_path="/agents", database_url="postgresql://unused/db",
                        credential_key=Fernet.generate_key().decode(),
                        uniwork_server="http://platform.test" if enterprise else "", backend="cube",
                        cube_api="http://cube.test:3000", cube_proxy="http://proxy.test", cube_template="tpl-x",
                        channels_key="", cron_wake_lead_s=0)
    app = build_app(settings)
    entry = next(h.__self__ for h in app.on_startup if isinstance(getattr(h, "__self__", None), Entry))

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(entry.database, "connect", nothing)
    for name in ("_reconcile", "_reaper", "_revoker"):
        monkeypatch.setattr(entry, name, nothing)
    await entry.on_startup(app)
    try:
        assert entry.tenants is not None
        if enterprise:
            assert entry.ent is not None
            assert entry.tenants.boot_spec == entry.ent.boot_spec
            assert entry.tenants.boot_applied == entry.ent.boot_applied
        else:
            assert entry.ent is None and entry.tenants.boot_spec is None and entry.tenants.boot_applied is None
    finally:
        await asyncio.gather(*entry._bg, return_exceptions=True)
        if entry.http is not None:
            await entry.http.close()


@pytest.mark.asyncio
async def test_restart_inside_the_instance_is_audited_with_its_timing() -> None:
    """转发器为企业资源重启了 hermes：停、起各段用时和有没有等满被强杀记进审计 enterprise.restart。"""
    fwd = await Forwarder().start()
    timing = {"steps": {"apply": 1.1, "hermes_stop": 30.0, "ready": 8.2}, "killed": ["hermes"]}
    fwd.reply = {"restart_needed": False, "busy": False, "restarted": True, "timing": timing}
    async with aiohttp.ClientSession() as http:
        entry = Stub(http)
        sync = EnterpriseSync(entry)  # type: ignore[arg-type]
        await sync.note_policy("u1", _policy())
        await sync.apply_now("u1", fwd.tenant())
        assert ("enterprise.restart", {"timing": timing}) in entry.audit_details
    assert fwd.server is not None
    await fwd.server.close()
