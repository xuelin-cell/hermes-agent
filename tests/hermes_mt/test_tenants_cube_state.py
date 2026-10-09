"""沙箱后端的实例生命周期与状态归档编排（entry/tenants.py 的 _*_cube）。

用假的 Cube 客户端和假的 Store，不碰平台也不碰 PostgreSQL。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pytest

from entry import tenants as tenants_module
from entry.config import Settings
from entry.cube_api import CubeError, SandboxGone
from entry.store import Runtime, TenantContext
from entry.tenants import TenantManager

# 入口镜像里 seed/ 被拷到 entry/ 旁边；仓库里它在 deploy/hermes-mt/seed。
tenants_module.SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"


@dataclass
class FakeStore:
    runtime: Runtime = field(default_factory=lambda: Runtime("stopped", "", "", 0, "", "", ""))
    calls: list = field(default_factory=list)
    epoch: int = 0
    cron_due: list = field(default_factory=list)   # cron_due_tenants 返回的 (user_id, 到点时间)

    async def ensure_tenant_token(self, user_id):
        return "tok"

    async def get_tenant_context(self, user_id):
        return TenantContext(api_key="k", container_token="tok", endpoint=("http://plan/v1", "m1"), catalog=[("m1", ""), ("m2", "")])

    async def get_runtime(self, user_id):
        return self.runtime

    async def get_sandbox_id(self, user_id):
        return self.runtime.sandbox_id

    async def next_epoch(self, user_id):
        self.epoch = self.runtime.state_epoch + 1
        self.runtime = Runtime(self.runtime.state, self.runtime.sandbox_id, self.runtime.template_id,
                               self.epoch, self.runtime.state_owner, self.runtime.state_archive, self.runtime.lifecycle)
        return self.epoch

    async def record_sandbox(self, user_id, sandbox_id, template_id, epoch, traffic_token=""):
        self.calls.append(("record_sandbox", sandbox_id, template_id, epoch))
        if traffic_token:
            self.calls.append(("traffic_token", sandbox_id, traffic_token))
        self.runtime = Runtime(self.runtime.state, sandbox_id, template_id, epoch,
                               self.runtime.state_owner, self.runtime.state_archive, "", traffic_token)

    @asynccontextmanager
    async def advisory_lock(self, user_id):
        self.calls.append(("pg_lock", "in"))
        try:
            yield
        finally:
            self.calls.append(("pg_lock", "out"))

    async def set_sandbox_id(self, user_id, sandbox_id):
        self.calls.append(("set_sandbox_id", sandbox_id))
        self.runtime = Runtime(self.runtime.state, sandbox_id or "", self.runtime.template_id, self.runtime.state_epoch,
                               self.runtime.state_owner, self.runtime.state_archive, self.runtime.lifecycle,
                               self.runtime.traffic_token if sandbox_id else "")

    async def set_state_owner(self, user_id, owner, archive, manifest):
        self.calls.append(("set_state_owner", owner, archive))
        self.runtime = Runtime(self.runtime.state, self.runtime.sandbox_id, self.runtime.template_id,
                               self.runtime.state_epoch, owner, archive or self.runtime.state_archive, self.runtime.lifecycle)

    async def set_state_archive(self, user_id, archive, manifest):
        self.calls.append(("set_state_archive", archive))

    async def set_lifecycle(self, user_id, phase):
        self.calls.append(("lifecycle", phase))

    async def mark_sandbox_deleted(self, sandbox_id, reason):
        self.calls.append(("deleted", sandbox_id, reason))

    async def set_tenant_state(self, user_id, state):
        self.calls.append(("state", state))
        self.runtime = Runtime(state, self.runtime.sandbox_id, self.runtime.template_id, self.runtime.state_epoch,
                               self.runtime.state_owner, self.runtime.state_archive, self.runtime.lifecycle)

    async def touch_tenant(self, user_id):
        self.calls.append(("touch",))

    async def set_next_cron(self, user_id, at):
        self.calls.append(("next_cron", at))

    async def cron_due_tenants(self, within_s):
        return list(self.cron_due)

    async def mark_cron_woken(self, user_id, at):
        self.calls.append(("cron_woken", at))
        self.cron_due = [(u, d) for u, d in self.cron_due if (u, d) != (user_id, at)]

    async def idle_tenants(self, older_than_s, exclude=None):
        return ["u"] if self.runtime.state == "running" and "u" not in (exclude or set()) else []

    async def write_audit(self, user_id, event_type, details=None):
        self.calls.append(("audit", event_type))

    async def tenants_with_sandbox(self):
        return [("u", self.runtime.sandbox_id, self.runtime.state)] if self.runtime.sandbox_id else []

    async def all_tenant_states(self):
        return [("u", self.runtime.state, 0)]

    async def long_idle_tenants(self, older_than_s):
        return ["u"] if self.runtime.state == "stopped" and self.runtime.sandbox_id else []


class FakeCube:
    def __init__(self, sandboxes: dict[str, dict] | None = None, drain_ok: bool = True):
        self.sandboxes = dict(sandboxes or {})
        self.calls: list = []
        self.drain_ok = drain_ok
        self.proxy_base = "http://proxy"
        self.template = "tpl-new"
        self.counter = 0
        self.hermes_ready: set[str] = set(self.sandboxes)
        self.tokens: dict[str, str] = {}
        self.boot_failures: list[CubeError] = []   # 每次 bootstrap 先弹一个出来抛，空了就正常
        self.gone_during_wait: set[str] = set()     # 等就绪时被外部删掉的实例
        self.activity: dict | None = None            # 转发器报的忙不忙；None = 老转发器，不报
        self.sync_error: CubeError | None = None
        self.status_error: CubeError | None = None

    def host_for(self, sandbox_id, port):
        return f"{port}-{sandbox_id}.cube.app"

    def register_traffic_token(self, sandbox_id, token):
        self.tokens[sandbox_id] = token

    def forget_traffic_token(self, sandbox_id):
        self.tokens.pop(sandbox_id, None)

    def traffic_token(self, sandbox_id):
        return self.tokens.get(sandbox_id, "")

    async def ensure_volume(self, name, driver=""):
        self.calls.append(("ensure_volume", name))
        return False

    async def get_sandbox(self, sandbox_id):
        return self.sandboxes.get(sandbox_id)

    async def create_sandbox(self, *, volume_name, workspace_path, metadata=None, template="", allow_internet=True,
                             private_traffic=False):
        self.counter += 1
        sid = f"sb{self.counter}"
        self.sandboxes[sid] = {"sandboxID": sid, "templateID": self.template, "state": "running"}
        self.calls.append(("create", sid, workspace_path, private_traffic))
        if private_traffic:
            self.tokens[sid] = f"tt-{sid}"
        return sid

    async def wait_forwarder(self, sandbox_id, port, timeout_s=120):
        self.calls.append(("wait_forwarder", sandbox_id))

    async def bootstrap(self, sandbox_id, port, *, token, files, ready_timeout_s=240, state=None):
        self.calls.append(("bootstrap", sandbox_id, state))
        if self.boot_failures:
            raise self.boot_failures.pop(0)
        self.hermes_ready.add(sandbox_id)
        return {"ok": True, "state": {"restored_from": (state or {}).get("restore_from", ""), "archive": "a.tar.gz",
                                      "counts": {"state.db": {"messages": 3}}, "notes": []}}

    async def wait_hermes(self, sandbox_id, port, timeout_s=240):
        if sandbox_id in self.gone_during_wait:
            self.gone_during_wait.discard(sandbox_id)
            self.sandboxes.pop(sandbox_id, None)
            raise SandboxGone(404, "gone")
        if sandbox_id not in self.hermes_ready:
            raise CubeError(0, "not ready")
        self.calls.append(("wait_hermes", sandbox_id))

    def _reply(self, archive: str) -> dict:
        body: dict = {"ok": True, "archive": {"archive": archive}}
        if self.activity is not None:
            body["activity"] = dict(self.activity)
        return body

    async def status(self, sandbox_id, port):
        self.calls.append(("status", sandbox_id))
        if self.status_error is not None:
            raise self.status_error
        body = {"bootstrapped": sandbox_id in self.hermes_ready, "boot_window_left_s": 500}
        if self.activity is not None:
            body["activity"] = dict(self.activity)
        return body

    async def sync_state(self, sandbox_id, port, token):
        self.calls.append(("sync", sandbox_id))
        if self.sync_error is not None:
            raise self.sync_error
        return self._reply("sync.tar.gz")

    async def drain(self, sandbox_id, port, token):
        self.calls.append(("drain", sandbox_id))
        if not self.drain_ok:
            raise CubeError(500, "drain failed")
        return self._reply("final.tar.gz")

    async def remove_sandbox(self, sandbox_id):
        self.calls.append(("remove", sandbox_id))
        self.sandboxes.pop(sandbox_id, None)

    async def wait_gone(self, sandbox_id, timeout_s=60):
        return sandbox_id not in self.sandboxes

    async def pause_sandbox(self, sandbox_id):
        self.calls.append(("pause", sandbox_id))
        self.sandboxes[sandbox_id]["state"] = "paused"


def _manager(store, cube, **overrides) -> TenantManager:
    kwargs = {"backend": "cube", "cube_template": "tpl-new", "cube_volume_mount": "/mnt/u",
              "volume_detach_grace_s": 0, **overrides}
    return TenantManager(Settings(**kwargs), None, store, None, cube)  # type: ignore[arg-type]


async def _no_key_sync(self, tenant, api_key):
    return None


@pytest.mark.asyncio
async def test_new_user_creates_instance_with_state_block(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store, cube = FakeStore(), FakeCube()
    manager = _manager(store, cube)
    tenant = await manager.ensure_running("u")
    assert tenant.sandbox_id == "sb1"
    create = next(c for c in cube.calls if c[0] == "create")
    assert create[2] == "/mnt/u"
    boot = next(c for c in cube.calls if c[0] == "bootstrap")
    assert boot[2] == {"vol": "/mnt/u", "owner": "sb1", "epoch": 1, "restore_from": "", "force": False, "archive_interval_s": 300}
    assert ("record_sandbox", "sb1", "tpl-new", 1) in store.calls
    assert ("set_state_owner", "sb1", "a.tar.gz") in store.calls
    assert store.runtime.state == "running"


@pytest.mark.asyncio
async def test_gone_instance_is_recreated_restoring_from_previous_owner(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("stopped", "sbOld", "tpl-new", 4, "sbOld", "old.tar.gz", ""))
    cube = FakeCube()  # sbOld 不在平台上
    await _manager(store, cube).ensure_running("u")
    assert ("deleted", "sbOld", "gone") in store.calls
    boot = next(c for c in cube.calls if c[0] == "bootstrap")
    assert boot[2]["restore_from"] == "sbOld" and boot[2]["epoch"] == 5 and boot[2]["owner"] == "sb1"


@pytest.mark.asyncio
async def test_template_change_drains_deletes_then_recreates(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("running", "sbOld", "tpl-old", 2, "sbOld", "x.tar.gz", ""))
    cube = FakeCube({"sbOld": {"sandboxID": "sbOld", "templateID": "tpl-old", "state": "running"}})
    tenant = await _manager(store, cube).ensure_running("u")
    kinds = [c[0] for c in cube.calls]
    assert kinds.index("drain") < kinds.index("remove") < kinds.index("create")
    assert ("set_state_archive", "final.tar.gz") in store.calls
    assert ("deleted", "sbOld", "template tpl-old -> tpl-new") in store.calls
    assert tenant.sandbox_id == "sb1"
    boot = next(c for c in cube.calls if c[0] == "bootstrap")
    assert boot[2]["restore_from"] == "sbOld"
    lifecycle = [c[1] for c in store.calls if c[0] == "lifecycle"]
    assert lifecycle == ["draining", "drained", "deleting", ""]


@pytest.mark.asyncio
async def test_drain_failure_keeps_old_instance(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("running", "sbOld", "tpl-old", 2, "sbOld", "x.tar.gz", ""))
    cube = FakeCube({"sbOld": {"sandboxID": "sbOld", "templateID": "tpl-old", "state": "running"}}, drain_ok=False)
    tenant = await _manager(store, cube).ensure_running("u")
    assert tenant.sandbox_id == "sbOld"
    assert not any(c[0] in ("remove", "create") for c in cube.calls)
    assert ("lifecycle", "") in store.calls


@pytest.mark.asyncio
async def test_alias_template_never_triggers_rebuild(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("running", "sbOld", "tpl-old", 2, "sbOld", "", ""))
    cube = FakeCube({"sbOld": {"sandboxID": "sbOld", "templateID": "tpl-old", "state": "running"}})
    tenant = await _manager(store, cube, cube_template="hermes-mt").ensure_running("u")
    assert tenant.sandbox_id == "sbOld"
    assert not any(c[0] == "drain" for c in cube.calls)


@pytest.mark.asyncio
async def test_unbootstrapped_instance_gets_bootstrapped(monkeypatch) -> None:
    """引导失败但实例 ID 已落库：下一次请求补引导，而不是永远等 hermes。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("stopped", "sbX", "tpl-new", 3, "sbPrev", "p.tar.gz", ""))
    cube = FakeCube({"sbX": {"sandboxID": "sbX", "templateID": "tpl-new", "state": "running"}})
    cube.hermes_ready.discard("sbX")
    tenant = await _manager(store, cube).ensure_running("u")
    assert tenant.sandbox_id == "sbX"
    boot = next(c for c in cube.calls if c[0] == "bootstrap")
    assert boot[1] == "sbX" and boot[2]["restore_from"] == "sbPrev" and boot[2]["epoch"] == 3


