"""Load the fixed, offline catalog; never evaluate upstream expressions."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from importlib.resources import files
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from .types import DetectionMethod, SensitiveUnavailableError

RULE_COUNT = 71
EXCLUDED_RULE_IDS = frozenset(
    {
        "nuget-config-password",
        "github-app-token",
        "github-pat",
        "cloudflare-api-key",
        "cloudflare-global-api-key",
        "cloudflare-origin-ca-key",
        "cohere-api-token",
        "linear-api-key",
        "linear-client-secret",
        "mistral-api-key",
    }
)
PII_VALIDATORS = {
    "uniwork.pii.cn-id-card": "cn_id_card",
    "uniwork.pii.bank-card-number": "luhn_pan",
    "uniwork.pii.cn-mobile": "cn_mobile_format",
}


class _AssetModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _Entropy(_AssetModel):
    op: Literal["entropy"]
    comparison: Literal["<", "<="]
    threshold: float = Field(ge=0)


class _MatchesAny(_AssetModel):
    op: Literal["matches_any"]
    patterns: tuple[str, ...] = Field(min_length=1)


class _ContainsAny(_AssetModel):
    op: Literal["contains_any"]
    values: tuple[str, ...] = Field(min_length=1)


Condition = Annotated[_Entropy | _MatchesAny | _ContainsAny, Field(discriminator="op")]


class _Runtime(_AssetModel):
    regex: str
    keywords: tuple[str, ...] = ()
    secret_group: int | None = Field(default=None, ge=1)
    exclude_if_any: tuple[Condition, ...] = ()
    validator: Literal["cn_id_card", "luhn_pan", "cn_mobile_format"] | None = None
    context_keywords: tuple[str, ...] = ()
    require_context: bool = False
    priority: int = 0


class SensitiveRule(_AssetModel):
    """A read-only definition and its reviewed execution data."""

    id: str
    name: str
    kind: Literal["credential", "pii"]
    source: str
    methods: tuple[DetectionMethod, ...]
    definition_format: Literal["toml", "json"]
    definition_text: str
    runtime: _Runtime


class _Upstream(_AssetModel):
    version: str
    commit: str
    config_sha256: str


class _CatalogAsset(_AssetModel):
    schema_version: int = Field(strict=True)
    upstream: _Upstream
    adaptations: tuple[str, ...]
    common_exclude_if_any: tuple[Condition, ...]
    rules: tuple[SensitiveRule, ...]


@dataclass(frozen=True)
class CompiledCondition:
    """One of the three supported, already validated exclusion operations."""

    definition: _Entropy | _MatchesAny | _ContainsAny
    patterns: tuple[re.Pattern[str], ...] = ()


@dataclass(frozen=True)
class CompiledRule:
    """Compiled execution data, shared without retaining user text."""

    definition: SensitiveRule
    pattern: re.Pattern[str]
    exclusions: tuple[CompiledCondition, ...]


@dataclass(frozen=True)
class SensitiveCatalog:
    """Complete immutable directory and version used by settings and inspection."""

    version: str
    rules: tuple[CompiledRule, ...]
    common_exclusions: tuple[CompiledCondition, ...]


def _compile_conditions(conditions: tuple[Condition, ...]) -> tuple[CompiledCondition, ...]:
    return tuple(
        CompiledCondition(
            condition,
            tuple(re.compile(pattern, re.ASCII) for pattern in condition.patterns) if isinstance(condition, _MatchesAny) else (),
        )
        for condition in conditions
    )


def _compile_catalog(asset: _CatalogAsset, version: str) -> SensitiveCatalog:
    ids = [rule.id for rule in asset.rules]
    if asset.schema_version != 1 or len(ids) != RULE_COUNT or len(set(ids)) != RULE_COUNT or EXCLUDED_RULE_IDS.intersection(ids):
        raise SensitiveUnavailableError
    if {rule.id for rule in asset.rules if rule.kind == "pii"} != set(PII_VALIDATORS):
        raise SensitiveUnavailableError
    compiled = []
    for rule in asset.rules:
        pattern = re.compile(rule.runtime.regex, re.ASCII)
        group = rule.runtime.secret_group
        if group is not None and group > pattern.groups:
            raise SensitiveUnavailableError
        if rule.kind == "credential":
            if not rule.runtime.keywords or rule.runtime.validator is not None:
                raise SensitiveUnavailableError
        elif rule.runtime.validator != PII_VALIDATORS[rule.id] or group is None:
            raise SensitiveUnavailableError
        compiled.append(CompiledRule(rule, pattern, _compile_conditions(rule.runtime.exclude_if_any)))
    return SensitiveCatalog(version, tuple(compiled), _compile_conditions(asset.common_exclude_if_any))


@lru_cache(maxsize=1)
def get_sensitive_catalog() -> SensitiveCatalog:
    """Load all 71 rules or fail explicitly, independently of Agent startup."""
    try:
        raw = files(__package__).joinpath("assets/catalog.json").read_text(encoding="utf-8")
        asset = _CatalogAsset.model_validate_json(raw, strict=True)
        canonical = json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return _compile_catalog(asset, hashlib.sha256(canonical).hexdigest())
    except (OSError, ValueError, TypeError, re.error) as exc:
        raise SensitiveUnavailableError from exc
