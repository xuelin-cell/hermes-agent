from __future__ import annotations
from .test_unisearch import load_package

load_package()

import pytest

from unisearch_test_plugin.fetch.builtin.security import NetworkPolicy, URLSecurityError


# 提供确定的公网DNS答案，避免测试依赖外网。
async def _public_resolver(hostname: str, port: int) -> tuple[str, ...]:
    del hostname, port
    return ("93.184.216.34",)


# 提供确定的私网DNS答案，验证拒绝发生在传输之前。
async def _private_resolver(hostname: str, port: int) -> tuple[str, ...]:
    del hostname, port
    return ("93.184.216.34", "127.0.0.1")


# 地址规范化不把片段发送给网页服务器。
@pytest.mark.asyncio
async def test_policy_normalizes_url_and_removes_fragment() -> None:
    policy = NetworkPolicy(resolver=_public_resolver)

    result = await policy.validate("HTTPS://Example.COM./docs?q=1#section")

    assert result == "https://example.com/docs?q=1"


# DNS任一答案为私网时都拒绝，不选择其中公网地址放行。
@pytest.mark.asyncio
async def test_policy_blocks_hostname_resolving_to_any_private_address() -> None:
    policy = NetworkPolicy(resolver=_private_resolver)

    with pytest.raises(URLSecurityError, match="private/internal"):
        await policy.validate("https://example.com/")


# 允许域名包含其子域名，不放宽到无关主机。
@pytest.mark.asyncio
async def test_policy_allowlist_includes_subdomains_but_not_other_hosts() -> None:
    policy = NetworkPolicy(allowed_hosts=("example.com",), resolver=_public_resolver)

    assert (
        await policy.validate("https://docs.example.com/")
        == "https://docs.example.com/"
    )
    with pytest.raises(URLSecurityError, match="allowlist"):
        await policy.validate("https://example.org/")


# 拒绝域名同时覆盖其子域名。
@pytest.mark.asyncio
async def test_policy_blocklist_includes_subdomains() -> None:
    policy = NetworkPolicy(
        blocked_hosts=("blocked.example",), resolver=_public_resolver
    )

    with pytest.raises(URLSecurityError, match="blocked host"):
        await policy.validate("https://cdn.blocked.example/")


# 硬拒绝在DNS前生效，允许列表不能将其放开。
@pytest.mark.asyncio
async def test_hard_blocked_domain_is_rejected_before_dns_and_allowlist_cannot_override() -> (
    None
):
    resolver_called = False

    # 在DNS边界提供测试答案，不替换安全决策。
    async def resolver(hostname: str, port: int) -> tuple[str, ...]:
        nonlocal resolver_called
        del hostname, port
        resolver_called = True
        return ("93.184.216.34",)

    policy = NetworkPolicy(allowed_hosts=("webhook.site",), resolver=resolver)

    with pytest.raises(URLSecurityError, match="blocked"):
        await policy.validate("https://probe.webhook.site/callback")
    assert not resolver_called
