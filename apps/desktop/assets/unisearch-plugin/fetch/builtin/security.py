"""DNS-aware outbound request policy for the built-in fetch provider."""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from urllib.parse import SplitResult, urlsplit, urlunsplit

from ..validation import is_private_ip, validate_url

Resolver = Callable[[str, int], Awaitable[Sequence[str]]]


class URLSecurityError(ValueError):
    """Raised when an outbound URL violates the network policy."""


# 全部DNS结果都要纳入策略，解析放到事件循环的解析接口。
async def _resolve_host(hostname: str, port: int) -> Sequence[str]:
    """Resolve all addresses for a hostname without blocking the event loop."""
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    return tuple(dict.fromkeys(record[4][0] for record in records))


# 域名规则统一IDNA与大小写，保持子域名比较一致。
def _normalize_patterns(patterns: Iterable[str]) -> frozenset[str]:
    normalized: set[str] = set()
    for pattern in patterns:
        value = pattern.strip().lstrip(".").rstrip(".").lower()
        if value:
            normalized.add(value.encode("idna").decode("ascii"))
    return frozenset(normalized)


# 匹配完整域名或其子域名，避免部分字符串误命中。
def _matches(hostname: str, patterns: frozenset[str]) -> bool:
    return any(
        hostname == pattern or hostname.endswith(f".{pattern}") for pattern in patterns
    )


@dataclass(frozen=True, slots=True)
class NetworkPolicy:
    """Validate initial URLs, redirects and browser subresource requests.

    An allowlist, when supplied, restricts requests to those domains and their
    subdomains. It never overrides the private-network prohibition.
    """

    allowed_hosts: frozenset[str] = field(default_factory=frozenset)
    blocked_hosts: frozenset[str] = field(default_factory=frozenset)
    resolver: Resolver = _resolve_host

    # 统一域名规则，显式允许域名也不能放宽私网限制。
    def __init__(
        self,
        *,
        allowed_hosts: Iterable[str] = (),
        blocked_hosts: Iterable[str] = (),
        resolver: Resolver = _resolve_host,
    ) -> None:
        """Initialize domain rules and the DNS resolver."""
        object.__setattr__(self, "allowed_hosts", _normalize_patterns(allowed_hosts))
        object.__setattr__(self, "blocked_hosts", _normalize_patterns(blocked_hosts))
        object.__setattr__(self, "resolver", resolver)

    # 域名白名单不放宽私网禁令，解析到任一非公网地址即拒绝。
    async def validate(self, url: str) -> str:
        """Return a normalized URL after syntax, host policy and DNS checks."""
        syntax_error = validate_url(url)
        if syntax_error is not None:
            raise URLSecurityError(syntax_error)

        parsed = urlsplit(url)
        parsed_hostname = parsed.hostname
        if parsed_hostname is None:  # Defensive; validate_url already rejects this.
            message = "Invalid URL: missing hostname."
            raise URLSecurityError(message)
        hostname = parsed_hostname.rstrip(".").encode("idna").decode("ascii").lower()

        if _matches(hostname, self.blocked_hosts):
            message = f"Access to blocked host '{hostname}' is not allowed."
            raise URLSecurityError(message)
        if self.allowed_hosts and not _matches(hostname, self.allowed_hosts):
            message = f"Host '{hostname}' is not in the web fetch allowlist."
            raise URLSecurityError(message)

        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        try:
            addresses = await self.resolver(hostname, port)
        except (OSError, socket.gaierror) as exc:
            message = f"Could not resolve host '{hostname}': {exc}"
            raise URLSecurityError(message) from exc
        if not addresses:
            message = f"Host '{hostname}' did not resolve to an address."
            raise URLSecurityError(message)

        unsafe = [address for address in addresses if is_private_ip(address)]
        if unsafe:
            message = f"Host '{hostname}' resolves to a private/internal address and is blocked."
            raise URLSecurityError(message)

        netloc = hostname
        if ":" in hostname:
            netloc = f"[{hostname}]"
        if parsed.port is not None:
            netloc = f"{netloc}:{parsed.port}"
        normalized = SplitResult(
            parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, ""
        )
        return urlunsplit(normalized)
