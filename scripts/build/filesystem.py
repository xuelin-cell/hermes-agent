"""Filesystem operations shared by repeatable build stages."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import time


def _clear_readonly_and_retry(function, path: str, _error) -> None:
    """清除构建产物的只读属性后重试当前删除操作。"""
    error = _error[1]
    if not isinstance(error, PermissionError):
        raise error
    os.chmod(path, stat.S_IRWXU)
    function(path)


def remove_build_tree(path: Path) -> None:
    """可靠删除可重建目录，并重试 Windows 的短暂文件占用。"""
    path = Path(path)
    for attempt in range(5):
        if not path.exists():
            return
        try:
            shutil.rmtree(path, onerror=_clear_readonly_and_retry if os.name == "nt" else None)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 4:
                raise
            print(f"build cleanup: Windows held {path}; retrying ({attempt + 2}/5)...", flush=True)
            time.sleep(0.25 * 2 ** attempt)
