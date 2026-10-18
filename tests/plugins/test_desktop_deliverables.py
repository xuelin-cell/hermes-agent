"""本机交付物插件的路径证据、工具前后差异及账号会话边界。"""

import importlib.util
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import pytest


@pytest.fixture
def delivery(tmp_path, monkeypatch):
    """加载真实插件模块，所有文件与终端目录均位于独立测试目录。"""
    home = tmp_path / "home"
    work = tmp_path / "workspace"
    home.mkdir()
    work.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    source = (
        Path(__file__).resolve().parents[2] / "plugins/desktop-deliverables/__init__.py"
    )
    spec = importlib.util.spec_from_file_location(
        "delivery_test", source, submodule_search_locations=[str(source.parent)]
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module, work


def begin(plugin, session="s", turn="t", **kwargs):
    """按正式桌面对话建立本轮，不从 Renderer 传入账号目录。"""
    plugin.before_turn(
        session_id=session, turn_id=turn, task_id=session, platform="desktop", **kwargs
    )


def reply(plugin, text="完成了。", session="s", turn="t"):
    """按正式输出钩子取得最终回复，空值表示原文保持不动。"""
    return plugin.transform(
        response_text=text, session_id=session, turn_id=turn, platform="desktop"
    )


@pytest.mark.parametrize("tool", ["write_file", "patch"])
def test_written_path_is_carded_even_when_reply_names_nothing(delivery, tool):
    """直接写文件证据不依赖模型声明交付，文档压过同轮图片素材。"""
    plugin, work = delivery
    begin(plugin)
    output = work / "报告 with space.docx"
    output.write_bytes(b"document")
    picture = work / "chart.png"
    picture.write_bytes(b"picture")
    for file in (picture, output):
        plugin.after_tool(
            tool_name=tool,
            args={"path": str(file)},
            result="{}",
            status="ok",
            session_id="s",
            turn_id="t",
        )
    result = reply(plugin)
    assert f"MEDIA:`{output}`" in result
    assert str(picture) not in result
    assert reply(plugin) is None


@pytest.mark.parametrize("tool", ["terminal", "execute_code"])
def test_execution_delta_finds_files_without_any_named_path(delivery, tool):
    """真实文件快照对比能找出正文和工具结果均未提到的本轮产物。"""
    plugin, work = delivery
    (work / "unchanged.md").write_text("old")
    begin(plugin)
    plugin.before_tool(
        tool_name=tool, args={}, session_id="s", turn_id="t", tool_call_id="call"
    )
    output = work / "new.pdf"
    output.write_bytes(b"pdf")
    plugin.after_tool(
        tool_name=tool,
        args={},
        result='{"exit_code":0}',
        status="ok",
        session_id="s",
        turn_id="t",
        tool_call_id="call",
    )
    assert str(output) in reply(plugin)


def test_reply_paths_and_tool_results_deduplicate_and_limit_cards(delivery):
    """合并路径证据，合法 MEDIA 修正后只保留一张，文件按优先级截断。"""
    plugin, work = delivery
    begin(plugin)
    files = [work / f"report-{index}.md" for index in range(10)]
    for file in files:
        file.write_text("report")
    plugin.after_tool(
        tool_name="custom_tool",
        args={},
        result={"output": "\n".join(str(file) for file in files)},
        status="ok",
        session_id="s",
        turn_id="t",
    )
    path = str(files[0])
    malformed = "/" + path if os.name == "nt" else path
    result = reply(plugin, f"报告位于 `{path}`。\n\nMEDIA:{malformed}")
    assert result.count("MEDIA:") == 8
    assert result.count(f"MEDIA:{path}") == 1
    assert f"MEDIA:{malformed}" not in result if malformed != path else True


def test_filters_uploads_hidden_empty_assets_and_failed_tools(delivery):
    """不把附件、素材、隐藏文件、空文件或失败工具的路径补成交付物。"""
    plugin, work = delivery
    uploaded = work / "uploaded.pdf"
    uploaded.write_bytes(b"upload")
    begin(plugin, user_message=f"[User attached file: {uploaded}]")
    paths = [
        uploaded,
        work / ".hidden.md",
        work / "empty.pdf",
        work / "themes/asset.png",
        work / "bad.tmp",
    ]
    for file in paths[1:]:
        file.parent.mkdir(exist_ok=True)
        file.write_bytes(b"" if file.name == "empty.pdf" else b"ignore")
    text = "\n".join(f"`{file}`" for file in paths)
    assert reply(plugin, text) is None
    begin(plugin, turn="second")
    failed = work / "failed.pdf"
    failed.write_bytes(b"partial")
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(failed)},
        result={"error": "denied"},
        status="error",
        session_id="s",
        turn_id="second",
    )
    assert reply(plugin, turn="second") is None


