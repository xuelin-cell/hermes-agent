"""回复结束时的有界目录观察，不认领并发会话或失败后台任务。"""

import importlib.util
from pathlib import Path
import sys

import pytest


@pytest.fixture
def delivery(tmp_path, monkeypatch):
    """真实加载插件，将 Home、工作区和系统目录全部放进隔离目录。"""
    home, work = tmp_path / "home", tmp_path / "work"
    home.mkdir()
    work.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    source = (
        Path(__file__).resolve().parents[2] / "plugins/desktop-deliverables/__init__.py"
    )
    spec = importlib.util.spec_from_file_location(
        "fallback_delivery", source, submodule_search_locations=[str(source.parent)]
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module, work


def begin(plugin, session="s", **kwargs):
    """建立真实桌面轮次，按会话保存观察根目录。"""
    plugin.before_turn(
        session_id=session, turn_id="t", task_id=session, platform="desktop", **kwargs
    )


def finish(plugin, session="s"):
    """结束语不提供任何文件名，必须依赖程序观察。"""
    return plugin.transform(
        session_id=session, turn_id="t", platform="desktop", response_text="完成了。"
    )


def test_fallback_only_cards_changed_files_in_requested_roots(delivery, tmp_path):
    """无路径工具能补卡，但不带入刚存在的旧文件、附件或未指定目录。"""
    plugin, work = delivery
    requested, other = tmp_path / "交付 目录", tmp_path / "other"
    requested.mkdir()
    other.mkdir()
    old = work / "old.md"
    old.write_text("old")
    upload = requested / "upload.pdf"
    begin(plugin, user_message=f"保存到 `{requested}`。[User attached file: {upload}]")
    output = requested / "new.pdf"
    output.write_bytes(b"new")
    upload.write_bytes(b"input")
    unrelated = other / "unrelated.pdf"
    unrelated.write_bytes(b"other")
    result = finish(plugin)
    assert str(output) in result
    assert all(str(path) not in result for path in (old, upload, unrelated))


def test_known_folder_alias_uses_actual_folder(delivery, tmp_path, monkeypatch):
    """桌面等名称按系统目录解析，绝不能猜成账号 Home 下的同名文件夹。"""
    plugin, work = delivery
    desktop = tmp_path / "redirected-desktop"
    desktop.mkdir()
    from fallback_delivery import paths

    monkeypatch.setattr(paths, "known_folders", lambda: {"Desktop": desktop})
    begin(plugin, user_message="请生成报告并保存到桌面")
    output = desktop / "report.pdf"
    output.write_bytes(b"report")
    assert str(output) in finish(plugin)


def test_general_desktop_wording_does_not_select_personal_folders(
    delivery, monkeypatch
):
    """只谈桌面应用、下载机制或文档内容，不等于要求扫描系统个人目录。"""
    plugin, work = delivery
    from fallback_delivery import paths

    seen = []
    monkeypatch.setattr(paths, "known_folders", lambda: seen.append(True) or {})
    assert paths.requested_roots("分析桌面应用的下载机制和文档", work) == [work]
    assert not seen


def test_overlapping_roots_stay_ambiguous_after_other_turn_finishes(
    delivery, tmp_path, monkeypatch
):
    """包含关系也算同目录并发，不能等另一会话结束后再认领它的产物。"""
    plugin, work = delivery
    nested = work / "nested"
    nested.mkdir()
    begin(plugin, "a")
    monkeypatch.setenv("TERMINAL_CWD", str(nested))
    begin(plugin, "b")
    output = nested / "unknown.md"
    output.write_text("owner unknown")
    assert finish(plugin, "b") is None
    assert finish(plugin, "a") is None
    # 结束后新轮在独立目录照常观察，不能永久锁死扫描。
    begin(plugin, "c")
    second = nested / "mine.md"
    second.write_text("mine")
    assert str(second) in finish(plugin, "c")


@pytest.mark.parametrize(
    "result,args",
    [
        ({"error": "failed"}, {}),
        ({"status": "running"}, {}),
        ({}, {"background": True}),
    ],
)
def test_failed_or_background_work_does_not_reappear_via_fallback(
    delivery, result, args
):
    """失败和后台的半成品不能绕过工具过滤，被结束扫描重新补成卡片。"""
    plugin, work = delivery
    begin(plugin)
    (work / "partial.pdf").write_bytes(b"partial")
    plugin.after_tool(
        tool_name="terminal", args=args, result=result, session_id="s", turn_id="t"
    )
    assert finish(plugin) is None


def test_oversized_tree_is_not_partially_claimed(delivery):
    """超过三千项不根据不完整扫描补卡，明确写文件证据仍然有效。"""
    plugin, work = delivery
    for index in range(3001):
        (work / f"ignored-{index}.txt").touch()
    begin(plugin)
    output = work / "confirmed.pdf"
    output.write_bytes(b"pdf")
    assert finish(plugin) is None
    begin(plugin)
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(output)},
        result="{}",
        session_id="s",
        turn_id="t",
    )
    assert str(output) in finish(plugin)


def test_other_turn_start_invalidates_an_open_command_snapshot(delivery):
    """另一会话在命令窗口中才开始，也不能从命令差异偷认其文件。"""
    plugin, work = delivery
    begin(plugin, "a")
    plugin.before_tool(
        tool_name="terminal", session_id="a", turn_id="t", tool_call_id="a"
    )
    begin(plugin, "b")
    (work / "belongs-to-b.pdf").write_bytes(b"other")
    plugin.after_tool(
        tool_name="terminal",
        result='{"exit_code":0}',
        session_id="a",
        turn_id="t",
        tool_call_id="a",
    )
    assert finish(plugin, "a") is None


def test_requested_directory_can_be_created_during_the_turn(delivery, tmp_path):
    """用户明示的新目录尚不存在时，不能因为起始扫描为空就丢掉后续产物。"""
    plugin, work = delivery
    requested = tmp_path / "新建交付目录"
    begin(plugin, user_message=f"保存到 `{requested}`")
    requested.mkdir()
    output = requested / "report.pdf"
    output.write_bytes(b"new")
    assert str(output) in finish(plugin)