@pytest.mark.asyncio
async def test_idle_stop_syncs_before_pause() -> None:
    store = FakeStore(runtime=Runtime("running", "sb1", "tpl-new", 1, "sb1", "", ""))
    cube = FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "running"}})
    await _manager(store, cube).stop("u", reason="idle")
    kinds = [c[0] for c in cube.calls]
    assert kinds.index("sync") < kinds.index("pause")
    assert ("set_state_archive", "sync.tar.gz") in store.calls
    assert store.runtime.state == "stopped"


@pytest.mark.asyncio
async def test_long_idle_drains_and_deletes() -> None:
    store = FakeStore(runtime=Runtime("stopped", "sb1", "tpl-new", 1, "sb1", "", ""))
    cube = FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "paused"}})
    manager = _manager(store, cube, idle_delete_hours=24)
    await manager.reap_long_idle()
    kinds = [c[0] for c in cube.calls]
    assert kinds.index("drain") < kinds.index("remove")
    assert store.runtime.sandbox_id == ""
    assert ("deleted", "sb1", "idle>24h") in store.calls


@pytest.mark.asyncio
async def test_long_idle_disabled_by_default() -> None:
    store = FakeStore(runtime=Runtime("stopped", "sb1", "tpl-new", 1, "sb1", "", ""))
    cube = FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "paused"}})
    await _manager(store, cube).reap_long_idle()
    assert cube.calls == []


