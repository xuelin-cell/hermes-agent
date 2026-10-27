"""转发器的种子文件落盘模式（deploy/hermes-mt/seed/forward.py::_write_seed）。"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import pytest

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"


@pytest.fixture
def forward(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    if str(SEED_DIR) not in sys.path:
        sys.path.insert(0, str(SEED_DIR))
    spec = importlib.util.spec_from_file_location("forward_under_test", SEED_DIR / "forward.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_write_seed_modes(forward, tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("USER_KEY=mine\n", encoding="utf-8")
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: \"old\"\n  base_url: \"http://old\"\nproviders:\n  yuanjing:\n    api: \"http://old\"\n"
        "    default_model: \"old\"\n    models:\n      old: {}\n", encoding="utf-8")
    written = forward._write_seed([
        {"path": "config.yaml", "content": "template", "overwrite": "if-pristine"},
        {"path": "config.yaml", "content": json.dumps({"base_url": "http://new", "model": "m", "provider_key": "yuanjing", "models": ["m"]}),
         "overwrite": "patch-model"},
        {"path": ".env", "content": "TERMINAL_ENV=local\nPLATFORM_KEY=k\n", "overwrite": "upsert-lines"},
        {"path": "SOUL.md", "content": "soul", "overwrite": False},
    ])
    assert written == ["config.yaml", ".env", "SOUL.md"]
    cfg = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    assert cfg.startswith("model:")  # 用户的配置没被模板整份覆盖
    import yaml
    doc = yaml.safe_load(cfg)
    assert doc["model"]["default"] == "m" and doc["model"]["base_url"] == "http://new"
    assert list(doc["providers"]["yuanjing"]["models"]) == ["m"]
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "USER_KEY=mine\nTERMINAL_ENV=local\nPLATFORM_KEY=k\n"
    assert (tmp_path / "SOUL.md").read_text(encoding="utf-8") == "soul"
    # 第二次：SOUL.md 已存在不覆盖，patch 无变化不算写入
    written = forward._write_seed([
        {"path": "config.yaml", "content": json.dumps({"base_url": "http://new", "model": "m", "provider_key": "yuanjing", "models": ["m"]}),
         "overwrite": "patch-model"},
        {"path": "SOUL.md", "content": "other", "overwrite": False},
    ])
    assert written == []


def test_soul_if_pristine_replaces_only_the_image_default(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """SOUL.md 用 if-pristine：还是镜像首启种的默认人设才换成平台的，用户改过的不动。"""
    image_default = tmp_path / "image-SOUL.md"
    image_default.write_text("You are Hermes Agent, built by Nous Research.", encoding="utf-8")
    monkeypatch.setitem(forward._PRISTINE_REF, "SOUL.md", str(image_default))
    soul = tmp_path / "SOUL.md"
    platform = [{"path": "SOUL.md", "content": "你是「元景数字员工」", "overwrite": "if-pristine"}]

    soul.write_bytes(image_default.read_bytes())  # 镜像首启种的，没人碰过
    assert forward._write_seed(platform) == ["SOUL.md"]
    assert soul.read_text(encoding="utf-8") == "你是「元景数字员工」"

    soul.write_text("你是我的私人助理，说话简短。", encoding="utf-8")  # 用户在「管理配置档案」里改过
    assert forward._write_seed(platform) == []
    assert soul.read_text(encoding="utf-8") == "你是我的私人助理，说话简短。"

    soul.unlink()  # 没有就写
    assert forward._write_seed(platform) == ["SOUL.md"]


def test_write_seed_rejects_traversal(forward) -> None:
    with pytest.raises(ValueError):
        forward._write_seed([{"path": "../etc/passwd", "content": "x", "overwrite": True}])


@pytest.mark.asyncio
async def test_spawn_hermes_turns_on_the_cron_ticker(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    """hermes serve 只在 HERMES_DESKTOP=1 时自己起定时任务的调度线程。"""
    seen: dict = {}

    async def fake_exec(*args, env=None, **kwargs):
        seen["args"], seen["env"] = args, env
        return object()

    monkeypatch.setattr(forward.asyncio, "create_subprocess_exec", fake_exec)
    await forward._spawn_hermes("tok")
    assert seen["args"][:2] == ("hermes", "serve")
    assert seen["env"]["HERMES_DESKTOP"] == "1"
    assert seen["env"]["HERMES_DASHBOARD_SESSION_TOKEN"] == "tok"


class _Writer:
    def __init__(self) -> None:
        self.data = b""

    def write(self, chunk: bytes) -> None:
        self.data += chunk

    def body(self) -> dict:
        return json.loads(self.data.split(b"\r\n\r\n", 1)[1].decode("utf-8"))


@pytest.mark.asyncio
async def test_status_reports_cron_and_turn_activity(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "cron").mkdir()
    (tmp_path / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
        {"id": "a", "enabled": True, "state": "scheduled", "next_run_at": "2026-10-10T01:00:00+00:00"},
    ]}), encoding="utf-8")

    async def not_alive() -> bool:
        return False

    monkeypatch.setattr(forward, "_hermes_alive", not_alive)
    writer = _Writer()
    await forward._handle_mt("GET", "/__mt/status", {}, b"", None, writer)
    assert writer.body()["activity"] is None          # 没引导过：不读
    monkeypatch.setattr(forward, "_bootstrapped", True)
    writer = _Writer()
    await forward._handle_mt("GET", "/__mt/status", {}, b"", None, writer)
    act = writer.body()["activity"]
    assert act["cron_next_at"] == 1791594000.0 and act["cron_jobs"] == 1
    assert act["cron_running"] == 0 and act["turns"] == 0 and act["errors"] == []


# ---------------------------------------------------------------- 自带技能同步（hermes 的 tools/skills_sync.py）

def _fake_install(root: Path, body: str) -> Path:
    """一个只有 tools/skills_sync.py 的假 hermes 安装目录。"""
    (root / "tools").mkdir(parents=True)
    (root / "tools" / "__init__.py").write_text("", encoding="utf-8")
    (root / "tools" / "skills_sync.py").write_text(body, encoding="utf-8")
    return root


@pytest.mark.asyncio
async def test_skills_sync_runs_hermes_own_sync_in_the_user_home(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """hermes 自己的同步函数在它的安装目录里跑，HERMES_HOME 是用户的数据目录；回包只带名字和计数。"""
    install = _fake_install(tmp_path / "install", (
        "import os\n"
        "def sync_skills(quiet=False):\n"
        "    print('noise from hermes imports')\n"
        "    open(os.path.join(os.environ['HERMES_HOME'], 'synced'), 'w').write(str(quiet))\n"
        "    return {'copied': ['uniai-ppt'], 'updated': [], 'user_modified': [], 'skipped': 17,\n"
        "            'retired_pristine': ['excel'], 'retired_modified': ['doc'], 'total_bundled': 18}\n"
    ))
    monkeypatch.setattr(forward, "HERMES_PYTHON", sys.executable)
    monkeypatch.setattr(forward, "HERMES_INSTALL", install)

    assert await forward._sync_bundled_skills() == {
        "ok": True, "copied": ["uniai-ppt"], "updated": [], "user_modified": [],
        "retired_pristine": ["excel"], "retired_modified": ["doc"], "total_bundled": 18,
    }
    assert (Path(forward.HERMES_HOME) / "synced").read_text(encoding="utf-8") == "True"


@pytest.mark.asyncio
async def test_skills_sync_failures_are_reported_not_raised(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    install = _fake_install(tmp_path / "install", (
        "def sync_skills(quiet=False):\n"
        "    raise RuntimeError('bundled dir missing')\n"
    ))
    monkeypatch.setattr(forward, "HERMES_PYTHON", sys.executable)
    monkeypatch.setattr(forward, "HERMES_INSTALL", install)

    report = await forward._sync_bundled_skills()
    assert report["ok"] is False and "bundled dir missing" in report["error"]
    monkeypatch.setattr(forward, "HERMES_PYTHON", str(tmp_path / "no-such-python"))
    report = await forward._sync_bundled_skills()
    assert report["ok"] is False and report["error"]


@pytest.mark.asyncio
async def test_bootstrap_syncs_skills_before_hermes_starts(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    """用户目录恢复之后、拉 hermes 之前同步自带技能（hermes serve 启动时不同步）；结果放进引导回包。
    老入口还会带 skills 段，不再看它。"""
    order: list[str] = []

    async def sync():
        order.append("sync")
        return {"ok": True, "retired_pristine": ["excel"]}

    async def spawn(token):
        order.append("spawn")

    async def alive():
        return True

    async def idle():
        return None

    monkeypatch.setattr(forward, "_sync_bundled_skills", sync)
    monkeypatch.setattr(forward, "_spawn_hermes", spawn)
    monkeypatch.setattr(forward, "_hermes_alive", alive)
    monkeypatch.setattr(forward, "_supervise", idle)
    writer = _Writer()
    payload = {"token": "tok", "files": [], "skills": {"keep_categories": ["uniwork"], "keep": []}}

    await forward._bootstrap(writer, json.dumps(payload).encode("utf-8"))

    assert order == ["sync", "spawn"]
    body = writer.body()
    assert body["ok"] is True and body["skills"] == {"ok": True, "retired_pristine": ["excel"]}


# ---------------------------------------------------------------- /__mt/reload：重写配置并重启 hermes

def _post(payload: dict, token: str = "tok") -> tuple[dict, bytes]:
    body = json.dumps(payload).encode("utf-8")
    headers = {"content-length": str(len(body))}
    if token:
        headers["x-mt-token"] = token
    return headers, body


@pytest.mark.asyncio
async def test_reload_needs_the_instance_token_and_a_bootstrapped_instance(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(forward, "_hermes_token", "tok")
    headers, body = _post({"files": []}, token="wrong")
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/reload", headers, body, None, writer)
    assert b" 403 " in writer.data.split(b"\r\n", 1)[0]

    headers, body = _post({"files": []})
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/reload", headers, body, None, writer)
    assert b" 409 " in writer.data.split(b"\r\n", 1)[0]          # 还没引导过


@pytest.mark.asyncio
async def test_reload_rewrites_seed_files_then_restarts_hermes(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    (tmp_path / ".env").write_text("USER_KEY=mine\nHERMES_CUSTOM_YUANJING_API_KEY=old\n", encoding="utf-8")

    async def stop(grace_s: float = 30.0):
        order.append("stop")
        assert forward._reloading is True                       # 守护循环看到这个就不跟着拉起

    async def spawn(token):
        order.append(f"spawn:{token}")
        assert "=new" in (tmp_path / ".env").read_text(encoding="utf-8")   # 先写好文件再起

    async def alive():
        return True

    monkeypatch.setattr(forward, "_hermes_token", "tok")
    monkeypatch.setattr(forward, "_bootstrapped", True)
    monkeypatch.setattr(forward, "_stop_hermes", stop)
    monkeypatch.setattr(forward, "_spawn_hermes", spawn)
    monkeypatch.setattr(forward, "_hermes_alive", alive)
    headers, body = _post({"files": [
        {"path": ".env", "content": "HERMES_CUSTOM_YUANJING_API_KEY=new\n", "overwrite": "upsert-lines"},
    ]})
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/reload", headers, body, None, writer)

    assert order == ["stop", "spawn:tok"]
    assert writer.body() == {"ok": True, "hermes": True, "written": [".env"]}
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "USER_KEY=mine\nHERMES_CUSTOM_YUANJING_API_KEY=new\n"
    assert forward._reloading is False


@pytest.mark.asyncio
async def test_supervisor_does_not_respawn_hermes_during_a_reload(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    """重新加载停掉旧进程时，守护循环不能也去拉起一个：两个 hermes 会抢同一个端口。"""
    import asyncio

    class _Exited:
        returncode = 0

        async def wait(self):
            return 0

    spawned: list[str] = []

    async def spawn(token):
        spawned.append(token)

    monkeypatch.setattr(forward, "_spawn_hermes", spawn)
    monkeypatch.setattr(forward, "_hermes_proc", _Exited())
    monkeypatch.setattr(forward, "_reloading", True)
    task = asyncio.create_task(forward._supervise())
    await asyncio.sleep(1.6)
    task.cancel()
    assert spawned == []


class _ClosingWriter(_Writer):
    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


def test_api_head_rewrites_path_and_swaps_credentials(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(forward, "_api_key", "k" * 64)
    head = (b"POST /__mt/api/v1/runs?x=1 HTTP/1.1\r\nHost: cube\r\nX-MT-Token: inst\r\n"
            b"Authorization: Bearer platform\r\nContent-Length: 2\r\n\r\n{}")
    out = forward._api_head(head)
    assert out.startswith(b"POST /v1/runs?x=1 HTTP/1.1\r\n")
    assert b"X-MT-Token" not in out and b"platform" not in out and b"Host: cube" not in out
    assert b"Authorization: Bearer " + b"k" * 64 in out
    assert out.endswith(b"Connection: close\r\n\r\n{}")


@pytest.mark.asyncio
async def test_api_proxy_needs_instance_token_and_an_enabled_api(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(forward, "_hermes_token", "inst")
    writer = _ClosingWriter()
    await forward._proxy_api({"x-mt-token": "wrong"}, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 403") and writer.closed
    writer = _ClosingWriter()
    await forward._proxy_api({"x-mt-token": "inst"}, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 404")  # 成员实例没开 API 服务


def test_enable_api_server_writes_key_into_env_file(forward, tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("YUANJING_KEY=mine\n", encoding="utf-8")
    forward._enable_api_server()
    env = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "YUANJING_KEY=mine" in env  # 用户自己的行不动
    assert f"API_SERVER_KEY={forward._api_key}" in env and len(forward._api_key) == 64
    assert "API_SERVER_HOST=127.0.0.1" in env and forward._api_enabled is True


def _enterprise_spec() -> dict:
    return {"v": 1, "tenant": "tid-1", "server": "http://platform.test", "token_env": "KEY",
            "config": {"template": "model:\n  default: m\n", "provider_key": "uniwork", "model": "m", "models": ["m"]},
            "default": {}, "agents": [{"id": "a1", "name": "助手", "instructions": "先写结论。", "model": "m",
                                       "models": ["m"], "memory": "session", "approval": "smart"}]}


@pytest.mark.asyncio
async def test_enterprise_needs_the_session_token_on_both_paths(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Docker 路径没有引导、没有 _hermes_token：用容器环境变量里的会话令牌核对。"""
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "sess")
    headers, body = _post({"spec": _enterprise_spec()}, token="wrong")
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/enterprise", headers, body, None, writer)
    assert b" 403 " in writer.data.split(b"\r\n", 1)[0]
    assert not (tmp_path / "profiles").exists()

    monkeypatch.setattr(forward, "_boot_homes", 1)
    headers, body = _post({"spec": _enterprise_spec(), "restart": True}, token="sess")
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/enterprise", headers, body, None, writer)
    reply = writer.body()
    assert reply["ok"] and reply["report"]["profiles"]["uw-a1"]
    # 第一次装出 Agent 的 profile：hermes 要重新启动；Docker 路径这里重启不了，交给入口
    assert reply["restart_needed"] is True and reply["restarted"] is False
    assert (tmp_path / "profiles" / "uw-a1" / "SOUL.md").read_text(encoding="utf-8").startswith("# 助手")


