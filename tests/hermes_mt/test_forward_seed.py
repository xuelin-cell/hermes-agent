"""转发器的种子文件落盘模式（deploy/hermes-mt/seed/forward.py::_write_seed）。"""

from __future__ import annotations

import importlib.util
import json
import sys
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


# ---------------------------------------------------------------- 技能策略（引导载荷的 skills 段，见 seed/skillpolicy.py）

@pytest.mark.asyncio
async def test_skill_policy_runs_the_script_with_hermes_python(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """策略从标准输入进、报告取标准输出的最后一行；HERMES_HOME 是用户的数据目录。"""
    script = tmp_path / "policy.py"
    script.write_text(
        "import json, os, sys\n"
        "policy = json.load(sys.stdin)\n"
        "print('noise from hermes imports')\n"
        "print(json.dumps({'removed': 3, 'home': os.environ['HERMES_HOME'], 'policy': policy}))\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(forward, "HERMES_PYTHON", sys.executable)
    monkeypatch.setattr(forward, "SKILL_POLICY", script)

    assert await forward._apply_skill_policy(None) is None  # 老入口不给：不动
    policy = {"keep_categories": ["uniwork"], "keep": []}
    assert await forward._apply_skill_policy(policy) == {
        "ok": True, "removed": 3, "home": str(forward.HERMES_HOME), "policy": policy,
    }


@pytest.mark.asyncio
async def test_skill_policy_failures_are_reported_not_raised(forward, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    failing = tmp_path / "failing.py"
    failing.write_text("import sys\nprint('{\"error\": \"ImportError: no tools\"}')\nsys.exit(1)\n", encoding="utf-8")
    crashing = tmp_path / "crashing.py"
    crashing.write_text("raise SystemExit('boom')\n", encoding="utf-8")
    monkeypatch.setattr(forward, "HERMES_PYTHON", sys.executable)

    monkeypatch.setattr(forward, "SKILL_POLICY", failing)
    assert await forward._apply_skill_policy({}) == {"ok": False, "error": "ImportError: no tools"}
    monkeypatch.setattr(forward, "SKILL_POLICY", crashing)
    report = await forward._apply_skill_policy({})
    assert report["ok"] is False and "boom" in report["error"]
    monkeypatch.setattr(forward, "HERMES_PYTHON", str(tmp_path / "no-such-python"))
    report = await forward._apply_skill_policy({})
    assert report["ok"] is False and report["error"]


@pytest.mark.asyncio
async def test_bootstrap_applies_the_skill_policy_before_hermes_starts(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    """hermes 启动时会再同步一遍自带技能：名单得在那之前写好。结果放进引导回包。"""
    order: list[str] = []

    async def policy(skills):
        order.append(f"policy {skills}")
        return {"ok": True, "removed": 80}

    async def spawn(token):
        order.append("spawn")

    async def alive():
        return True

    async def idle():
        return None

    monkeypatch.setattr(forward, "_apply_skill_policy", policy)
    monkeypatch.setattr(forward, "_spawn_hermes", spawn)
    monkeypatch.setattr(forward, "_hermes_alive", alive)
    monkeypatch.setattr(forward, "_supervise", idle)
    writer = _Writer()
    payload = {"token": "tok", "files": [], "skills": {"keep_categories": ["uniwork"], "keep": []}}

    await forward._bootstrap(writer, json.dumps(payload).encode("utf-8"))

    assert order == ["policy {'keep_categories': ['uniwork'], 'keep': []}", "spawn"]
    body = writer.body()
    assert body["ok"] is True and body["skills"] == {"ok": True, "removed": 80}