@pytest.mark.asyncio
async def test_reconcile_follows_platform_state() -> None:
    store = FakeStore(runtime=Runtime("stopped", "sb1", "tpl-new", 1, "sb1", "", ""))
    cube = FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "running"}})
    await _manager(store, cube).reconcile()
    assert ("state", "running") in store.calls  # 还在跑的实例不能被记成已停

    store = FakeStore(runtime=Runtime("running", "sbGone", "tpl-new", 1, "sbGone", "", ""))
    await _manager(store, FakeCube()).reconcile()
    assert ("deleted", "sbGone", "gone") in store.calls and ("set_sandbox_id", None) in store.calls
    assert store.runtime.state == "stopped"


def test_seed_files_use_patch_and_upsert_modes() -> None:
    manager = _manager(FakeStore(), FakeCube())
    files = manager._cube_seed_files("key", ("http://plan/v1", "m1"), [("m1", ""), ("m2", "")])
    modes = [(f["path"], f["overwrite"]) for f in files]
    assert modes == [("config.yaml", "if-pristine"), ("config.yaml", "patch-model"), (".env", "upsert-lines")]
    assert '"models": ["m1", "m2"]' in files[1]["content"]
    assert files[2]["content"].splitlines() == ["TERMINAL_ENV=local", "HERMES_CUSTOM_YUANJING_API_KEY=key"]


