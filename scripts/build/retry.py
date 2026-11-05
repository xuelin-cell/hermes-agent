"""Retry utilities for handling transient file system errors.

Windows antivirus software (notably corporate AV like 奇安信天擎) can momentarily
lock files after creation, causing PermissionError during build operations. These
utilities provide exponential-backoff retry mechanisms to handle such transient locks.
"""
from __future__ import annotations

import time
from typing import Callable, TypeVar

T = TypeVar("T")


def retry_on_permission_error(
    func: Callable[[], T],
    max_retries: int = 3,
    delay: float = 1.0,
    operation_name: str = "file operation",
) -> T:
    """Execute a function with retry on PermissionError.

    Handles transient AV file locks by retrying with exponential backoff.

    Args:
        func: The callable to execute.
        max_retries: Maximum number of retry attempts (default 3).
        delay: Initial delay in seconds before first retry (default 1.0).
        operation_name: Description for log messages (default "file operation").

    Returns:
        The return value of the function call.

    Raises:
        PermissionError: If all retries are exhausted.
    """
    for attempt in range(max_retries):
        try:
            return func()
        except PermissionError as e:
            if attempt == max_retries - 1:
                raise
            wait = delay * (2 ** attempt)
            filename = getattr(e, "filename", "unknown")
            print(
                f"[{operation_name}] 文件被锁定（{filename}），"
                f"{wait:.1f}秒后重试（{attempt + 1}/{max_retries}）...",
                flush=True,
            )
            time.sleep(wait)
    # Unreachable, but satisfies type checker
    raise PermissionError(f"{operation_name}: all retries exhausted")
