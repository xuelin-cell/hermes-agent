"""回复结束时的有界目录观察，不认领并发会话或失败后台任务。"""

import importlib.util
from pathlib import Path
import sys
from threading import Event, Thread

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


@pytest.mark.parametrize("tool", ["read_file", "web_search", "terminal"])
def test_only_failed_writers_disable_final_scan(delivery, tool):
    """读文件或搜索失败不影响本轮新产物，可能写文件的失败命令仍关闭猜测。"""
    plugin, work = delivery
    begin(plugin)
    output = work / "finished.pdf"
    output.write_bytes(b"pdf")
    plugin.after_tool(
        tool_name=tool, result={"error": "missing"}, session_id="s", turn_id="t"
    )
    result = finish(plugin)
    assert (result is None) if tool == "terminal" else (str(output) in result)


def test_first_command_reuses_new_root_baseline(delivery, tmp_path, monkeypatch):
    """首次命令的新目录只扫一遍，快照不能持有阻塞其他会话的全局锁。"""
    plugin, _ = delivery
    begin(plugin)
    root = tmp_path / "command"
    root.mkdir()
    calls = []
    original = plugin.snapshot

    def observe(directory, budget=None):
        """记录实际快照次数和执行时的锁归属。"""
        calls.append((directory, plugin._lock._is_owned()))
        return original(directory, budget)

    monkeypatch.setattr(plugin, "snapshot", observe)
    plugin.before_tool(
        tool_name="terminal",
        args={"workdir": str(root)},
        session_id="s",
        turn_id="t",
        tool_call_id="a",
    )
    assert calls == [(root, False)]


@pytest.mark.parametrize("phase", ["begin", "before", "after", "final"])
def test_scan_permission_failure_cannot_claim_files_and_releases_state(
    delivery, monkeypatch, phase
):
    """真实扫描遇到不可读条目时放弃差异，命令窗口与结束轮次都必须收尾。"""
    plugin, work = delivery
    from fallback_delivery import paths

    blocked = work / "blocked"
    blocked.mkdir()
    old = blocked / "existing.pdf"
    old.write_bytes(b"old")
    original = paths.os.lstat

    def denied(path, *args, **kwargs):
        """仅注入文件系统拒绝访问，其余快照和钩子均实际执行。"""
        if Path(path) == blocked:
            raise PermissionError("controlled access denied")
        return original(path, *args, **kwargs)

    if phase != "begin":
        begin(plugin)
    if phase in {"after", "final"}:
        plugin.before_tool(
            tool_name="terminal", session_id="s", turn_id="t", tool_call_id="cmd"
        )
    with monkeypatch.context() as fault:
        fault.setattr(paths.os, "lstat", denied)
        if phase == "begin":
            begin(plugin)
        elif phase == "before":
            plugin.before_tool(
                tool_name="terminal", session_id="s", turn_id="t", tool_call_id="cmd"
            )
        elif phase == "after":
            plugin.after_tool(
                tool_name="terminal",
                result={},
                session_id="s",
                turn_id="t",
                tool_call_id="cmd",
            )
        else:
            assert finish(plugin) is None
    if phase == "before":
        plugin.after_tool(
            tool_name="terminal",
            result={},
            session_id="s",
            turn_id="t",
            tool_call_id="cmd",
        )
    if phase in {"before", "after"}:
        assert not plugin._turns[plugin.scope("s")].pending
    assert finish(plugin) is None
    assert not plugin._turns
    begin(plugin)
    fresh = work / "next-turn.pdf"
    fresh.write_bytes(b"new")
    assert str(fresh) in finish(plugin)


@pytest.mark.parametrize("b_starts_first", [True, False])
def test_fifth_execution_directory_still_invalidates_other_session(
    delivery, tmp_path, monkeypatch, b_starts_first
):
    """扫描上限不能截断归属登记，第五个工作目录的并发也不能互认文件。"""
    plugin, work = delivery
    begin(plugin, "a")
    roots = [tmp_path / f"extra-{index}" for index in range(4)]
    for index, root in enumerate(roots):
        root.mkdir()
        if index == 3 and b_starts_first:
            monkeypatch.setenv("TERMINAL_CWD", str(root))
            begin(plugin, "b")
        plugin.before_tool(
            tool_name="terminal",
            args={"workdir": str(root)},
            session_id="a",
            turn_id="t",
            tool_call_id=str(index),
        )
        if index == 3:
            if not b_starts_first:
                monkeypatch.setenv("TERMINAL_CWD", str(root))
                begin(plugin, "b")
            (root / "belongs-to-a.pdf").write_bytes(b"A")
        plugin.after_tool(
            tool_name="terminal",
            result={},
            session_id="a",
            turn_id="t",
            tool_call_id=str(index),
        )
    assert finish(plugin, "b") is None
    assert finish(plugin, "a") is None


