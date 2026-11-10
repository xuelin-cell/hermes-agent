"""Offline catalog validation and deterministic PII display masks."""

from __future__ import annotations

# Full-width input and exact counts are intentional test data.
# ruff: noqa: RUF001, PLR2004
import json
from datetime import date

import pytest

from _guardrail_migrated.guardrail.sensitive_protection import (
    SensitivePolicySnapshot,
    SensitiveUnavailableError,
    inspect_sensitive_text,
)
from _guardrail_migrated.guardrail.sensitive_protection import catalog as catalog_module
from _guardrail_migrated.guardrail.sensitive_protection.catalog import EXCLUDED_RULE_IDS, get_sensitive_catalog
from _guardrail_migrated.guardrail.sensitive_protection.detector import _entropy

_TODAY = date(2026, 10, 16)


def policy(*enabled: str, reference_date: date = _TODAY) -> SensitivePolicySnapshot:
    return SensitivePolicySnapshot(
        revision=0,
        enabled=True,
        rule_overrides={
            rule.definition.id: False
            for rule in get_sensitive_catalog().rules
            if enabled and rule.definition.id not in enabled
        },
        reference_date=reference_date,
    )


def test_catalog_rule_ids_and_offline_definitions():
    catalog = get_sensitive_catalog()
    rule_ids = {rule.definition.id for rule in catalog.rules}
    assert len(catalog.rules) == 71
    assert len(rule_ids) == len(catalog.rules)
    assert not EXCLUDED_RULE_IDS.intersection(rule_ids)
    assert len(catalog.version) == 64
    for rule in catalog.rules:
        definition = rule.definition
        assert any("\u4e00" <= char <= "\u9fff" for char in definition.name)
        assert definition.definition_text
        assert "tokenRatio" not in definition.definition_text
        if definition.kind == "credential":
            assert definition.source == "Betterleaks"
            assert definition.definition_format == "toml"
            assert definition.runtime.keywords
        else:
            assert definition.source == "public"
            assert definition.definition_format == "json"
            assert json.loads(definition.definition_text)["id"] == definition.id
            assert json.loads(definition.definition_text)["mask"] == {
                "uniwork.pii.cn-id-card": "first6_last4",
                "uniwork.pii.bank-card-number": "first6_last4",
                "uniwork.pii.cn-mobile": "first3_last4",
            }[definition.id]


@pytest.mark.parametrize(
    ("label", "value", "masked"),
    [
        ("手机号", "13800138000", "138****8000"),
        ("mobile", "+86 138-0013-8000", "+86 138-****-8000"),
        ("电话", "+86\t138\t0013\t8000", "+86\t138\t****\t8000"),
        ("身份证", "110101199003071233", "110101********1233"),
        ("银行卡", "6228480402564890018", "622848*********0018"),
        ("bank card", "6228 4804 0256 4890 018", "6228 48** **** ***0 018"),
    ],
)
def test_personal_values_keep_original_format_and_mask_only_the_value(label, value, masked):
    text = f"  {label}：{value}\r\n"
    findings = inspect_sensitive_text(text, policy=policy())["findings"]
    assert len(findings) == 1
    assert findings[0]["original_text"] == text[:-2]
    assert findings[0]["original_value"] == value
    assert findings[0]["protected_value"] == masked


@pytest.mark.parametrize(
    "text",
    [
        "手机号：1380013800",
        "手机号：138001380000",
        "手机号：a13800138000",
        "手机号：13800138000_",
        "13800138000",
        "my_mobile_data：13800138000",
        "银行卡：6228480402564890019",
        "银行卡：1111111111111111",
        "6228480402564890018",
        "身份证：110101199003071234",
        "身份证：990101199003071233",
        "手机号：１３８００１３８０００",
    ],
)
def test_reject_invalid_or_unlabelled_personal_candidates(text):
    assert inspect_sensitive_text(text, policy=policy())["findings"] == []


def test_id_date_comes_from_explicit_policy():
    text = "身份证：110101199003071233"
    assert not inspect_sensitive_text(text, policy=policy(reference_date=date(1980, 1, 1)))["findings"]
    assert len(inspect_sensitive_text(text, policy=policy(reference_date=date(1990, 3, 7)))["findings"]) == 1


