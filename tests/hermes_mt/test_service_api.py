"""平台调用云端运行智能体的服务接口（docs/企业版对接/15、17）：真路由 + 真 PostgreSQL + 假平台 + 假实例。

假实例模拟转发器的 ``/__mt/api/*``（后面是 hermes gateway 的 /v1/runs）；实例管理换成记账的假货。
本机没有测试用的 PostgreSQL 时跳过（见 conftest.py 的 MT_TEST_PG_DSN）。
"""

from __future__ import annotations

import json

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry import service
from entry.app import Entry, build_app
from entry.config import Settings
from entry.enterprise import EnterpriseSync
from entry.tenants import Tenant, TenantManager
from entry.uniwork import Uniwork
from uniwork_fake import FakePlatform

SECRET = "svc-secret-for-tests-0123456789"
BASE = "/hermes/__entry/service/v1/runtimes"
AUTH = {"Authorization": f"Bearer {SECRET}"}
PROFILE = {"name": "合同审查助手", "description": "", "instructions": "你是合同审查助手。"}


class FakeInstance:
    """转发器的 /__mt/api/*：一次运行先回两段事件，第二段是终止事件。"""

    def __init__(self) -> None:
        self.runs: dict[str, str] = {}  # run_id → 状态
        self.posted: list[dict] = []
        self.last_event_ids: list[str] = []
        self.calls: list[str] = []
        self.enterprise: list[dict] = []  # 送进来的企业资源清单
        self.server: TestServer | None = None

    async def start(self) -> "FakeInstance":
        app = web.Application()
        app.router.add_get("/__mt/api/health", self.health)
        app.router.add_post("/__mt/api/v1/runs", self.post_run)
        app.router.add_get("/__mt/api/v1/runs/{run_id}", self.get_run)
        app.router.add_get("/__mt/api/v1/runs/{run_id}/events", self.events)
        app.router.add_post("/__mt/api/v1/runs/{run_id}/stop", self.stop)
        app.router.add_post("/__mt/api/v1/runs/{run_id}/approval", self.approval)
        app.router.add_post("/__mt/enterprise", self.install)
        self.server = TestServer(app)
        await self.server.start_server()
        return self

    @property
    def origin(self) -> str:
        assert self.server is not None
        return f"{self.server.host}:{self.server.port}"

    def _check(self, request: web.Request) -> None:
        if request.headers.get("X-MT-Token") != "instance-token":
            raise web.HTTPForbidden()

    async def health(self, request: web.Request) -> web.Response:
        self._check(request)
        self.calls.append("health")
        return web.json_response({"status": "ok"})

    async def post_run(self, request: web.Request) -> web.Response:
        self._check(request)
        self.posted.append(await request.json())
        run_id = f"run_{len(self.posted)}"
        self.runs[run_id] = "running"
        return web.json_response({"run_id": run_id, "status": "started", "replayed": False}, status=202)

    async def get_run(self, request: web.Request) -> web.Response:
        self._check(request)
        return web.json_response({"run_id": request.match_info["run_id"],
                                  "status": self.runs.get(request.match_info["run_id"], "unknown")})

    async def events(self, request: web.Request) -> web.StreamResponse:
        self._check(request)
        run_id = request.match_info["run_id"]
        last = request.headers.get("Last-Event-ID", "")
        self.last_event_ids.append(last)
        frames = [
            {"event": "message.delta", "delta": "好的", "seq": 0},
            {"event": "run.completed", "output": "好的", "usage": {"input_tokens": 3}, "seq": 1},
        ]
        out = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await out.prepare(request)
        for frame in frames:
            if last and frame["seq"] <= int(last):
                continue
            await out.write(f"id: {frame['seq']}\ndata: {json.dumps(frame, ensure_ascii=False)}\n\n".encode())
        self.runs[run_id] = "completed"
        await out.write_eof()
        return out

    async def stop(self, request: web.Request) -> web.Response:
        self._check(request)
        self.calls.append("stop")
        return web.json_response({"run_id": request.match_info["run_id"], "status": "stopping"})

    async def approval(self, request: web.Request) -> web.Response:
        self._check(request)
        self.calls.append("approval:" + (await request.json()).get("choice", ""))
        return web.json_response({"ok": True})

    async def install(self, request: web.Request) -> web.Response:
        self._check(request)
        body = await request.json()
        self.enterprise.append(body["spec"])
        self.calls.append("enterprise")
        return web.json_response({"ok": True, "report": {"installed": ["x"], "errors": []}, "restarted": False,
                                  "busy": False, "restart_needed": False})


