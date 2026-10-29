"""每轮路径提醒：Windows 本机终端总提醒别用 /tmp；终端 cd 走了才点明它此刻在哪。"""

import importlib

import pytest

from tests.plugins.test_uniwork_kits_plugin import kits  # noqa: F401 - fixture


@pytest.fixture
def hints(kits, monkeypatch):
    """按插件系统的方式导入 terminal_hints，并假装在 Windows 上。"""
    module = importlib.import_module("hermes_plugins.uniwork_kits.terminal_hints")
    monkeypatch.setattr(module.os, "name", "nt")
    return module


def place(hints, monkeypatch, cwd, workspace):
    """让钩子读到给定的终端目录和工作目录。"""
    monkeypatch.setattr(hints.script_python, "_local_cwd", lambda task_id: cwd)
    monkeypatch.setattr(hints, "_workspace", lambda task_id: workspace)


def test_terminal_in_the_workspace_only_gets_the_tmp_rule(hints, monkeypatch, tmp_path):
    """终端还在工作目录（写法不同也算同一个）时只提醒 /tmp。"""
    place(hints, monkeypatch, str(tmp_path) + "\\", str(tmp_path).upper())
    text = hints.on_pre_llm_call(task_id="t")["context"]
    assert "不要用 /tmp" in text and ".tmp 的绝对路径" in text
    assert "终端此刻停在" not in text


def test_terminal_that_moved_is_named(hints, monkeypatch, tmp_path):
    """终端 cd 进 .tmp 后，提醒里写出它此刻所在目录和工作目录。"""
    scratch = tmp_path / ".tmp"
    place(hints, monkeypatch, str(scratch), str(tmp_path))
    text = hints.on_pre_llm_call(task_id="t")["context"]
    assert f"终端此刻停在 {scratch}" in text and f"不是工作目录 {tmp_path}" in text
    assert "不要再 cd 进已经所在的目录" in text


def test_no_workspace_still_gets_the_tmp_rule(hints, monkeypatch, tmp_path):
    """没登记工作目录时照样提醒 /tmp，不提终端位置。"""
    place(hints, monkeypatch, str(tmp_path), None)
    text = hints.on_pre_llm_call(task_id="t")["context"]
    assert "不要用 /tmp" in text and "终端此刻停在" not in text


def test_nothing_off_windows_or_off_the_local_terminal(hints, monkeypatch, tmp_path):
    """终端不在本机（Docker、SSH）或不是 Windows 时不加提醒。"""
    place(hints, monkeypatch, None, str(tmp_path))
    assert hints.on_pre_llm_call(task_id="t") is None
    place(hints, monkeypatch, str(tmp_path), str(tmp_path))
    monkeypatch.setattr(hints.os, "name", "posix")
    assert hints.on_pre_llm_call(task_id="t") is None


def test_errors_never_break_the_turn(hints, monkeypatch):
    """读终端目录出错时只跳过这轮提醒。"""
    def broken(task_id):
        """终端状态读不出来。"""
        raise RuntimeError("boom")

    monkeypatch.setattr(hints.script_python, "_local_cwd", broken)
    assert hints.on_pre_llm_call(task_id="t") is None


def test_the_plugin_registers_the_hook(kits, monkeypatch):
    """插件加载时把路径提醒挂到 pre_llm_call 上。"""
    hooks = []
    ctx = type("Ctx", (), {
        "register_cli_command": lambda self, *a, **k: None,
        "register_system_prompt_section": lambda self, *a, **k: None,
        "register_hook": lambda self, name, fn: hooks.append((name, fn)),
    })()
    monkeypatch.setattr(kits.root.terminal_env, "setup", lambda home: None)
    kits.root.register(ctx)
    module = importlib.import_module("hermes_plugins.uniwork_kits.terminal_hints")
    assert ("pre_llm_call", module.on_pre_llm_call) in hooks
