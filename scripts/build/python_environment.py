"""Reliable Python environment construction for desktop build stages."""
from __future__ import annotations

import os
from pathlib import Path
import time

import pm

from scripts.build.filesystem import remove_build_tree
from scripts.build.retry import retry_on_permission_error


def build_python_environment(*, label: str, **arguments) -> Path:
    """构建隔离环境，并重试 Windows 上 UV 启动器的瞬时 PE 文件锁。"""
    return retry_python_environment(pm.build_environment, destination=Path(arguments["out"]),
                                    label=label, arguments=arguments)


def retry_python_environment(operation, *, destination: Path, label: str, arguments: dict):
    """为应用环境和 PM runtime 统一处理已知的 UV 启动器锁。"""
    max_attempts = 5
    delays = [1, 2, 3, 5, 8]  # 延迟序列：总计 ~19 秒
    for attempt in range(max_attempts):
        try:
            return operation(**arguments)
        except pm.InstallError as exc:
            transient = (os.name == "nt" and "Failed to update Windows PE resources" in exc.cause
                         and "uv-trampoline-" in exc.cause)
            if not transient or attempt == max_attempts - 1:
                raise
            # Clean up partial install before retry
            try:
                remove_build_tree(destination)
            except PermissionError:
                # If cleanup fails due to locks, wait a bit before retry
                print(f"  [{label}] cleanup blocked by AV, waiting 2s...", flush=True)
                time.sleep(2.0)
            
            delay = delays[attempt]
            print(f"  {label}: Windows held a uv launcher; retrying ({attempt + 2}/{max_attempts}) "
                  f"after {delay}s...", flush=True)
            time.sleep(delay)
    raise AssertionError("unreachable")
