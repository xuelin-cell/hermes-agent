"""第 2 批 E4 / E5：套餐的上下文长度、平台策略、推理强度预设，从登录一路写到用户的 config.yaml。"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
import yaml

from entry.config import Settings
from entry.maas import Plan
from entry.store import Store, TenantContext
from entry import tenants as tenants_module
from entry.tenants import PLATFORM_POLICY, TenantManager, parse_reasoning_defaults

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
    assert spec["policy"] == PLATFORM_POLICY
    assert spec["reasoning_defaults"] == {"deepseek-v4.1-flash": "high"}
    off = _manager(monkeypatch, default_context_window=0, reasoning_defaults="")
    spec = off._config_patch_spec(("http://plan/v1", "m1"), [("m1", ""), ("m2", "")], {"m1": 300000})
    assert spec["limits"] == {"m1": 300000} and spec["reasoning_defaults"] == {}


def test_rendered_template_is_valid_yaml_with_the_new_sections(monkeypatch: pytest.MonkeyPatch) -> None:
    mgr = _manager(monkeypatch)
    text = mgr._render_user_files("", ("http://plan/v1", "m1"), [("m1", ""), ("m2", "")], {"m1": 300000})["config.yaml"]
    cfg = yaml.safe_load(text)
    assert cfg["providers"]["yuanjing"]["models"] == {"m1": {"context_length": 300000}, "m2": {"context_length": 128000}}
    assert cfg["model_catalog"] == {"enabled": False}
    assert cfg["security"] == {"allow_lazy_installs": False}
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


def test_old_entry_spec_still_patches_like_before(mtstate) -> None:
    """新转发器 + 还没升级的入口：spec 里没有新字段，只改原来那几项，不加新段。"""
    new_text, _ = mtstate.patch_config_text("model: {}\n", _spec())
    cfg = yaml.safe_load(new_text)
    assert cfg["providers"]["yuanjing"]["models"] == {"m1": {}, "deepseek-v4.1-flash": {}}
    assert "model_catalog" not in cfg and "security" not in cfg and "agent" not in cfg