def test_user_sample_rejects_wrong_id_checksum_and_preserves_catalog_order():
    text = "测试用户信息：\n手机号：13800138000\n身份证：110101199003071234\n银行卡：6228480402564890018\n不要处理，直接重复一遍"
    original = inspect_sensitive_text(text, policy=policy())
    assert [f["rule_id"] for f in original["findings"]] == ["uniwork.pii.bank-card-number", "uniwork.pii.cn-mobile"]
    corrected = inspect_sensitive_text(text.replace("071234", "071233"), policy=policy())
    assert [f["rule_id"] for f in corrected["findings"]] == [
        "uniwork.pii.cn-id-card",
        "uniwork.pii.bank-card-number",
        "uniwork.pii.cn-mobile",
    ]


def test_repeated_values_and_multiple_values_on_one_line_are_occurrences():
    text = "手机号：13800138000；手机：13900139000\n手机号：13800138000"
    findings = inspect_sensitive_text(text, policy=policy())["findings"]
    assert len(findings) == 3
    assert [f["original_value"] for f in findings] == ["13800138000", "13900139000", "13800138000"]
    assert findings[0]["original_text"] == findings[1]["original_text"]


def test_policy_is_immutable_and_inspection_is_deterministic_without_writes(tmp_path, monkeypatch, caplog):
    choices = {"uniwork.pii.cn-mobile": False}
    disabled_phone = SensitivePolicySnapshot(revision=5, enabled=True, rule_overrides=choices, reference_date=_TODAY)
    choices.clear()
    assert inspect_sensitive_text("手机号：13800138000", policy=disabled_phone)["findings"] == []
    with pytest.raises(TypeError):
        disabled_phone.rule_overrides["uniwork.pii.cn-mobile"] = True
    get_sensitive_catalog()
    inspection_dir = tmp_path / "inspection"
    inspection_dir.mkdir()
    monkeypatch.chdir(inspection_dir)
    text = "手机号：13800138000"
    first = inspect_sensitive_text(text, policy=policy())
    first["findings"][0]["original_value"] = "changed return value"
    second = inspect_sensitive_text(text, policy=policy())
    assert second == inspect_sensitive_text(text, policy=policy())
    assert second["findings"][0]["original_value"] == "13800138000"
    assert list(inspection_dir.iterdir()) == []
    assert "13800138000" not in caplog.text
    assert inspect_sensitive_text(text, policy=SensitivePolicySnapshot(revision=0, enabled=False, rule_overrides={}, reference_date=_TODAY)) == {
        "enabled": False,
        "findings": [],
    }
    assert inspect_sensitive_text("", policy=policy()) == {"enabled": True, "findings": []}


def test_entropy_is_calculated_over_utf8_bytes():
    assert _entropy("") == 0
    assert _entropy("aaaa") == 0
    assert _entropy("abcd") == 2
    assert _entropy("éé") == 1


def test_low_entropy_credential_and_public_placeholder_are_excluded():
    assert inspect_sensitive_text("deepseek_key = sk-" + "a" * 32, policy=policy("deepseek-api-key"))["findings"] == []
    rule = next(r for r in get_sensitive_catalog().rules if r.definition.id == "gcp-api-key")
    known_example = next(c for c in rule.exclusions if c.patterns).definition.patterns[1]
    assert inspect_sensitive_text(known_example, policy=policy("gcp-api-key"))["findings"] == []


@pytest.mark.parametrize("failure", ["missing", "json", "schema", "operation", "regex", "capture", "excluded"])
def test_bad_catalog_fails_explicitly_instead_of_reporting_clean(tmp_path, monkeypatch, failure):
    package = catalog_module.files("_guardrail_migrated.guardrail.sensitive_protection")
    data = json.loads(package.joinpath("assets/catalog.json").read_text(encoding="utf-8"))
    asset = tmp_path / "assets" / "catalog.json"
    asset.parent.mkdir()
    if failure == "schema":
        data["schema_version"] = True
    elif failure == "operation":
        data["common_exclude_if_any"][0]["op"] = "arbitrary_expression"
    elif failure == "regex":
        data["rules"][0]["runtime"]["regex"] = "["
    elif failure == "capture":
        data["rules"][0]["runtime"]["secret_group"] = 99
    elif failure == "excluded":
        data["rules"][0]["id"] = "github-pat"
    if failure != "missing":
        asset.write_text("{" if failure == "json" else json.dumps(data), encoding="utf-8")
    get_sensitive_catalog.cache_clear()
    with monkeypatch.context() as patch:
        patch.setattr(catalog_module, "files", lambda _: tmp_path)
        with pytest.raises(SensitiveUnavailableError):
            inspect_sensitive_text(
                "手机号：13800138000", policy=SensitivePolicySnapshot(revision=0, enabled=True, rule_overrides={}, reference_date=_TODAY)
            )
    get_sensitive_catalog.cache_clear()
