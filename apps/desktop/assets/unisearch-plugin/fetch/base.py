"""Base protocol and types for fetch providers.

This module defines the FetchProvider protocol and result types that
all fetch provider implementations must follow.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, kw_only=True)
class FetchResult:
    """Result from a fetch operation.

    Attributes:
        content: The extracted content from the web page (typically markdown).
        url: The final URL after any redirects.
        title: The page title, if available.
        provider: Name of the fetch provider that returned this result.
        links: Normalized links discovered in the fetched page HTML, when the
            provider supports link discovery.
    """

    content: str
    url: str
    title: str | None = None
    provider: str | None = None
    links: tuple[str, ...] = ()


@runtime_checkable
class FetchProvider(Protocol):
    """Protocol for fetch providers.

    Fetch providers implement web page fetching and content extraction
    using various backends (Firecrawl, Jina, etc.).

    Attributes:
        name: Unique identifier for the provider (used in cache keys).

    Examples:
        ```python
        class MyFetchProvider:
            name: str = "my_provider"

            async def fetch(self, url: str) -> FetchResult:
                # Implementation
                ...
        ```
    """

    name: str

    # 当前策略与总预算内获取页面，安全拒绝不通过其他引擎绕行。
    async def fetch(self, url: str) -> FetchResult:
        """Fetch and extract content from a web page.

        Args:
            url: The URL to fetch.

        Returns:
            FetchResult containing the extracted content.

        Raises:
            ConfigurationError: If required API keys are missing.
            Exception: If the fetch request fails.
        """
        ...
