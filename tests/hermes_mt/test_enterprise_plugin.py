"""企业对接插件（deploy/hermes-mt/plugin：会话头、工具调用上报）在入口和转发器这一侧的部分：

- 企业模式下，入口的平台块让 config.yaml 的 plugins.enabled 带上它（引导时、拉起 hermes 之前写）；个人模式不碰；
- 清单的 plugin 段（总开关 MT_UNIWORK_PLUGIN、平台的 toolAudit）由转发器写成实例的 plugin.json，不含令牌；
- Agent 的托管 profile 用同一份平台块，也启用；员工自建的、被员工停用的，转发器巡检时补上；
- 镜像把插件装进 hermes 的 venv，指纹算上 plugin/，名字三处一致。

插件本身的测试在 tests/hermes_mt_plugin（要 hermes 的 venv 跑）。
"""

from __future__ import annotations

import configparser
import json
import sys
from pathlib import Path

import pytest
import yaml

from entry.config import Settings
from entry.enterprise import build_spec, spec_digest
from entry import tenants as tenants_module
from entry.tenants import UNIWORK_PLUGIN_KEY, TenantManager

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy" / "hermes-mt"
SEED_DIR = DEPLOY / "seed"
if str(SEED_DIR) not in sys.path:
    sys.path.insert(0, str(SEED_DIR))
import mtent  # noqa: E402
import mtstate  # noqa: E402

SERVER = "http://host.docker.internal:11220"
TOKEN_ENV = "HERMES_CUSTOM_YUANJING_API_KEY"
ENTERPRISE = Settings(key_env_name=TOKEN_ENV, uniwork_server=SERVER)
PERSONAL = Settings(key_env_name=TOKEN_ENV)