class FakeTenants:
    """实例管理的假货：拉起即指向假实例，其余只记账。"""

    use_cube = True

    def __init__(self, instance: FakeInstance, store, settings: Settings | None = None) -> None:
        self.instance, self.store = instance, store
        self.real = TenantManager(settings or Settings(), None, None, None)  # type: ignore[arg-type]
        self.started: list[str] = []
        self.applied: list[tuple[str, str]] = []
        self.restarted: list[str] = []
        self.deleted: list[str] = []

    async def ensure_running(self, user_id: str, *, touch: bool = True) -> Tenant:
        self.started.append(user_id)
        return Tenant(user_id=user_id, slug="t", ip="", token="instance-token", origin=self.instance.origin)

    async def apply_service_spec(self, user_id: str, applied_sha256: str) -> bool:
        self.applied.append((user_id, applied_sha256))
        return False

    async def restart_service(self, user_id: str) -> None:
        self.restarted.append(user_id)

    async def delete_service(self, user_id: str) -> None:
        self.deleted.append(user_id)
        await self.store.delete_user(user_id)

    def _config_patch_spec(self, *args, **kwargs) -> dict:
        return {"template": "model:\n  default: m\n", "provider_key": "uniwork", "mcp_servers": {}}


class Harness:
    def __init__(self, entry, tenants: FakeTenants, platform: FakePlatform, instance: FakeInstance, client):
        self.entry, self.tenants, self.platform, self.instance, self.client = entry, tenants, platform, instance, client

    @property
    def store(self):
        return self.entry.store

    async def put(self, key: str, token: str, tenant_id: str = "tid-1", headers: dict | None = None):
        response = await self.client.put(
            f"{BASE}/{key}", params={"tenantId": tenant_id}, headers=headers or AUTH,
            json={"tenantId": tenant_id, "tenantCode": "T1", "label": "Agent · 合同", "kind": "agent",
                  "deviceToken": token, "refresh": True})
        return response.status, await response.json()


async def _harness(database_url: str, ent: bool = False, **overrides):
    platform = await FakePlatform().start()
    instance = await FakeInstance().start()
    settings = Settings(base_path="/hermes", database_url=database_url, credential_key=Fernet.generate_key().decode(),
                        uniwork_server=platform.url, **{"service_secret": SECRET, **overrides})
    app = build_app(settings)
    hook = next(h for h in app.on_startup if isinstance(getattr(h, "__self__", None), Entry))
    entry = hook.__self__
    tenants = FakeTenants(instance, entry.store, settings)

    async def startup(_app) -> None:
        await entry.database.connect()
        entry.http = aiohttp.ClientSession()
        entry.uniwork = Uniwork(settings, entry.http)
        entry.tenants = tenants
        if ent:
            entry.ent = EnterpriseSync(entry)

    app.on_startup.remove(hook)
    app.on_startup.append(startup)
    client = TestClient(TestServer(app))
    await client.start_server()
    return Harness(entry, tenants, platform, instance, client)


@pytest_asyncio.fixture
async def harness(postgres_database_url: str):
    h = await _harness(postgres_database_url)
    try:
        yield h
    finally:
        await h.client.close()
        await h.platform.close()
        assert h.instance.server is not None
        await h.instance.server.close()


async def _sse(response) -> list[dict]:
    events = []
    async for line in response.content:
        if line.startswith(b"data:"):
            events.append(json.loads(line[5:]))
    return events


@pytest.mark.asyncio
async def test_without_secret_the_whole_api_is_hidden(postgres_database_url: str) -> None:
    h = await _harness(postgres_database_url, service_secret="")
    try:
        response = await h.client.get(BASE, params={"tenantId": "tid-1"}, headers=AUTH)
        assert response.status == 404
    finally:
        await h.client.close()
        await h.platform.close()
        await h.instance.server.close()


@pytest.mark.asyncio
async def test_wrong_secret_is_401_and_foreign_source_is_403(postgres_database_url: str) -> None:
    h = await _harness(postgres_database_url, service_allow="192.168.0.50")
    try:
        bad = await h.client.get(BASE, params={"tenantId": "tid-1"},
                                 headers={"Authorization": "Bearer nope", "X-Real-IP": "192.168.0.50"})
        assert bad.status == 401 and (await bad.json())["code"] == "unauthorized"
        foreign = await h.client.get(BASE, params={"tenantId": "tid-1"}, headers={**AUTH, "X-Real-IP": "10.9.9.9"})
        assert foreign.status == 403 and (await foreign.json())["code"] == "forbidden_source"
        ok = await h.client.get(BASE, params={"tenantId": "tid-1"}, headers={**AUTH, "X-Real-IP": "192.168.0.50"})
        assert ok.status == 200
    finally:
        await h.client.close()
        await h.platform.close()
        await h.instance.server.close()