def test_final_response_does_not_register_unobserved_cwd(
    delivery, tmp_path, monkeypatch
):
    """回复结束时仅处理已有基线，不因临时 cwd 变化废掉其他会话的观察。"""
    plugin, work = delivery
    begin(plugin, "a")
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setenv("TERMINAL_CWD", str(other))
    begin(plugin, "b")
    assert finish(plugin, "a") is None
    output = other / "belongs-to-b.pdf"
    output.write_bytes(b"B")
    assert str(output) in finish(plugin, "b")


@pytest.mark.parametrize("operation", ["named_paths", "fresh"])
def test_candidate_io_does_not_block_other_turn_and_late_results_are_discarded(
    delivery, monkeypatch, operation
):
    """路径读取阻塞时其他会话仍可收尾，取消后的旧结果不能重新写入。"""
    plugin, work = delivery
    begin(plugin, "a")
    entered, release, done = Event(), Event(), Event()
    errors = []
    original = getattr(plugin, operation)
    output = work / "candidate.pdf"
    output.write_bytes(b"pdf")

    def delayed(*args):
        """暂停真实候选解析以观察状态锁是否被文件 I/O 占用。"""
        entered.set()
        assert release.wait(10)
        return original(*args)

    def finish_tool():
        """收集后台钩子异常，避免测试线程失败被忽略。"""
        try:
            plugin.after_tool(
                tool_name="terminal",
                result={"output": str(output)},
                session_id="a",
                turn_id="t",
                tool_call_id="a",
            )
        except BaseException as error:
            errors.append(error)

    def cancel_turn():
        """在候选解析尚未完成时走正式结束钩子。"""
        plugin.end_turn(session_id="a")
        done.set()

    plugin.before_tool(
        tool_name="terminal", session_id="a", turn_id="t", tool_call_id="a"
    )
    monkeypatch.setattr(plugin, operation, delayed)
    a, b = Thread(target=finish_tool), Thread(target=cancel_turn)
    a.start()
    try:
        assert entered.wait(10)
        b.start()
        assert done.wait(3), "候选文件 I/O 占用了状态锁"
    finally:
        release.set()
        a.join(10)
        if b.ident is not None:
            b.join(10)
    assert not a.is_alive() and not b.is_alive() and not errors
    assert not plugin._turns


@pytest.mark.parametrize("phase", ["begin", "before", "after", "final"])
def test_interleaved_scan_cannot_claim_other_session(delivery, monkeypatch, phase):
    """另一会话在锁外扫描期间完整执行并结束，也不能把其文件算给当前会话。"""
    plugin, work = delivery
    if phase != "begin":
        begin(plugin, "a")
    if phase == "after":
        plugin.before_tool(
            tool_name="terminal", session_id="a", turn_id="t", tool_call_id="a"
        )
    scanning, release, completed = Event(), Event(), Event()
    original = plugin.snapshot
    errors = []

    def delayed(directory, budget=None):
        """只暂停 A 的第一次真实扫描，为另一个会话留出完整执行窗口。"""
        if not scanning.is_set():
            scanning.set()
            assert release.wait(10)
        return original(directory, budget)

    def scan_a():
        """执行被测钩子并收集线程异常，不能把线程崩溃当成通过。"""
        try:
            if phase == "begin":
                begin(plugin, "a")
            elif phase == "before":
                plugin.before_tool(
                    tool_name="terminal", session_id="a", turn_id="t", tool_call_id="a"
                )
            elif phase == "after":
                plugin.after_tool(
                    tool_name="terminal",
                    result={},
                    session_id="a",
                    turn_id="t",
                    tool_call_id="a",
                )
            else:
                assert finish(plugin, "a") is None
        except BaseException as error:
            errors.append(error)

    def execute_b():
        """真实经过另一轮的命令前后钩子，结束后也要留下歧义证据。"""
        try:
            begin(plugin, "b")
            plugin.before_tool(
                tool_name="terminal", session_id="b", turn_id="t", tool_call_id="b"
            )
            (work / "belongs-to-b.pdf").write_bytes(b"other")
            plugin.after_tool(
                tool_name="terminal",
                result={},
                session_id="b",
                turn_id="t",
                tool_call_id="b",
            )
            assert finish(plugin, "b") is None
        except BaseException as error:
            errors.append(error)
        finally:
            completed.set()

    monkeypatch.setattr(plugin, "snapshot", delayed)
    a, b = Thread(target=scan_a), Thread(target=execute_b)
    a.start()
    try:
        assert scanning.wait(10)
        b.start()
        assert completed.wait(3), "扫描期间其他会话被全局锁阻塞"
    finally:
        release.set()
        a.join(10)
        if b.ident is not None:
            b.join(10)
    assert not a.is_alive() and not b.is_alive() and not errors
    if phase == "before":
        plugin.after_tool(
            tool_name="terminal",
            result={},
            session_id="a",
            turn_id="t",
            tool_call_id="a",
        )
    assert finish(plugin, "a") is None