def _patch_spec(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setattr(tenants_module, "SEED_DIR", SEED_DIR)
    manager = TenantManager(settings, None, None, None)  # type: ignore[arg-type]
    return manager._config_patch_spec(("http://platform.test/v1", "deepseek-v4-flash"),  # noqa: SLF001
                                      [("deepseek-v4-flash", "deepseek")], {"deepseek-v4-flash": 300000}, api_key="t")


def _policy(**extra) -> dict:
    agent = {"key": "agent:a1", "kind": "agent", "id": "a1", "name": "联调 Agent", "model": "uniwork-catalog-ds",
             "instructions": "你好", "skills": [], "plugins": [], "connectors": [], "revision": "r1"}
    policy = {"revision": "rev-1", "enterprise": {"tenantId": "tid-1", "serverUrl": "http://platform.test"},
              "models": {"models": [{"id": "uniwork-catalog-ds", "model": "deepseek-v4-flash"}],
                         "main_model_id": "uniwork-catalog-ds"},
              "experts": [agent]}
    policy.update(extra)
    return policy


@pytest.fixture
def home(tmp_path: Path) -> Path:
    (tmp_path / ".env").write_text(f"TERMINAL_ENV=local\n{TOKEN_ENV}=secret-device-token\n", encoding="utf-8")
    (tmp_path / "config.yaml").write_text("model:\n  default: deepseek-v4-flash\n", encoding="utf-8")
    return tmp_path


def _spec(monkeypatch: pytest.MonkeyPatch, policy: dict | None = None, **kw) -> dict:
    return build_spec(policy or _policy(), server=SERVER, token_env=TOKEN_ENV,
                      config=_patch_spec(ENTERPRISE, monkeypatch), **kw)


# ---------------------------------------------------------------- 入口

def test_only_enterprise_mode_enables_the_plugin(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _patch_spec(ENTERPRISE, monkeypatch)["plugins"] == {"enable": [UNIWORK_PLUGIN_KEY]}
    assert "plugins" not in _patch_spec(PERSONAL, monkeypatch)


def test_the_spec_carries_the_switch_and_the_platforms_tool_audit(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _spec(monkeypatch)["plugin"] == {"enabled": True, "toolAudit": True}  # 平台没给 toolAudit：缺省为开
    assert _spec(monkeypatch, plugin=False)["plugin"] == {"enabled": False, "toolAudit": True}
    off = _spec(monkeypatch, _policy(toolAudit={"enabled": False}))
    assert off["plugin"] == {"enabled": True, "toolAudit": False}
    assert spec_digest(off) != spec_digest(_spec(monkeypatch))  # 开关变了要重送清单
    assert ENTERPRISE.uniwork_plugin is True


# ---------------------------------------------------------------- 转发器：平台块

def test_the_platform_block_adds_the_plugin_and_leaves_the_rest() -> None:
    user_cfg = ("model:\n  default: m1\nplugins:\n  enabled:\n    - disk-cleanup\n"
                "  disabled:\n    - uniwork-enterprise\n    - kanban\n  hook_callback_timeout: 20\n")
    spec = {"base_url": "http://plan/v1", "model": "m1", "provider_key": "yuanjing", "key_env": "K", "models": ["m1"],
            "template": "", "plugins": {"enable": [UNIWORK_PLUGIN_KEY]}}
    text, notes = mtstate.patch_config_text(user_cfg, spec)
    plugins = yaml.safe_load(text)["plugins"]
    assert notes
    assert plugins == {"enabled": ["disk-cleanup", UNIWORK_PLUGIN_KEY], "disabled": ["kanban"],
                       "hook_callback_timeout": 20}
    again, notes = mtstate.patch_config_text(text, spec)
    assert notes == [] and again == text


def test_a_config_without_a_plugins_section_gets_one() -> None:
    cfg = {"model": {"default": "m1"}}
    assert mtstate.enable_plugins(cfg, [UNIWORK_PLUGIN_KEY])
    assert cfg["plugins"] == {"enabled": [UNIWORK_PLUGIN_KEY]}
    assert not mtstate.enable_plugins(cfg, [UNIWORK_PLUGIN_KEY])


# ---------------------------------------------------------------- 转发器：清单

def test_apply_writes_plugin_json_without_the_token(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    report = mtent.apply(home, _spec(monkeypatch), fetch=lambda url, what: b"")
    raw = (home / mtent.PLUGIN_FILE).read_text(encoding="utf-8")
    assert json.loads(raw) == {"v": 1, "enabled": True, "server": SERVER, "tokenEnv": TOKEN_ENV, "toolAudit": True}
    assert "secret-device-token" not in raw
    agent_cfg = yaml.safe_load((home / "profiles" / "uw-a1" / "config.yaml").read_text(encoding="utf-8"))
    assert agent_cfg["plugins"]["enabled"] == [UNIWORK_PLUGIN_KEY]  # 托管 profile 用同一份平台块
    assert report["ok"], report["errors"]


def test_the_switch_turns_the_plugin_off_in_place(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mtent.apply(home, _spec(monkeypatch), fetch=lambda url, what: b"")
    mtent.apply(home, _spec(monkeypatch, plugin=False), fetch=lambda url, what: b"")
    assert json.loads((home / mtent.PLUGIN_FILE).read_text(encoding="utf-8"))["enabled"] is False
    mtent.apply(home, _spec(monkeypatch, _policy(toolAudit={"enabled": False})), fetch=lambda url, what: b"")
    written = json.loads((home / mtent.PLUGIN_FILE).read_text(encoding="utf-8"))
    assert written["enabled"] is True and written["toolAudit"] is False


def test_an_old_entry_without_the_plugin_section_leaves_it_off(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec = {k: v for k, v in _spec(monkeypatch).items() if k != "plugin"}
    mtent.apply(home, spec, fetch=lambda url, what: b"")
    assert json.loads((home / mtent.PLUGIN_FILE).read_text(encoding="utf-8"))["enabled"] is False


# ---------------------------------------------------------------- 转发器：巡检

def _employee_profile(home: Path, name: str, text: str) -> Path:
    profile = home / "profiles" / name
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text(text, encoding="utf-8")
    return profile


def test_the_patrol_enables_it_everywhere_once(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mtent.apply(home, _spec(monkeypatch), fetch=lambda url, what: b"")
    old = _employee_profile(home, "my-bot", "model:\n  default: m1\n")
    turned_off = _employee_profile(home, "other-bot", f"plugins:\n  disabled:\n    - {UNIWORK_PLUGIN_KEY}\n")
    _employee_profile(home, "broken-bot", "model: [unclosed\n")
    assert sorted(mtent.sync_plugins(home)) == ["default", "my-bot", "other-bot"]
    for profile in (home, old, turned_off):
        cfg = yaml.safe_load((profile / "config.yaml").read_text(encoding="utf-8"))
        assert UNIWORK_PLUGIN_KEY in cfg["plugins"]["enabled"]
        assert UNIWORK_PLUGIN_KEY not in (cfg["plugins"].get("disabled") or [])
    assert (home / "profiles" / "broken-bot" / "config.yaml").read_text(encoding="utf-8") == "model: [unclosed\n"
    assert mtent.sync_plugins(home) == []


def test_the_patrol_does_nothing_while_the_plugin_is_off(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert mtent.sync_plugins(home) == []  # 个人模式：没有 plugin.json
    mtent.apply(home, _spec(monkeypatch, plugin=False), fetch=lambda url, what: b"")
    profile = _employee_profile(home, "my-bot", "model:\n  default: m1\n")
    assert mtent.sync_plugins(home) == []
    assert "plugins" not in yaml.safe_load((profile / "config.yaml").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- 镜像

def test_one_name_everywhere() -> None:
    entry_points = configparser.ConfigParser()
    entry_points.read(DEPLOY / "plugin" / "uniwork_enterprise-1.0.dist-info" / "entry_points.txt", encoding="utf-8")
    assert entry_points["hermes_agent.plugins"][UNIWORK_PLUGIN_KEY] == "uniwork_enterprise:register"
    assert mtent.PLUGIN_KEY == UNIWORK_PLUGIN_KEY
    init = (DEPLOY / "plugin" / "uniwork_enterprise" / "__init__.py").read_text(encoding="utf-8")
    assert f'PLUGIN_KEY = "{UNIWORK_PLUGIN_KEY}"' in init
    settings = (DEPLOY / "plugin" / "uniwork_enterprise" / "settings.py").read_text(encoding="utf-8")
    assert f'CONFIG_FILE = "{mtent.PLUGIN_FILE}"' in settings


def test_the_image_installs_the_plugin_and_the_fingerprint_covers_it() -> None:
    dockerfile = (DEPLOY / "Dockerfile.cube").read_text(encoding="utf-8")
    assert "COPY plugin/ /tmp/uniwork-plugin/" in dockerfile
    assert 'e.name == "uniwork-enterprise" and e.value == "uniwork_enterprise:register"' in dockerfile
    deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
    fingerprint = deploy[deploy.index("fingerprint() {"):deploy.index("plugin_files() {")]
    assert "for f in $(plugin_files); do" in fingerprint
    assert "! -path '*/__pycache__/*'" in deploy[deploy.index("plugin_files() {"):]