@pytest.mark.asyncio
async def test_waking_paused_instance_writes_resume_audit(monkeypatch) -> None:
    """平台不通知唤醒，入口在把暂停的实例叫醒后自己记一笔 tenant.resume。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("stopped", "sbA", "tpl-new", 2, "sbA", "x.tar.gz", ""))
    cube = FakeCube({"sbA": {"sandboxID": "sbA", "templateID": "tpl-new", "state": "paused"}})
    await _manager(store, cube).ensure_running("u")
    assert ("audit", "tenant.resume") in store.calls
    # 快路径：实例在、模板对、引导过 ⇒ 不拿跨副本的锁
    assert ("pg_lock", "in") not in store.calls


@pytest.mark.asyncio
async def test_running_instance_does_not_write_resume_audit(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("running", "sbA", "tpl-new", 2, "sbA", "x.tar.gz", ""))
    cube = FakeCube({"sbA": {"sandboxID": "sbA", "templateID": "tpl-new", "state": "running"}})
    await _manager(store, cube).ensure_running("u")
    assert ("audit", "tenant.resume") not in store.calls


@pytest.mark.asyncio
async def test_mutations_take_pg_lock_and_reread_runtime(monkeypatch) -> None:
    """要动实例（新建 / 没了 / 换模板）时先拿 PG 咨询锁，锁里重读运行态；快路径不拿。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store, cube = FakeStore(), FakeCube()
    await _manager(store, cube).ensure_running("u")
    kinds = [c[0] for c in store.calls]
    assert kinds.index("pg_lock") < kinds.index("record_sandbox") < kinds.index("pg_lock", kinds.index("pg_lock") + 1)
    assert store.calls.count(("pg_lock", "in")) == 1 and store.calls.count(("pg_lock", "out")) == 1
    # 关掉开关：一次都不拿
    store2, cube2 = FakeStore(), FakeCube()
    await _manager(store2, cube2, pg_lock=False).ensure_running("u")
    assert ("pg_lock", "in") not in store2.calls


