"""企业对接插件（deploy/hermes-mt/plugin）的测试夹具。

插件跑在 hermes 进程里，测试要 hermes 本体，用仓库的 .venv 跑（和沙箱镜像同一个 Python 版本）：

    .venv\\Scripts\\python.exe -m pytest tests/hermes_mt_plugin -q -p no:cacheprovider

tests/hermes_mt 用系统 Python 跑入口那一侧（它的 conftest 要 asyncpg，.venv 里没有），所以分开放。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from .support import write_settings, write_token


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """一个实例主目录：plugin.json 开着，.env 里有设备令牌。"""
    home = tmp_path / "opt-data"
    home.mkdir()
    write_settings(home)
    write_token(home, "tok-1")
    return home
