"""Reliable Python environment construction for desktop build stages."""
from __future__ import annotations

import os
from pathlib import Path
import time

import pm

from scripts.build.filesystem import remove_build_tree


def build_python_environment(*, label: str, **arguments) -> Path:
    """构建隔离环境，并重试 Windows 上 UV 启动器的瞬时 PE 文件锁。"""
    return retry_python_environment(pm.build_environment, destination=Path(arguments["out"]),
                                    label=label, arguments=arguments)


def retry_python_environment(operation, *, destination: Path, label: str, arguments: dict):
    """为应用环境和 PM runtime 统一处理已知的 UV 启动器锁。"""
    for attempt in range(5):
        try:
            return operation(**arguments)
        except pm.InstallError as exc:
            transient = (os.name == "nt" and "Failed to update Windows PE resources" in exc.cause
                         and "uv-trampoline-" in exc.cause)
            if not transient or attempt == 4:
                raise
            remove_build_tree(destination)
            print(f"  {label}: Windows held a uv launcher; retrying ({attempt + 2}/5)...", flush=True)
            time.sleep(0.5 * 2 ** attempt)
    raise AssertionError("unreachable")