@pytest.mark.asyncio
async def test_enterprise_restarts_hermes_once_when_idle(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []

    async def stop(grace_s: float = 30.0):
        order.append("stop")

    async def spawn(token):
        order.append(f"spawn:{token}")
        forward._note_boot_homes()

    async def alive():
        return True

    busy = {"turns": [{"session": "s1"}]}
    idle: dict = {"turns": []}
    state = {"activity": busy}

    async def activity():
        return state["activity"]

    monkeypatch.setattr(forward, "_hermes_token", "tok")
    monkeypatch.setattr(forward, "_bootstrapped", True)
    monkeypatch.setattr(forward, "_boot_homes", 1)
    monkeypatch.setattr(forward, "_restart_pending", False)
    monkeypatch.setattr(forward, "_stop_hermes", stop)
    monkeypatch.setattr(forward, "_spawn_hermes", spawn)
    monkeypatch.setattr(forward, "_hermes_alive", alive)
    monkeypatch.setattr(forward, "_activity", activity)

    headers, body = _post({"spec": _enterprise_spec(), "restart": True})
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/enterprise", headers, body, None, writer)
    assert writer.body()["restart_needed"] is True and order == []  # 有对话在跑：先不重启

    state["activity"] = idle
    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/enterprise", headers, body, None, writer)
    reply = writer.body()
    assert reply["restarted"] is True and reply["restart_needed"] is False
    assert order == ["stop", "spawn:tok"] and forward._boot_homes == 2

    writer = _Writer()
    await forward._handle_mt("POST", "/__mt/enterprise", headers, body, None, writer)
    assert writer.body()["restarted"] is False and order == ["stop", "spawn:tok"]  # 没变化不再重启


@pytest.mark.asyncio
async def test_token_follower_reacts_to_a_new_default_token(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """重新登录换了令牌：默认 profile 的 .env 一变，Agent 的托管 profile 几秒内跟上，不等每分钟的兜底。"""
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "sess")
    (tmp_path / ".env").write_text("KEY=old\n", encoding="utf-8")
    headers, body = _post({"spec": _enterprise_spec()}, token="sess")
    await forward._handle_mt("POST", "/__mt/enterprise", headers, body, None, _Writer())
    agent_env = tmp_path / "profiles" / "uw-a1" / ".env"
    assert "KEY=old" in agent_env.read_text(encoding="utf-8")
    monkeypatch.setattr(forward, "TOKEN_WATCH_INTERVAL_S", 0.01)
    monkeypatch.setattr(forward, "TOKEN_SYNC_INTERVAL_S", 3600)
    task = asyncio.create_task(forward._token_follower())
    try:
        await asyncio.sleep(0.05)
        (tmp_path / ".env").write_text("KEY=new\n", encoding="utf-8")
        os.utime(tmp_path / ".env", (time.time() + 5, time.time() + 5))
        for _ in range(100):
            if "KEY=new" in agent_env.read_text(encoding="utf-8"):
                break
            await asyncio.sleep(0.02)
        assert "KEY=new" in agent_env.read_text(encoding="utf-8")
    finally:
        task.cancel()