@pytest.mark.asyncio
async def test_put_prepares_runtime_with_platform_token_model_and_persona(harness: Harness) -> None:
    token = harness.platform.issue_runtime_token(PROFILE)
    status, body = await harness.put("agent-a1", token)
    assert status == 200 and body["status"] == "ready" and body["runtimeKey"] == "agent-a1"

    user_id = "svc:tid-1:agent-a1"
    assert harness.tenants.started == [user_id]
    assert harness.tenants.applied == [(user_id, "")]  # 第一次：还没有生效过的规格
    context = await harness.store.get_tenant_context(user_id)
    assert context.service is True
    assert context.api_key == token  # 平台给的设备令牌就是实例的模型 key
    assert context.endpoint == (f"{harness.platform.url}/v1", "deepseek-v4-flash")
    assert "你是合同审查助手。" in context.persona and context.persona.startswith("# 合同审查助手")


@pytest.mark.asyncio
async def test_put_with_unknown_token_says_why(harness: Harness) -> None:
    status, body = await harness.put("agent-a1", "uwd_not_issued")
    assert status == 400 and body["code"] == "device_token_invalid" and "令牌" in body["error"]


@pytest.mark.asyncio
async def test_run_streams_started_then_hermes_events_and_frees_runtime(harness: Harness) -> None:
    await harness.put("agent-a1", harness.platform.issue_runtime_token(PROFILE))
    q = {"tenantId": "tid-1"}
    start = await harness.client.post(f"{BASE}/agent-a1/runs", params=q, headers=AUTH,
                                      json={"input": "审一下这份合同", "session_id": "ses_1"})
    assert start.status == 202
    run_id = (await start.json())["run_id"]
    assert harness.instance.posted == [{"input": "审一下这份合同", "session_id": "ses_1"}]

    busy = await harness.client.post(f"{BASE}/agent-a1/runs", params=q, headers=AUTH, json={"input": "再来"})
    assert busy.status == 409 and (await busy.json())["code"] == "runtime_busy"

    stream = await harness.client.get(f"{BASE}/agent-a1/runs/{run_id}/events", params=q, headers=AUTH)
    events = await _sse(stream)
    assert [e["event"] for e in events] == ["run.started", "message.delta", "run.completed"]
    assert [e.get("seq") for e in events[1:]] == [0, 1]  # hermes 的 seq 原样保留：平台靠它续传去重

    (rt,) = await harness.store.find_service_runtimes("agent-a1", "tid-1")
    assert rt.current_run_id == ""  # 看到终止事件就放开，可以接着跑下一次
    again = await harness.client.post(f"{BASE}/agent-a1/runs", params=q, headers=AUTH, json={"input": "下一份"})
    assert again.status == 202


@pytest.mark.asyncio
async def test_reconnect_with_last_event_id_resumes_without_a_second_started(harness: Harness) -> None:
    await harness.put("agent-a1", harness.platform.issue_runtime_token(PROFILE))
    q = {"tenantId": "tid-1"}
    run_id = (await (await harness.client.post(f"{BASE}/agent-a1/runs", params=q, headers=AUTH,
                                               json={"input": "x"})).json())["run_id"]
    stream = await harness.client.get(f"{BASE}/agent-a1/runs/{run_id}/events", params=q,
                                      headers={**AUTH, "Last-Event-ID": "0"})
    events = await _sse(stream)
    assert [e["event"] for e in events] == ["run.completed"]
    assert harness.instance.last_event_ids == ["0"]


@pytest.mark.asyncio
async def test_same_key_in_two_tenants_needs_tenant_id(harness: Harness) -> None:
    await harness.put("agent-lib", harness.platform.issue_runtime_token(PROFILE), tenant_id="tid-1")
    await harness.put("agent-lib", harness.platform.issue_runtime_token(PROFILE), tenant_id="tid-2")
    ambiguous = await harness.client.post(f"{BASE}/agent-lib/runs", headers=AUTH, json={"input": "x"})
    assert ambiguous.status == 400 and (await ambiguous.json())["code"] == "tenant_required"
    scoped = await harness.client.post(f"{BASE}/agent-lib/runs", params={"tenantId": "tid-2"}, headers=AUTH,
                                       json={"input": "x"})
    assert scoped.status == 202
    listed = await (await harness.client.get(BASE, params={"tenantId": "tid-2"}, headers=AUTH)).json()
    assert [item["runtimeKey"] for item in listed["items"]] == ["agent-lib"]


@pytest.mark.asyncio
async def test_stop_and_approval_pass_through(harness: Harness) -> None:
    await harness.put("agent-a1", harness.platform.issue_runtime_token(PROFILE))
    q = {"tenantId": "tid-1"}
    run_id = (await (await harness.client.post(f"{BASE}/agent-a1/runs", params=q, headers=AUTH,
                                               json={"input": "x"})).json())["run_id"]
    stop = await harness.client.post(f"{BASE}/agent-a1/runs/{run_id}/stop", params=q, headers=AUTH, json={})
    approval = await harness.client.post(f"{BASE}/agent-a1/runs/{run_id}/approval", params=q, headers=AUTH,
                                         json={"choice": "once"})
    assert stop.status == 200 and approval.status == 200
    assert [c for c in harness.instance.calls if c != "health"] == ["stop", "approval:once"]


