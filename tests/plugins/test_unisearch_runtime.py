"""准备动作只覆盖需要本机解析器的Profile，资源选择复用原生解析器。"""

import importlib.metadata
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hermes_constants import (
    get_hermes_home,
    set_hermes_home_override,
    reset_hermes_home_override,
)
from hermes_cli.config import get_config_path, atomic_config_write
from .test_unisearch import SOURCE, load_package


@pytest.mark.parametrize(
    "backend,disabled",
    [("tavily", False), ("unicrawl", False), ("builtin_parse", True)],
)
def test_prepare_does_not_install_dependencies_for_unrelated_providers(
    monkeypatch, backend, disabled
):
    """第三方／远端Provider与禁用插件不触发本机依赖或浏览器准备。"""
    import hermes_bootstrap
    import pm

    home = get_hermes_home()
    home.mkdir(parents=True, exist_ok=True)
    atomic_config_write(
        get_config_path(),
        {
            "web": {"extract_backend": backend},
            "plugins": {"disabled": ["unisearch"] if disabled else []},
        },
    )
    ensure = Mock()
    sync = Mock()
    monkeypatch.setattr(pm, "ensure", ensure)
    monkeypatch.setattr(pm, "sync_venv", sync)
    monkeypatch.setattr(sys, "argv", [str(SOURCE / "prepare.py"), str(home)])
    runpy.run_path(str(SOURCE / "prepare.py"), run_name="__main__")
    ensure.assert_not_called()
    sync.assert_not_called()


def test_prepare_builtin_uses_declared_pm_candidates(monkeypatch):
    """本机抓取缺依赖时使用PM候选声明，浏览器仍由PM准备。"""
    import hermes_bootstrap
    import pm

    home = get_hermes_home()
    home.mkdir(parents=True, exist_ok=True)
    atomic_config_write(
        get_config_path(), {"web": {"extract_backend": "builtin_parse"}}
    )
    ensure = Mock()
    sync = Mock()
    monkeypatch.setattr(pm, "ensure", ensure)
    monkeypatch.setattr(pm, "sync_venv", sync)

    # 只模拟缺包事实，依赖声明与PM调用参数均执行真实路径。
    def missing(name):
        """强制准备分支，避免测试依赖当前机器是否恰好装齐。"""
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(importlib.metadata, "version", missing)
    monkeypatch.setattr(sys, "argv", [str(SOURCE / "prepare.py"), str(home)])
    runpy.run_path(str(SOURCE / "prepare.py"), run_name="__main__")
    ensure.assert_called_once_with("chromium")
    assert sync.call_args.kwargs["explicit"] is True
    assert SOURCE in sync.call_args.kwargs["plugins"].dirs


def test_native_chromium_resolver_keeps_a_b_a_profile_scope(monkeypatch, tmp_path):
    """两Profile往返通过原生资源入口读取各自选择，不缓存首个账号的路径。"""
    load_package()
    from unisearch_test_plugin.fetch.builtin.browser import _find_chromium_executable
    import pm

    paths = {}
    for name in ["a", "b"]:
        home = tmp_path / name
        home.mkdir()
        executable = home / "chromium"
        executable.write_text("fixture", encoding="utf-8")
        paths[home] = executable
    monkeypatch.delenv("AGENT_BROWSER_EXECUTABLE_PATH", raising=False)
    monkeypatch.setattr(
        pm,
        "installed_package",
        lambda name: SimpleNamespace(binary=paths[get_hermes_home()]),
    )
    actual = []
    for name in ["a", "b", "a"]:
        home = tmp_path / name
        token = set_hermes_home_override(home)
        try:
            actual.append(_find_chromium_executable())
        finally:
            reset_hermes_home_override(token)
    assert actual == [str(paths[tmp_path / name]) for name in ["a", "b", "a"]]
