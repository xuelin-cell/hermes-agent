"""第 2 批 E4 / E5：套餐的上下文长度、平台策略、推理强度预设，从登录一路写到用户的 config.yaml。"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

from entry.config import Settings
from entry.maas import Plan
from entry.store import Store, TenantContext
from entry import tenants as tenants_module
from entry.tenants import PLATFORM_POLICY, YUANJING_MCP_NAME, TenantManager, parse_reasoning_defaults

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"


@pytest.fixture
def mtstate():
    if str(SEED_DIR) not in sys.path:
        sys.path.insert(0, str(SEED_DIR))
    return importlib.import_module("mtstate")


def _manager(monkeypatch: pytest.MonkeyPatch, **settings) -> TenantManager:
    monkeypatch.setattr(tenants_module, "SEED_DIR", SEED_DIR)
    return TenantManager(Settings(**settings), None, None, None, None)  # type: ignore[arg-type]


def test_plan_limits_reads_context_window_per_model() -> None:
    plan = Plan(api_key="k", main_model_id="1", models=[
        {"id": "1", "model": "deepseek-v4-flash", "context_window": 300000},
        {"id": "2", "model": "glm-5.2", "context_window": "240000"},
        {"id": "3", "model": "no-window"},
        {"id": "4", "model": "bad", "context_window": "lots"},
        {"id": "5", "model": "zero", "context_window": 0},
        {"id": "6", "model": "flag", "context_window": True},
    ])
    assert plan.limits() == {"deepseek-v4-flash": 300000, "glm-5.2": 240000}
    assert "deepseek-v4-flash@?/300000" in plan.summary() and "no-window@?/?" in plan.summary()


def test_catalog_json_carries_context_window_and_old_rows_decode_to_nothing() -> None:
    raw = Store._catalog_json([("m1", "http://a/v1"), ("m2", "")], {"m1": 300000})
    assert Store._decode_catalog(raw) == [("m1", "http://a/v1"), ("m2", "")]
    assert Store._decode_limits(raw) == {"m1": 300000}
    old = '[{"model_name":"m1","base_url":""}]'  # 10-09 之前存的
    assert Store._decode_limits(old) == {} and Store._decode_catalog(old) == [("m1", "")]
    assert Store._decode_limits("not json") == {}


def test_tenant_context_limits_default_to_empty() -> None:
    ctx = TenantContext(api_key="", container_token="", endpoint=None, catalog=[])
    assert ctx.limits == {}


def test_parse_reasoning_defaults() -> None:
    assert parse_reasoning_defaults("deepseek-v4.1-flash=high, glm-5.2 = low ,bad,=x,y=") == {
        "deepseek-v4.1-flash": "high", "glm-5.2": "low"}
    assert parse_reasoning_defaults("") == {}


def test_patch_spec_has_limits_policy_and_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    mgr = _manager(monkeypatch)
    spec = mgr._config_patch_spec(("http://plan/v1", "m1"), [("m1", ""), ("m2", "")], {"m1": 300000})
    assert spec["limits"] == {"m1": 300000, "m2": 128000}  # 套餐没给的按兜底值
    assert spec["policy"] == {**PLATFORM_POLICY, "agent": {"reasoning_effort": "high"}}
    assert spec["reasoning_defaults"] == {"deepseek-v4.1-flash": "high"}
    off = _manager(monkeypatch, default_context_window=0, reasoning_defaults="", default_reasoning_effort="")
    spec = off._config_patch_spec(("http://plan/v1", "m1"), [("m1", ""), ("m2", "")], {"m1": 300000})
    assert spec["limits"] == {"m1": 300000} and spec["reasoning_defaults"] == {}
    assert spec["policy"] == PLATFORM_POLICY


def test_rendered_template_is_valid_yaml_with_the_new_sections(monkeypatch: pytest.MonkeyPatch) -> None:
    mgr = _manager(monkeypatch)
    text = mgr._render_user_files("", ("http://plan/v1", "m1"), [("m1", ""), ("m2", "")], {"m1": 300000})["config.yaml"]
    cfg = yaml.safe_load(text)
    assert cfg["providers"]["yuanjing"]["models"] == {"m1": {"context_length": 300000}, "m2": {"context_length": 128000}}
    assert cfg["model_catalog"] == {"enabled": False}
    assert cfg["security"] == {"allow_lazy_installs": False}
    assert cfg["onboarding"] == {"profile_build": "off"}
    assert cfg["agent"]["reasoning_overrides"] == {"deepseek-v4.1-flash": "high"}
    plain = _manager(monkeypatch, reasoning_defaults="")
    cfg = yaml.safe_load(plain._render_user_files("", ("http://plan/v1", "m1"), [("m1", "")])["config.yaml"])
    assert "agent" not in cfg


def _spec(**extra) -> dict:
    spec = {"base_url": "http://plan/v1", "model": "m1", "provider_key": "yuanjing", "key_env": "K",
            "models": ["m1", "deepseek-v4.1-flash"], "template": ""}
    spec.update(extra)
    return spec


def test_patch_writes_limits_policy_and_reasoning_for_an_existing_user(mtstate) -> None:
    user_cfg = (
        "model:\n  default: deepseek-v4.1-flash\n  provider: yuanjing\n"
        "providers:\n  yuanjing:\n    api: http://old/v1\n    models:\n      m1: {}\n"
        "display:\n  personality: kawaii\n"
        "security:\n  redact_secrets: true\n"
    )
    full = _spec(limits={"m1": 300000, "deepseek-v4.1-flash": 300000}, policy=PLATFORM_POLICY,
                 reasoning_defaults={"deepseek-v4.1-flash": "high"})
    new_text, notes = mtstate.patch_config_text(user_cfg, full)
    cfg = yaml.safe_load(new_text)
    assert notes
    assert cfg["providers"]["yuanjing"]["models"] == {
        "m1": {"context_length": 300000}, "deepseek-v4.1-flash": {"context_length": 300000}}
    assert cfg["model_catalog"]["enabled"] is False
    assert cfg["security"] == {"redact_secrets": True, "allow_lazy_installs": False}  # 同一段里用户的设置不动
    assert cfg["onboarding"] == {"profile_build": "off"}  # 按 YAML 1.1 读（hermes 就这么读）也是字符串，不是 False
    assert cfg["agent"]["reasoning_overrides"] == {"deepseek-v4.1-flash": "high"}
    assert cfg["display"] == {"personality": "kawaii"} and cfg["model"]["default"] == "deepseek-v4.1-flash"
    again, notes = mtstate.patch_config_text(new_text, full)
    assert notes == [] and again == new_text  # 第二次引导没有变化


def test_reasoning_default_never_overrides_the_users_own_setting(mtstate) -> None:
    user_cfg = "model: {}\nagent:\n  reasoning_overrides:\n    DeepSeek-V4-1-Flash: low\n"
    new_text, _ = mtstate.patch_config_text(user_cfg, _spec(reasoning_defaults={"deepseek-v4.1-flash": "high"}))
    assert yaml.safe_load(new_text)["agent"]["reasoning_overrides"] == {"DeepSeek-V4-1-Flash": "low"}


def test_policy_wins_over_the_users_value(mtstate) -> None:
    user_cfg = "model: {}\nmodel_catalog:\n  enabled: true\n  ttl_hours: 3\n"
    new_text, notes = mtstate.patch_config_text(user_cfg, _spec(policy=PLATFORM_POLICY))
    cfg = yaml.safe_load(new_text)
    assert notes and cfg["model_catalog"] == {"enabled": False, "ttl_hours": 3}


def test_default_effort_is_platform_managed_and_per_model_ones_stay(mtstate, monkeypatch: pytest.MonkeyPatch) -> None:
    """前端「没选过强度」时用的默认值来自 agent.reasoning_effort：平台每次引导写成 high；按模型的设置不动。"""
    user_cfg = (
        "model: {}\n"
        "agent:\n  reasoning_effort: medium\n  reasoning_overrides:\n    glm-5.2: max\n  max_turns: 30\n"
    )
    spec = _manager(monkeypatch)._config_patch_spec(("http://plan/v1", "m1"), [("m1", "")])
    new_text, notes = mtstate.patch_config_text(user_cfg, _spec(policy=spec["policy"]))
    agent = yaml.safe_load(new_text)["agent"]
    assert notes and agent == {"reasoning_effort": "high", "reasoning_overrides": {"glm-5.2": "max"}, "max_turns": 30}


def test_a_policy_only_change_is_still_written(mtstate, monkeypatch: pytest.MonkeyPatch) -> None:
    """10-10 本机实测撞出来的：新用户的配置和平台块完全一致、只差默认推理强度时，旧的变化检测看不见
    agent 段，判成「没改」不写回，这一项永远落不了地。"""
    mgr = _manager(monkeypatch)
    endpoint, catalog = ("http://plan/v1", "m1"), [("m1", ""), ("deepseek-v4.1-flash", "")]
    fresh = mgr._render_user_files("", endpoint, catalog)["config.yaml"].decode("utf-8")
    spec = mgr._config_patch_spec(endpoint, catalog)
    new_text, notes = mtstate.patch_config_text(fresh, spec)
    assert notes and yaml.safe_load(new_text)["agent"]["reasoning_effort"] == "high"
    again, notes = mtstate.patch_config_text(new_text, spec)
    assert notes == [] and again == new_text


def test_old_entry_spec_still_patches_like_before(mtstate) -> None:
    """新转发器 + 还没升级的入口：spec 里没有新字段，只改原来那几项，不加新段。"""
    new_text, _ = mtstate.patch_config_text("model: {}\n", _spec())
    cfg = yaml.safe_load(new_text)
    assert cfg["providers"]["yuanjing"]["models"] == {"m1": {}, "deepseek-v4.1-flash": {}}
    assert "model_catalog" not in cfg and "security" not in cfg and "agent" not in cfg
    assert "mcp_servers" not in cfg


# ---- 内置的元景 MCP（10-13）

MCP_URL = ("https://maas.ai-yuanjing.com/app/mcp-server/mcp"
           "?key=${HERMES_CUSTOM_YUANJING_API_KEY}&client_id=UniWork&oss_mode=internal")


def test_builtin_mcp_names_the_key_variable_not_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """地址里只有变量名，hermes 连接时从 .env 取；没套餐 key 的用户不给（连上去只会 401）。"""
    mgr = _manager(monkeypatch)
    assert mgr._mcp_servers("sk-secret")[YUANJING_MCP_NAME] == {"url": MCP_URL, "timeout": 600}
    assert mgr._mcp_servers("")[YUANJING_MCP_NAME] is None
    assert _manager(monkeypatch, yuanjing_mcp_url="")._mcp_servers("sk-secret")[YUANJING_MCP_NAME] is None
    other = _manager(monkeypatch, yuanjing_mcp_url="https://mcp.example/mcp?v=2", yuanjing_mcp_client_id="",
                     yuanjing_mcp_oss_mode="", key_env_name="K")
    assert other._mcp_servers("sk-secret")[YUANJING_MCP_NAME]["url"] == "https://mcp.example/mcp?v=2&key=${K}"
    odd = _manager(monkeypatch, yuanjing_mcp_client_id="a&b c")._mcp_servers("sk-secret")
    assert "&client_id=a%26b%20c&" in odd[YUANJING_MCP_NAME]["url"]


def test_builtin_mcp_asks_for_intranet_links(monkeypatch: pytest.MonkeyPatch) -> None:
    """云端版用户的浏览器在内网：默认带 oss_mode=internal，工具产出的文件给内网 OSS 链接（10-13 实测：不带时给的是
    公网链接，内网浏览器打不开）。设成空就不带。"""
    url = _manager(monkeypatch)._mcp_servers("sk-secret")[YUANJING_MCP_NAME]["url"]
    assert url.endswith("&client_id=UniWork&oss_mode=internal")
    public = _manager(monkeypatch, yuanjing_mcp_oss_mode="")._mcp_servers("sk-secret")[YUANJING_MCP_NAME]["url"]
    assert public.endswith("&client_id=UniWork") and "oss_mode" not in public


def test_the_bootstrap_patch_carries_the_builtin_mcp_and_the_docker_path_does_not(
        monkeypatch: pytest.MonkeyPatch) -> None:
    mgr = _manager(monkeypatch)
    endpoint, catalog = ("http://plan/v1", "m1"), [("m1", "")]
    assert YUANJING_MCP_NAME not in mgr._config_patch_spec(endpoint, catalog)["mcp_servers"]  # Docker 不接管元景
    assert mgr._config_patch_spec(endpoint, catalog, api_key="")["mcp_servers"][YUANJING_MCP_NAME] is None
    files = mgr._cube_seed_files("sk-secret", endpoint, catalog)
    patch = next(f for f in files if f["overwrite"] == "patch-model")
    assert json.loads(patch["content"])["mcp_servers"][YUANJING_MCP_NAME]["url"] == MCP_URL
    # 明文 key 只进 .env
    assert [f["path"] for f in files if "sk-secret" in f["content"]] == [".env"]


def test_builtin_mcp_is_added_next_to_the_users_own_and_stays_put(mtstate) -> None:
    user_cfg = "model: {}\nmcp_servers:\n  mine:\n    url: https://mine.example/mcp\n"
    spec = _spec(mcp_servers={YUANJING_MCP_NAME: {"url": MCP_URL, "timeout": 600}})
    new_text, notes = mtstate.patch_config_text(user_cfg, spec)
    servers = yaml.safe_load(new_text)["mcp_servers"]
    assert notes
    assert servers == {"mine": {"url": "https://mine.example/mcp"}, "yuanjing": {"url": MCP_URL, "timeout": 600}}
    again, notes = mtstate.patch_config_text(new_text, spec)
    assert notes == [] and again == new_text  # 第二次引导没有变化


def test_the_user_can_switch_the_builtin_mcp_off(mtstate) -> None:
    """用户在界面里停用了：平台照样刷新地址，停用留着。"""
    user_cfg = (
        "model: {}\nmcp_servers:\n  yuanjing:\n    url: https://old.example/mcp\n    timeout: 30\n"
        "    enabled: false\n"
    )
    spec = _spec(mcp_servers={YUANJING_MCP_NAME: {"url": MCP_URL, "timeout": 600}})
    new_text, notes = mtstate.patch_config_text(user_cfg, spec)
    assert notes and yaml.safe_load(new_text)["mcp_servers"]["yuanjing"] == {
        "url": MCP_URL, "timeout": 600, "enabled": False}


def test_builtin_mcp_goes_away_when_the_platform_stops_offering_it(mtstate) -> None:
    user_cfg = (
        "model: {}\nmcp_servers:\n  mine:\n    url: https://mine.example/mcp\n"
        f"  yuanjing:\n    url: '{MCP_URL}'\n"
    )
    spec = _spec(mcp_servers={YUANJING_MCP_NAME: None})
    new_text, notes = mtstate.patch_config_text(user_cfg, spec)
    assert notes and yaml.safe_load(new_text)["mcp_servers"] == {"mine": {"url": "https://mine.example/mcp"}}
    again, notes = mtstate.patch_config_text(new_text, spec)
    assert notes == [] and again == new_text
    # 本来就没有：什么都不加
    plain, notes = mtstate.patch_config_text("model: {}\n", _spec(mcp_servers={YUANJING_MCP_NAME: None}))
    assert "mcp_servers" not in yaml.safe_load(plain)