@pytest.mark.asyncio
async def test_private_traffic_token_is_stored_and_sent(monkeypatch) -> None:
    """限制公开访问：建实例带 allowPublicTraffic=false，令牌落库，并出现在转发用的 Tenant 上。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store, cube = FakeStore(), FakeCube()
    tenant = await _manager(store, cube, cube_private_traffic=True).ensure_running("u")
    create = next(c for c in cube.calls if c[0] == "create")
    assert create[3] is True
    assert ("traffic_token", "sb1", "tt-sb1") in store.calls
    assert tenant.traffic_token == "tt-sb1"
    # 入口重启后：Cube 客户端登记表是空的，令牌从 PG 的运行态登记回去
    cube2 = FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "running"}})
    store2 = FakeStore(runtime=Runtime("running", "sb1", "tpl-new", 1, "sb1", "a.tar.gz", "", "tt-sb1"))
    tenant2 = await _manager(store2, cube2, cube_private_traffic=True).ensure_running("u")
    assert cube2.tokens == {"sb1": "tt-sb1"} and tenant2.traffic_token == "tt-sb1"


@pytest.mark.asyncio
async def test_public_instances_have_no_traffic_token(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store, cube = FakeStore(), FakeCube()
    tenant = await _manager(store, cube).ensure_running("u")
    assert next(c for c in cube.calls if c[0] == "create")[3] is False
    assert tenant.traffic_token == "" and not any(c[0] == "traffic_token" for c in store.calls)


_VOL_NOT_READY = "恢复失败: StateError: 卷 /mnt/u 等了 90s 仍对本用户不可写（挂载还没就绪或属主不对），拒绝启动"


@pytest.mark.asyncio
async def test_volume_not_ready_on_create_discards_instance_and_builds_another(monkeypatch) -> None:
    """新实例挂到了没卸干净的旧挂载点：删掉它、换一台，同一次请求里完成，不等 10 分钟窗口。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store, cube = FakeStore(), FakeCube()
    cube.boot_failures = [CubeError(500, _VOL_NOT_READY)]
    tenant = await _manager(store, cube).ensure_running("u")
    assert tenant.sandbox_id == "sb2"
    kinds = [c for c in cube.calls if c[0] in ("create", "bootstrap", "remove")]
    assert [k[:2] for k in kinds] == [("create", "sb1"), ("bootstrap", "sb1"), ("remove", "sb1"), ("create", "sb2"), ("bootstrap", "sb2")]
    assert ("deleted", "sb1", "volume_not_ready") in store.calls
    assert store.runtime.sandbox_id == "sb2" and store.runtime.state == "running"
    # 第二台也不行就报错，不无限换
    store2, cube2 = FakeStore(), FakeCube()
    cube2.boot_failures = [CubeError(500, _VOL_NOT_READY), CubeError(500, _VOL_NOT_READY)]
    with pytest.raises(CubeError):
        await _manager(store2, cube2).ensure_running("u")
    assert store2.runtime.state == "stopped"


