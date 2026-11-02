"""Synchronous URL validation used by web tools.

The built-in fetch provider performs the DNS-aware checks immediately before
network access.  This module intentionally contains the fast, side-effect-free
checks shared by every fetch provider.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

_HTTP_SCHEMES = frozenset({"http", "https"})
_BLOCKED_HOSTS = frozenset({
    "burpcollaborator.net",
    "canarytokens.org",
    "ceye.io",
    "ceye.org",
    "dig.pm",
    "dnsbin.zhack.ca",
    "dnslog.cn",
    "interactsh.com",
    "localhost",
    "localhost.localdomain",
    "ngrok.io",
    "nip.io",
    "oastify.com",
    "pipedream.net",
    "requestbin.net",
    "requestrepo.com",
    "webhook.site",
    "xip.io",
})


# 禁止域名及其子域名都执行同一拒绝规则。
def _is_blocked_host(hostname: str) -> bool:
    """Return whether a hostname matches a hard-blocked domain or subdomain."""
    return any(
        hostname == blocked or hostname.endswith(f".{blocked}")
        for blocked in _BLOCKED_HOSTS
    )


# 同时覆盖IPv4映射、非公网及组播地址，避免私网漏判。
def is_private_ip(ip_str: str) -> bool:
    """Return whether *ip_str* is unsafe for an outbound web request.

    All non-global addresses are rejected, including loopback, private,
    link-local, carrier-grade NAT, multicast, reserved and unspecified ranges.
    Invalid strings are not IP addresses and therefore return ``False``.
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False

    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return is_private_ip(str(ip.ipv4_mapped))
    return not ip.is_global or ip.is_multicast


# 快速拒绝非法协议、嵌入凭证及字面内网地址。
def validate_url(url: str) -> str | None:  # noqa: PLR0911
    """Validate the URL syntax and reject literal internal targets.

    Returns:
        ``None`` when valid, otherwise a user-facing error message.
    """
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        return f"Invalid URL format: {exc}"

    if parsed.scheme.lower() not in _HTTP_SCHEMES:
        return f"Invalid URL: scheme '{parsed.scheme}' not allowed. Use http:// or https://"
    if not parsed.hostname:
        return "Invalid URL: missing hostname."
    if parsed.username is not None or parsed.password is not None:
        return "Invalid URL: embedded credentials are not allowed."
    if port == 0:
        return "Invalid URL: port 0 is not allowed."

    try:
        hostname = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError:
        return "Invalid URL: hostname is not valid IDNA."

    if _is_blocked_host(hostname) or hostname.endswith(".localhost"):
        return f"Invalid URL: access to '{hostname}' is blocked."
    if is_private_ip(hostname):
        return "Invalid URL: access to private/internal IP addresses is blocked."
    return None
