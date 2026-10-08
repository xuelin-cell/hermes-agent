"""沙箱后端的实例生命周期与状态归档编排（entry/tenants.py 的 _*_cube）。

用假的 Cube 客户端和假的 Store，不碰平台也不碰 PostgreSQL。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from entry import tenants as tenants_module
from entry.config import Settings
from entry.cube_api import CubeError
from entry.store import Runtime, TenantContext
from entry.tenants import TenantManager

# 入口镜像里 seed/ 被拷到 entry/ 旁边；仓库里它在 deploy/hermes-mt/seed。
tenants_module.SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"


@dataclass
class FakeStore:
    runtime: Runtime = field(default_factory=lambda: Runtime("stopped", "", "", 0, "", "", ""))
    calls: list = field(default_factory=list)
    epoch: int = 0

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
        pass

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
        if sandbox_id not in self.hermes_ready:
            raise CubeError(0, "not ready")
        self.calls.append(("wait_hermes", sandbox_id))

    async def status(self, sandbox_id, port):
        return {"bootstrapped": sandbox_id in self.hermes_ready, "boot_window_left_s": 500}

    async def sync_state(self, sandbox_id, port, token):
        self.calls.append(("sync", sandbox_id))
        return {"archive": "sync.tar.gz"}

    async def drain(self, sandbox_id, port, token):
        self.calls.append(("drain", sandbox_id))
        if not self.drain_ok:
            raise CubeError(500, "drain failed")
        return {"archive": "final.tar.gz"}

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