@pytest.mark.asyncio
async def test_other_bootstrap_errors_are_not_retried(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store, cube = FakeStore(), FakeCube()
    cube.boot_failures = [CubeError(500, "恢复失败: StateError: state.db 不是 SQLite 文件")]
    with pytest.raises(CubeError):
        await _manager(store, cube).ensure_running("u")
    assert not any(c[0] == "remove" for c in cube.calls)
    assert store.runtime.sandbox_id == "sb1"  # 留着，窗口内补引导


@pytest.mark.asyncio
async def test_repair_bootstrap_discards_volume_not_ready_instance(monkeypatch) -> None:
    """上次引导没成、本次补引导仍报卷不可写：删掉让调用方重建，而不是等窗口关闭。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("stopped", "sbBad", "tpl-new", 3, "sbPrev", "x.tar.gz", ""))
    cube = FakeCube({"sbBad": {"sandboxID": "sbBad", "templateID": "tpl-new", "state": "running"}})
    cube.hermes_ready.discard("sbBad")   # 上次引导没成：转发器说没引导过、窗口还开着
    cube.boot_failures = [CubeError(500, _VOL_NOT_READY)]
    tenant = await _manager(store, cube).ensure_running("u")
    assert ("remove", "sbBad") in cube.calls and ("deleted", "sbBad", "volume_not_ready") in store.calls
    assert tenant.sandbox_id == "sb1"
    boot = [c for c in cube.calls if c[0] == "bootstrap"][-1]
    assert boot[2]["restore_from"] == "sbPrev"


@pytest.mark.asyncio
async def test_instance_deleted_while_waiting_is_rebuilt_in_the_same_request(monkeypatch) -> None:
    """外部删实例后控制面短暂还说"在"：等就绪时发现它没了 ⇒ 同一个请求里当场重建，不等 180 秒。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("running", "sbOld", "tpl-new", 3, "sbOld", "x.tar.gz", ""))
    cube = FakeCube({"sbOld": {"sandboxID": "sbOld", "templateID": "tpl-new", "state": "running"}})
    cube.gone_during_wait = {"sbOld"}
    tenant = await _manager(store, cube).ensure_running("u")
    assert tenant.sandbox_id == "sb1"
    assert ("deleted", "sbOld", "gone") in store.calls
    kinds = [c[:2] for c in cube.calls if c[0] in ("create", "bootstrap", "wait_hermes")]
    assert kinds == [("create", "sb1"), ("bootstrap", "sb1"), ("wait_hermes", "sb1")]
    assert ("audit", "tenant.resume") not in store.calls
    boot = [c for c in cube.calls if c[0] == "bootstrap"][-1]
    assert boot[2]["restore_from"] == "sbOld"