def test_profile_turn_and_remote_boundaries(delivery, tmp_path, monkeypatch):
    """相同会话标识在不同账号中互不串用，旧轮迟到结果与远程模式均不观察。"""
    plugin, work = delivery
    original = os.environ["HERMES_HOME"]
    begin(plugin)
    output = work / "A.pdf"
    output.write_bytes(b"a")
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(output)},
        status="ok",
        session_id="s",
        turn_id="t",
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "B"))
    begin(plugin)
    assert reply(plugin) is None
    monkeypatch.setenv("HERMES_HOME", original)
    assert str(output) in reply(plugin)
    begin(plugin, turn="new")
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(output)},
        status="ok",
        session_id="s",
        turn_id="t",
    )
    assert reply(plugin, turn="new") is None
    monkeypatch.setenv("TERMINAL_ENV", "docker")
    begin(plugin)
    assert reply(plugin, str(output)) is None


def test_overlapping_commands_do_not_claim_each_others_files(delivery):
    """同一目录的命令观察窗口重叠时不以快照差异认领其它会话产物。"""
    plugin, work = delivery
    for session in ("a", "b"):
        begin(plugin, session=session)
        plugin.before_tool(
            tool_name="terminal", session_id=session, turn_id="t", tool_call_id=session
        )
    (work / "ambiguous.md").write_text("unknown owner")
    for session in ("a", "b"):
        plugin.after_tool(
            tool_name="terminal",
            result='{"exit_code":0}',
            status="ok",
            session_id=session,
            turn_id="t",
            tool_call_id=session,
        )
        assert reply(plugin, session=session) is None


def test_media_outside_workspace_and_table_names(delivery, tmp_path):
    """直接 MEDIA、中文空格路径和目录表格都沿用同一识别流程，不要求工具先报过路径。"""
    plugin, work = delivery
    out = tmp_path / "独立目录"
    out.mkdir()
    output = out / "中文 报告.docx"
    output.write_bytes(b"docx")
    begin(plugin)
    supplied = f"MEDIA:`{'/' if os.name == 'nt' else ''}{output}`"
    result = reply(plugin, supplied)
    assert (result or supplied) == f"MEDIA:`{output}`"
    begin(plugin, turn="next")
    second = out / "table.xlsx"
    second.write_bytes(b"table")
    result = reply(plugin, f"交付目录 `{out}`\n| table.xlsx | 模型 |", turn="next")
    assert f"MEDIA:{second}" in result


def test_stale_files_and_snapshot_budgets(delivery, monkeypatch):
    """旧文件不补卡；目录过大、层级太深或耗时超限时不拿不完整快照认领产物。"""
    plugin, work = delivery
    future = time.time() + 30
    monkeypatch.setattr(plugin, "time", SimpleNamespace(time=lambda: future))
    begin(plugin)
    output = work / "old.pdf"
    output.write_bytes(b"old")
    assert reply(plugin, str(output)) is None
    from delivery_test import paths

    deep = work / "one/two/three/four"
    deep.mkdir(parents=True)
    (deep / "deep.md").write_text("deep")
    assert deep / "deep.md" not in paths.snapshot(work)
    tick = iter([0, 0.6])
    monkeypatch.setattr(paths, "time", SimpleNamespace(monotonic=lambda: next(tick)))
    assert paths.snapshot(work) is None


def test_terminal_workdir_is_observed_instead_of_default_workspace(delivery, tmp_path):
    """终端本次指定目录时在真实执行位置比较，不能只盯着默认工作区。"""
    plugin, work = delivery
    other = tmp_path / "command-directory"
    other.mkdir()
    begin(plugin)
    args = {"workdir": str(other)}
    plugin.before_tool(
        tool_name="terminal", args=args, session_id="s", turn_id="t", tool_call_id="cd"
    )
    output = other / "actual.md"
    output.write_text("new")
    plugin.after_tool(
        tool_name="terminal",
        args=args,
        result='{"exit_code":0}',
        status="ok",
        session_id="s",
        turn_id="t",
        tool_call_id="cd",
    )
    assert str(output) in reply(plugin)
