"""程序被关掉后，下一条新消息提醒模型别自行接着做旧任务；点 ▶ 续跑和正常对话不提醒。"""

import importlib.util
from pathlib import Path
import sys

import pytest


def load(monkeypatch, name):
    """加载真实插件模块；用不同模块名重新加载，模拟后端重启。"""
    source = (
        Path(__file__).resolve().parents[2] / "plugins/desktop-deliverables/__init__.py"
    )
    spec = importlib.util.spec_from_file_location(
        name, source, submodule_search_locations=[str(source.parent)]
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    """所有记录写在独立测试目录。"""
    home = tmp_path / "home"
    work = tmp_path / "workspace"
    home.mkdir()
    work.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    return load(monkeypatch, "delivery_interrupted_test")


def start(plugin, turn, message="新问题", session="s"):
    """按桌面本机对话开始一轮，返回交给模型的附加说明。"""
    return plugin.before_turn(
        session_id=session,
        turn_id=turn,
        task_id=session,
        platform="desktop",
        user_message=message,
    )["context"]


def test_normal_turns_get_no_note(plugin):
    """上一轮正常结束（含失败、被停止，都会发结束事件），下一轮不提醒。"""
    assert plugin.interrupted.NOTE not in start(plugin, "t1")
    plugin.end_turn(session_id="s", turn_id="t1")
    assert plugin.interrupted.NOTE not in start(plugin, "t2")


def test_new_message_after_crash_gets_note_first(plugin, monkeypatch):
    """上一轮没结束程序就没了：重启后用户发新消息，提醒排在中间文件提醒前面，只提醒一次。"""
    start(plugin, "t1")
    restarted = load(monkeypatch, "delivery_interrupted_restart")
    context = start(restarted, "t2")
    assert context.startswith(restarted.interrupted.NOTE)
    assert ".tmp" in context
    restarted.end_turn(session_id="s", turn_id="t2")
    assert restarted.interrupted.NOTE not in start(restarted, "t3")


def test_continue_note_is_not_warned(plugin):
    """点 ▶ 发出的续跑说明（与 Hermes 自动续跑同一开头）本来就是要接着做，不提醒。"""
    start(plugin, "t1")
    note = plugin.interrupted.CONTINUE_PREFIX + " — the app stopped.]\n\n整理报告"
    assert plugin.interrupted.NOTE not in start(plugin, "t2", message=note)
    multipart = [{"type": "text", "text": note}]
    start(plugin, "t3", message="x")
    assert plugin.interrupted.NOTE not in start(plugin, "t4", message=multipart)


def test_late_end_of_old_turn_keeps_new_turn_open(plugin):
    """迟到的旧轮结束事件不能擦掉新一轮的登记；其他会话互不影响。"""
    start(plugin, "t1")
    plugin.end_turn(session_id="s", turn_id="t1")
    start(plugin, "t2")
    plugin.end_turn(session_id="s", turn_id="t1")
    assert plugin.interrupted.NOTE in start(plugin, "t3")
    assert plugin.interrupted.NOTE not in start(plugin, "o1", session="other")


def test_other_platforms_are_not_tracked(plugin):
    """消息平台不登记，也就不会提醒。"""
    assert (
        plugin.before_turn(
            session_id="s", turn_id="t1", task_id="s", platform="telegram"
        )
        is None
    )
    assert plugin.interrupted.NOTE not in start(plugin, "t2")


def test_broken_state_file_is_ignored(plugin, tmp_path):
    """记录文件损坏时当作没有，不影响对话。"""
    state = tmp_path / "home" / "desktop" / "deliverables-open-turns.json"
    state.parent.mkdir(parents=True)
    state.write_text("{坏", encoding="utf-8")
    assert plugin.interrupted.NOTE not in start(plugin, "t1")
    assert plugin.interrupted.NOTE in start(plugin, "t2")