@pytest.mark.asyncio
async def test_instance_being_deleted_by_platform_is_treated_as_gone(monkeypatch) -> None:
    """控制面列出的实例状态是 deleting：等它消失，再按"没了"重建。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    store = FakeStore(runtime=Runtime("running", "sbOld", "tpl-new", 3, "sbOld", "x.tar.gz", ""))
    cube = FakeCube({"sbOld": {"sandboxID": "sbOld", "templateID": "tpl-new", "state": "deleting"}})

    async def wait_gone(sandbox_id, timeout_s=60):
        cube.sandboxes.pop(sandbox_id, None)
        cube.calls.append(("wait_gone", sandbox_id))
        return True

    cube.wait_gone = wait_gone
    tenant = await _manager(store, cube).ensure_running("u")
    assert tenant.sandbox_id == "sb1" and ("wait_gone", "sbOld") in cube.calls and ("deleted", "sbOld", "gone") in store.calls


# ---- 定时任务：停着的实例按时叫醒，忙着的实例不回收 ---------------------------------

_DUE = 1_791_600_000.0   # 一个固定的「下次执行时间」（epoch 秒）


def _running_store() -> FakeStore:
    return FakeStore(runtime=Runtime("running", "sb1", "tpl-new", 1, "sb1", "", ""))


def _running_cube() -> FakeCube:
    return FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "running"}})


def test_busy_reason_rules() -> None:
    from entry.tenants import busy_reason

    now = 1_000_000.0
    assert busy_reason(None, now, 300) == ""                                   # 老转发器：照旧回收
    assert busy_reason({"cron_running": 1, "turns": 0, "cron_next_at": None}, now, 300) == "cron_running"
    assert busy_reason({"cron_running": 0, "turns": 2, "cron_next_at": None}, now, 300) == "turn_running"
    assert busy_reason({"cron_running": 0, "turns": 0, "cron_next_at": now + 200}, now, 300) == "cron_due"
    assert busy_reason({"cron_running": 0, "turns": 0, "cron_next_at": now - 200}, now, 300) == "cron_due"   # 刚过点，等调度线程
    assert busy_reason({"cron_running": 0, "turns": 0, "cron_next_at": now + 3600}, now, 300) == ""          # 一小时后才到：先暂停，到点叫醒
    assert busy_reason({"cron_running": 0, "turns": 0, "cron_next_at": now - 3600}, now, 300) == ""          # 过点一小时还没跑：不再挂着
    assert busy_reason({"errors": ["state.db: OperationalError"]}, now, 300) == ""


@pytest.mark.asyncio
async def test_idle_stop_records_next_cron_from_sync() -> None:
    store, cube = _running_store(), _running_cube()
    cube.activity = {"cron_next_at": _DUE, "cron_running": 0, "turns": 0}
    await _manager(store, cube).stop("u", reason="idle")
    nxt = [c[1] for c in store.calls if c[0] == "next_cron"]
    assert nxt == [datetime.fromtimestamp(_DUE, tz=timezone.utc)]
    # 没有待执行的任务：清掉原来记的
    store2, cube2 = _running_store(), _running_cube()
    cube2.activity = {"cron_next_at": None, "cron_running": 0, "turns": 0}
    await _manager(store2, cube2).stop("u", reason="idle")
    assert [c[1] for c in store2.calls if c[0] == "next_cron"] == [None]


@pytest.mark.asyncio
async def test_old_forwarder_without_activity_leaves_next_cron_alone() -> None:
    store, cube = _running_store(), _running_cube()
    await _manager(store, cube).stop("u", reason="idle")
    assert not any(c[0] == "next_cron" for c in store.calls)
    assert ("set_state_archive", "sync.tar.gz") in store.calls


@pytest.mark.asyncio
async def test_sync_failure_still_records_next_cron_via_status() -> None:
    """暂停前归档失败照样暂停；下一个定时任务的时间改从状态接口拿，不然停着就叫不醒了。"""
    store, cube = _running_store(), _running_cube()
    cube.sync_error = CubeError(500, "归档失败")
    cube.activity = {"cron_next_at": _DUE, "cron_running": 0, "turns": 0}
    await _manager(store, cube).stop("u", reason="idle")
    assert ("pause", "sb1") in cube.calls
    assert [c[1] for c in store.calls if c[0] == "next_cron"] == [datetime.fromtimestamp(_DUE, tz=timezone.utc)]


@pytest.mark.asyncio
async def test_long_idle_delete_records_next_cron_from_drain() -> None:
    store = FakeStore(runtime=Runtime("stopped", "sb1", "tpl-new", 1, "sb1", "", ""))
    cube = FakeCube({"sb1": {"sandboxID": "sb1", "templateID": "tpl-new", "state": "paused"}})
    cube.activity = {"cron_next_at": _DUE, "cron_running": 0, "turns": 0}
    await _manager(store, cube, idle_delete_hours=24).reap_long_idle()
    assert ("set_state_archive", "final.tar.gz") in store.calls
    assert [c[1] for c in store.calls if c[0] == "next_cron"] == [datetime.fromtimestamp(_DUE, tz=timezone.utc)]


@pytest.mark.asyncio
async def test_reap_idle_skips_busy_instance_and_pauses_idle_one() -> None:
    store, cube = _running_store(), _running_cube()
    manager = _manager(store, cube)
    cube.activity = {"cron_next_at": None, "cron_running": 1, "turns": 0}
    await manager.reap_idle()
    assert ("pause", "sb1") not in cube.calls and store.runtime.state == "running"
    cube.activity = {"cron_next_at": None, "cron_running": 0, "turns": 1}
    await manager.reap_idle()
    assert ("pause", "sb1") not in cube.calls
    cube.activity = {"cron_next_at": None, "cron_running": 0, "turns": 0}
    await manager.reap_idle()
    assert ("pause", "sb1") in cube.calls and store.runtime.state == "stopped"


@pytest.mark.asyncio
async def test_reap_idle_pauses_when_forwarder_cannot_answer() -> None:
    """问不到转发器（老实例、数据面抖动）照旧回收，不能让实例因此一直挂着。"""
    store, cube = _running_store(), _running_cube()
    cube.status_error = CubeError(0, "timeout")
    await _manager(store, cube).reap_idle()
    assert ("pause", "sb1") in cube.calls


@pytest.mark.asyncio
async def test_reap_idle_keeps_instances_with_live_ws() -> None:
    store, cube = _running_store(), _running_cube()
    await _manager(store, cube).reap_idle(keep={"u"})
    assert cube.calls == []


@pytest.mark.asyncio
async def test_wake_due_cron_resumes_paused_instance_without_counting_as_activity(monkeypatch) -> None:
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    due = datetime.fromtimestamp(_DUE, tz=timezone.utc)
    store = FakeStore(runtime=Runtime("stopped", "sbA", "tpl-new", 2, "sbA", "x.tar.gz", ""), cron_due=[("u", due)])
    cube = FakeCube({"sbA": {"sandboxID": "sbA", "templateID": "tpl-new", "state": "paused"}})
    manager = _manager(store, cube)
    await manager.wake_due_cron()
    assert store.runtime.state == "running"
    assert ("touch",) not in store.calls                       # 不算用户活动
    assert ("cron_woken", due) in store.calls and ("audit", "tenant.wake_cron") in store.calls
    # 同一个时间点不再叫
    cube.calls.clear()
    await manager.wake_due_cron()
    assert cube.calls == []
    # 刚叫醒的实例：回收时先留着，等 hermes 的调度线程转到它（不用问转发器）
    await manager.reap_idle()
    assert ("pause", "sbA") not in cube.calls and ("status", "sbA") not in cube.calls


@pytest.mark.asyncio
async def test_wake_due_cron_rebuilds_deleted_instance_from_archive(monkeypatch) -> None:
    """长期空闲被删了的实例：到点从归档重建，hermes 起来后自己补跑过点的任务。"""
    monkeypatch.setattr(TenantManager, "_sync_api_key", _no_key_sync)
    due = datetime.fromtimestamp(_DUE, tz=timezone.utc)
    store = FakeStore(runtime=Runtime("stopped", "", "tpl-new", 4, "sbOld", "old.tar.gz", ""), cron_due=[("u", due)])
    cube = FakeCube()
    await _manager(store, cube).wake_due_cron()
    boot = next(c for c in cube.calls if c[0] == "bootstrap")
    assert boot[2]["restore_from"] == "sbOld"
    assert ("touch",) not in store.calls and ("audit", "tenant.wake_cron") in store.calls


@pytest.mark.asyncio
async def test_wake_failure_retries_then_gives_up(monkeypatch) -> None:
    due = datetime.fromtimestamp(_DUE, tz=timezone.utc)
    store = FakeStore(cron_due=[("u", due)])
    manager = _manager(store, FakeCube())

    async def boom(self, user_id, *, touch=True):
        raise CubeError(0, "集群不可达")

    monkeypatch.setattr(TenantManager, "ensure_running", boom)
    await manager.wake_due_cron()
    await manager.wake_due_cron()
    assert not any(c[0] == "cron_woken" for c in store.calls)      # 前两次失败：下一轮还叫
    await manager.wake_due_cron()
    assert ("cron_woken", due) in store.calls and ("audit", "tenant.wake_cron_failed") in store.calls
    calls = len(store.calls)
    await manager.wake_due_cron()
    assert len(store.calls) == calls                                # 放弃了就不再叫


@pytest.mark.asyncio
async def test_wake_disabled_when_lead_is_zero() -> None:
    store = FakeStore(cron_due=[("u", datetime.fromtimestamp(_DUE, tz=timezone.utc))])
    cube = FakeCube()
    await _manager(store, cube, cron_wake_lead_s=0).wake_due_cron()
    assert cube.calls == [] and store.calls == []