@pytest.mark.asyncio
async def test_put_waits_until_the_api_server_answers(harness: Harness) -> None:
    await harness.put("agent-a1", harness.platform.issue_runtime_token(PROFILE))
    assert harness.instance.calls == ["health"]  # ready 以 gateway 的 API 服务能用为准，不是只看实例起来


@pytest.mark.asyncio
async def test_delete_removes_runtime_and_is_idempotent(harness: Harness) -> None:
    await harness.put("agent-a1", harness.platform.issue_runtime_token(PROFILE))
    q = {"tenantId": "tid-1"}
    first = await harness.client.delete(f"{BASE}/agent-a1", params=q, headers=AUTH)
    assert first.status == 200 and (await first.json())["deleted"] is True
    assert harness.tenants.deleted == ["svc:tid-1:agent-a1"]
    assert await harness.store.find_service_runtimes("agent-a1", "tid-1") == []
    second = await harness.client.delete(f"{BASE}/agent-a1", params=q, headers=AUTH)
    assert second.status == 200 and (await second.json())["deleted"] is False


def test_persona_comes_from_agent_profile() -> None:
    assert service.persona_of({"agentProfile": {"name": "A", "instructions": "做事"}}) == "# A\n\n做事\n"
    # 企业经验里 inline 的事实接在后面，和员工实例里 Agent 的人设同一种写法
    layered = {"agentProfile": {"name": "A", "instructions": "做事"},
               "sharedLayers": [{"facts": {"inline": True, "items": [{"title": "口径", "content": "保留一位小数"}]}}]}
    assert service.persona_of(layered) == ("# A\n\n做事\n\n## 企业事实\n"
                                           "以下是企业统一的口径、规则和术语，经企业审核发布。回答相关问题时必须遵守：\n"
                                           "- **口径**：保留一位小数\n")
    assert service.persona_of({"agentProfile": {"instructions": " "}}) == ""
    assert service.persona_of({}) == ""


@pytest.mark.asyncio
async def test_run_id_that_could_escape_the_runs_path_is_rejected(harness: Harness) -> None:
    await harness.put("agent-a1", harness.platform.issue_runtime_token(PROFILE))
    q = {"tenantId": "tid-1"}
    for path in (f"{BASE}/agent-a1/runs/..", f"{BASE}/agent-a1/runs/..%2Fhealth/stop"):
        response = await harness.client.get(path, params=q, headers=AUTH)
        assert response.status in (400, 404, 405)
        if response.status == 400:
            assert (await response.json())["code"] == "invalid_run_id"
    bad = await harness.client.get(f"{BASE}/agent-a1/runs/run.1", params=q, headers=AUTH)
    assert bad.status == 400 and (await bad.json())["code"] == "invalid_run_id"


@pytest.mark.asyncio
async def test_put_installs_the_runtimes_skills_and_connectors_before_ready(postgres_database_url: str) -> None:
    """15 的验收 2：准备运行环境时，把策略里的技能、连接器、企业经验整份送进实例的默认 profile，装完才回 ready。"""
    h = await _harness(postgres_database_url, ent=True)
    try:
        extra = {
            "skills": [{"id": "f1", "name": "sales-margin", "sha256": "a" * 64,
                        "url": f"{h.platform.url}/api/client/files/f1"}],
            "connectors": [{"id": "demo-sales", "name": "销售演示库", "url": "http://192.168.0.50:11231/mcp",
                            "transport": "http", "timeout": 20,
                            "relay": f"{h.platform.url}/api/client/connectors/demo-sales/mcp"}],
            "experts": [{"key": "agent:other", "kind": "agent", "id": "other"}],  # 管理员自己能看到的，不装
        }
        token = h.platform.issue_runtime_token(PROFILE, extra)
        status, body = await h.put("agent-a1", token)
        assert status == 200 and body["status"] == "ready"
        [spec] = h.instance.enterprise
        assert spec["agents"] == [] and spec["tenant"] == "tid-1"
        assert [s["id"] for s in spec["default"]["skills"]] == ["f1"]
        assert spec["default"]["connectors"][0]["relay"] == f"{h.platform.url}/api/client/connectors/demo-sales/mcp"
        assert h.instance.calls.index("enterprise") < h.instance.calls.index("health")  # 装完才等 API、回 ready
        # 策略没变：再准备一次不再送
        status, _ = await h.put("agent-a1", token)
        assert status == 200 and len(h.instance.enterprise) == 1
    finally:
        await h.client.close()
        await h.platform.close()
        await h.instance.server.close()
