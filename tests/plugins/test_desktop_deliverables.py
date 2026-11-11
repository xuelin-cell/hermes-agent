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


@pytest.mark.parametrize("failed", [False, True])
def test_cron_local_outputs_use_existing_preview_delivery(delivery, failed):
    """定时任务复用本轮文件观察；旧文件、临时素材与失败命令不补卡。"""
    plugin, work = delivery
    old = work / "old.png"
    old.write_bytes(b"old")
    context = plugin.before_turn(session_id="cron_s", turn_id="t", task_id="cron_s", platform="cron")
    assert context and "MEDIA:" in context["context"]
    plugin.before_tool(tool_name="terminal", session_id="cron_s", turn_id="t", tool_call_id="write")
    output = work / "狗狗图片_20261109.png"
    output.write_bytes(b"new")
    scratch = work / ".tmp" / "draft.png"
    scratch.parent.mkdir()
    scratch.write_bytes(b"scratch")
    plugin.after_tool(
        tool_name="terminal", session_id="cron_s", turn_id="t", tool_call_id="write",
        result={"exit_code": 1 if failed else 0},
    )
    result = plugin.transform(response_text="完成了。", session_id="cron_s", turn_id="t", platform="cron")
    if failed:
        assert result is None
    else:
        assert result.count("MEDIA:") == 1
        assert f"MEDIA:{output}" in result
        assert str(old) not in result and str(scratch) not in result
    assert plugin.transform(response_text="完成了。", session_id="cron_s", turn_id="t", platform="cron") is None


def test_cron_remote_terminal_does_not_scan_host_files(delivery, monkeypatch):
    """远程定时任务不沿本机目录生成交付引用。"""
    plugin, work = delivery
    monkeypatch.setenv("TERMINAL_ENV", "docker")
    assert plugin.before_turn(session_id="cron_s", turn_id="t", task_id="cron_s", platform="cron") is None
    (work / "unrelated.png").write_bytes(b"other")
    assert plugin.transform(response_text="完成了。", session_id="cron_s", turn_id="t", platform="cron") is None


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


def test_asset_folder_names_only_count_inside_the_working_directory(
    delivery, tmp_path, monkeypatch
):
    """工作目录本身或上级叫 templates、assets 或以点开头时照常出卡；目录里面的素材仍排除。"""
    plugin, _ = delivery
    work = tmp_path / "assets" / ".projects" / "templates"
    (work / "scripts").mkdir(parents=True)
    monkeypatch.setenv("TERMINAL_CWD", str(work))
    begin(plugin)
    output = work / "报告.docx"
    asset = work / "scripts" / "chart.png"
    outside = tmp_path / "assets" / "other.pdf"
    for file in (output, asset, outside):
        file.write_bytes(b"data")
    text = "\n".join(f"`{file}`" for file in (output, asset, outside))
    result = reply(plugin, text)
    assert f"MEDIA:{output}" in result
    assert f"MEDIA:{asset}" not in result
    assert f"MEDIA:{outside}" not in result
    # 命令前后的快照对比同样只看工作目录里面的目录名。
    begin(plugin, turn="second")
    plugin.before_tool(
        tool_name="terminal",
        args={},
        session_id="s",
        turn_id="second",
        tool_call_id="c",
    )
    made = work / "new.pdf"
    made.write_bytes(b"pdf")
    plugin.after_tool(
        tool_name="terminal",
        args={},
        result='{"exit_code":0}',
        status="ok",
        session_id="s",
        turn_id="second",
        tool_call_id="c",
    )
    assert f"MEDIA:{made}" in reply(plugin, turn="second")


def test_profile_turn_and_remote_boundaries(delivery, tmp_path, monkeypatch):
    """相同会话标识在不同账号中互不串用，旧轮迟到结果与远程模式均不观察。"""
    plugin, work = delivery
    original = os.environ["HERMES_HOME"]
    begin(plugin)
    plugin.background.remember_child(parent_session_id='s', child_session_id='child')
    assert plugin.background.child_root('child') == work
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
    assert plugin.background.child_root('child') is None
    begin(plugin)
    assert reply(plugin) is None
    monkeypatch.setenv("HERMES_HOME", original)
    assert plugin.background.child_root('child') == work
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


def test_message_child_ownership_follows_multiplex_profile_without_scanning_messages(delivery, tmp_path):
    """真实 A→B→A 运行域隔离消息子任务，同名会话不串文件，也不登记普通消息的扫描。"""
    import json
    from agent.secret_scope import set_multiplex_active
    from gateway.run import _profile_runtime_scope

    plugin, _ = delivery
    homes = [tmp_path / "account-a", tmp_path / "account-b"]
    for home in homes:
        home.mkdir()
        (home / "config.yaml").write_text(json.dumps({"terminal": {"env_type": "local", "cwd": str(home)}}))
    set_multiplex_active(True)
    try:
        for home in homes:
            with _profile_runtime_scope(home, {}):
                assert plugin.background.child_root("child") is None
                plugin.background.remember_message_parent(session_id="parent", task_id="parent", platform="weixin")
                assert plugin.scope("parent") not in plugin._turns
                plugin.background.remember_child(parent_session_id="parent", child_session_id="child")
                assert plugin.background.child_root("child") == home
                assert plugin.background.child_origin("child")[1] == "weixin"
                plugin.before_turn(session_id="child", turn_id="t", platform="subagent")
                plugin.background.remember_child(parent_session_id="child", child_session_id="nested")
                assert plugin.background.child_root("nested") is None
        with _profile_runtime_scope(homes[0], {}):
            assert plugin.background.child_root("child") == homes[0]
            plugin.end_turn(session_id="parent")
            plugin.background.remember_child(parent_session_id="parent", child_session_id="later")
            assert plugin.background.child_root("later") is None
            # 父轮结束不撤销已经启动的后台子任务。
            assert plugin.background.child_root("child") == homes[0]
    finally:
        set_multiplex_active(False)


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
    monkeypatch.setattr(plugin.time, "time", lambda: future)
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


@pytest.mark.parametrize(
    "form",
    [
        "forward",
        "mixed",
        "relative",
        "inline",
        "double",
        "single",
        "code",
        "quote",
        "quoted",
    ],
)
def test_shown_file_is_not_appended_again(delivery, form):
    """真实回复中的 MEDIA 链接、行内标记和预览指令只保留一个展示位置。"""
    plugin, work = delivery
    begin(plugin)
    output = work / "kitten.png"
    output.write_bytes(b"image")
    target = "/" + str(output) if os.name == "nt" else str(output)
    forms = {
        "forward": f"![小狗](MEDIA:{target.replace(chr(92), '/')})",
        "mixed": f"![小狗](MEDIA:{target})",
        "relative": "[小狗](MEDIA:kitten.png)",
        "inline": f"请查看 MEDIA:`{output}`，这是成品。",
        "double": f'::preview{{file="{output}"}}',
        "single": f"::preview{{file='{output}'}}",
        # 桌面对行内代码、引用块和引号包着的标记照样出卡；/C:/ 写法原版核对不过。
        "code": f"- 成品：`MEDIA:{target}`",
        "quote": f"> MEDIA:{output}",
        "quoted": f'成品："MEDIA:{output}"',
    }
    original = forms[form] + f"\nMEDIA:{output}\n结束。"
    result = reply(plugin, original) or original
    assert result == forms[form] + "\n结束。"


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
@pytest.mark.parametrize("below", ["", "\n", "\n\n"])
def test_moving_media_only_removes_its_own_line(delivery, newline, below):
    """只收拢被移走 MEDIA 两侧的空行，保留其它正文及代码块原样。"""
    plugin, work = delivery
    begin(plugin)
    output = work / "report.docx"
    output.write_bytes(b"docx")
    prefix = "首段\n\n```text\n\n\n保留代码中的空行\n```\n\n"
    original = (prefix + f"说明\n\nMEDIA:{output}\n{below}尾段").replace("\n", newline)
    expected = (prefix + "说明\n\n尾段").replace("\n", newline)
    assert reply(plugin, original) == expected + f"\n\nMEDIA:{output}"


@pytest.mark.parametrize("emphasis", ["", "*", "**", "***", "_", "__"])
@pytest.mark.parametrize("quoted", [False, True])
def test_standalone_deliveries_finish_after_prose_regardless_of_emphasis(delivery, emphasis, quoted):
    """独立附件统一置底、成品优先，Markdown 强调不能改变排序或重复出卡。"""
    plugin, work = delivery
    begin(plugin)
    output = work / ("课程 成品.pptx" if quoted else "课程.pptx")
    directive = f"MEDIA:`{output}`" if quoted else f"MEDIA:{output}"
    notes = work / "DESIGN.md"
    output.write_bytes(b"deck")
    notes.write_text("design")
    original = (
        f"做好了。\n\n{emphasis}{directive}{emphasis}\n\n"
        f"说明与注意事项。\n\nMEDIA:{notes}\n\n结束。"
    )
    result = reply(plugin, original) or original
    assert result == (
        f"做好了。\n\n说明与注意事项。\n\n结束。\n\n"
        f"{directive}\nMEDIA:{notes}"
    )


@pytest.mark.parametrize(
    "example",
    [
        "```text\nMEDIA:{path}\n```",
        "```text\n见 MEDIA:{path} 示例\n```",
    ],
)
def test_example_is_preserved_but_does_not_suppress_real_delivery(delivery, example):
    """围栏代码里的示例桌面只显示文字，不算已展示，也不能被移走独立行。"""
    plugin, work = delivery
    begin(plugin)
    output = work / "example.pdf"
    output.write_bytes(b"pdf")
    original = example.format(path=output)
    assert reply(plugin, original) == original + f"\n\nMEDIA:{output}"


def test_a_reply_that_mentions_a_pptx_does_not_also_card_the_generated_picture(delivery):
    """回复里已经有 PPT 时，同轮生成图不再发卡。文件名里的中文逗号也不能把图片行留下。"""
    plugin, work = delivery
    begin(plugin)
    picture = work / "outputs" / "现代扁平插画风格，学生宿舍书桌上一台打开的笔.png"
    picture.parent.mkdir()
    picture.write_bytes(b"png")
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(picture)},
        result="{}",
        status="ok",
        session_id="s",
        turn_id="t",
    )
    plugin._turns[plugin.scope("s")].downloads["https://example.test/laptop.png"] = picture
    result = reply(
        plugin,
        f"做好了。\n\nMEDIA:{work / '学生笔记本电脑推荐.pptx'}\n\nMEDIA:{picture}\n\n![]({picture})",
    )
    assert result is not None
    assert "打开的笔.png" not in result
    assert "学生笔记本电脑推荐.pptx" in result


def test_a_deck_picture_under_assets_is_not_carded(delivery):
    """做 PPT 时放进 assets 的配图不出卡，回复里写了路径也去掉；单独要的图仍在 outputs 概念下出卡。"""
    plugin, work = delivery
    begin(plugin, user_message="帮我做一份大约 10 页的 PPT，介绍一下《西游记》。")
    picture = work / "assets" / "generated" / "师徒.png"
    picture.parent.mkdir(parents=True)
    picture.write_bytes(b"png")
    deck = work / "西游记.pptx"
    deck.write_bytes(b"pptx")
    for file in (picture, deck):
        plugin.after_tool(
            tool_name="write_file",
            args={"path": str(file)},
            result="{}",
            status="ok",
            session_id="s",
            turn_id="t",
        )
    result = reply(plugin, f"配图先放这儿。\n\nMEDIA:{picture}")
    assert str(deck) in result
    assert "师徒" not in (result or "")


def test_another_sessions_deck_is_not_carded_in_this_one(delivery):
    """两个会话共用工作区时，目录里列出的别人的 PPT 不进本会话；自己这次写出的那份要进。"""
    plugin, work = delivery
    begin(plugin, session="luxun")
    begin(plugin, session="huawei")
    plugin.before_tool(
        tool_name="terminal", args={}, session_id="huawei", turn_id="t", tool_call_id="h"
    )
    other = work / "华为汽车.pptx"
    other.write_bytes(b"other")
    # 修改时间写明在命令前后各一秒：Windows 记修改时间用粗粒度时钟，紧挨着命令开始写的文件
    # 常比命令开始时刻早一两毫秒，靠毫秒先后判断会时好时坏。真实命令光启动进程就要几十毫秒。
    os.utime(other, (time.time() - 1, time.time() - 1))
    plugin.after_tool(
        tool_name="terminal",
        args={},
        result=str(other),
        status="ok",
        session_id="huawei",
        turn_id="t",
        tool_call_id="h",
    )
    plugin.before_tool(
        tool_name="terminal", args={}, session_id="luxun", turn_id="t", tool_call_id="l"
    )
    own = work / "鲁迅的书.pptx"
    own.write_bytes(b"own")
    os.utime(own, (time.time() + 1, time.time() + 1))
    plugin.after_tool(
        tool_name="terminal",
        args={},
        result=f"{other}\n{own}",
        status="ok",
        session_id="luxun",
        turn_id="t",
        tool_call_id="l",
    )
    result = reply(plugin, "做完了。", session="luxun")
    assert str(own) in result
    assert str(other) not in result


def test_a_deck_turn_does_not_card_its_pictures_even_when_the_pptx_is_withheld(delivery):
    """做 PPT 时生成图和回复里的图片路径都不发卡；没在做 PPT 时，生成图仍然发卡。"""
    plugin, work = delivery
    begin(plugin, user_message="帮我做一份 PPT")
    deck = work / "提案.pptx"
    picture = work / "荷塘.png"
    for file in (deck, picture):
        file.write_bytes(b"deliverable")
        plugin.after_tool(
            tool_name="write_file",
            args={"path": str(file)},
            result="{}",
            status="ok",
            session_id="s",
            turn_id="t",
        )
    plugin._turns[plugin.scope("s")].downloads["https://example.test/a.png"] = picture
    result = reply(plugin, f"配图在这里。\n\nMEDIA:{picture}")
    assert str(deck) in result
    assert str(picture) not in result

    begin(plugin, turn="held", user_message="再做一份幻灯片")
    held = work / "只有图.png"
    held.write_bytes(b"picture")
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(held)},
        result="{}",
        status="ok",
        session_id="s",
        turn_id="held",
    )
    plugin._turns[plugin.scope("s")].downloads["https://example.test/b.png"] = held
    held_reply = reply(plugin, f"MEDIA:{held}", turn="held")
    assert held_reply is None or str(held) not in held_reply

    begin(plugin, turn="poster", user_message="生成一张荷塘图")
    poster = work / "荷塘图.png"
    poster.write_bytes(b"picture")
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(poster)},
        result="{}",
        status="ok",
        session_id="s",
        turn_id="poster",
    )
    plugin._turns[plugin.scope("s")].downloads["https://example.test/c.png"] = poster
    assert str(poster) in reply(plugin, "好了。", turn="poster")

    # 只是提到 PPT 不算做幻灯片：回复顺口一提、或者照着 PPT 的风格要一张海报，图仍是成品。
    for turn, user_message, answer in (
        ("aside", "生成一张荷塘图", "好了。需要的话也可以放进 PPT 里。"),
        ("styled", "照着上次PPT的封面风格，生成一张海报图", "海报好了。"),
    ):
        begin(plugin, turn=turn, user_message=user_message)
        image = work / f"{turn}.png"
        image.write_bytes(b"picture")
        plugin.after_tool(
            tool_name="write_file",
            args={"path": str(image)},
            result="{}",
            status="ok",
            session_id="s",
            turn_id=turn,
        )
        plugin._turns[plugin.scope("s")].downloads[f"https://example.test/{turn}.png"] = image
        assert str(image) in reply(plugin, answer, turn=turn)


def test_self_check_preview_and_agent_skill_file_are_not_carded_unless_asked_for(delivery):
    """做 PPT 时模型渲染来自查的同名 PDF、顺手改的技能说明，即使写进回复也不出卡；
    用户这句自己要 PDF、要存技能时，它们就是成品。"""
    plugin, work = delivery
    skill = work.parent / "home" / "skills" / "office" / "pptx-scripted-decks" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    for turn, user_message, kept in (
        ("plain", "帮我做一份大约 10 页的 PPT，给小学生讲恐龙。", set()),
        ("pdf", "帮我做一份恐龙 PPT，再导出一份 PDF。", {"pdf"}),
        ("skill", "做一份恐龙 PPT，做完把这次的做法存成技能。", {"skill"}),
    ):
        begin(plugin, turn=turn, user_message=user_message)
        deck = work / "恐龙大冒险.pptx"
        preview = work / "preview" / "恐龙大冒险.pdf"
        preview.parent.mkdir(exist_ok=True)
        for file in (deck, preview, skill):
            file.write_bytes(b"content")
            plugin.after_tool(
                tool_name="write_file",
                args={"path": str(file)},
                result="{}",
                status="ok",
                session_id="s",
                turn_id=turn,
            )
        result = reply(
            plugin, f"做好了。\n\nMEDIA:{deck}\nMEDIA:{preview}\nMEDIA:{skill}", turn=turn
        )
        assert str(deck) in result
        assert (str(preview) in result) == ("pdf" in kept)
        assert (str(skill) in result) == ("skill" in kept)


def test_generated_image_is_carded_next_to_document(delivery):
    """有文档时同轮图片按素材处理，但元景生成并下载的图片是成品本身，照样出卡。"""
    plugin, work = delivery
    begin(plugin)
    picture, material, output = (
        work / "海报.png",
        work / "chart.png",
        work / "说明.docx",
    )
    for file in (picture, material, output):
        file.write_bytes(b"deliverable")
        plugin.after_tool(
            tool_name="write_file",
            args={"path": str(file)},
            result="{}",
            status="ok",
            session_id="s",
            turn_id="t",
        )
    plugin._turns[plugin.scope("s")].downloads["https://example.test/a.png"] = picture
    result = reply(plugin)
    assert f"MEDIA:{output}" in result and f"MEDIA:{picture}" in result
    assert str(material) not in result


def test_images_embedded_in_report_are_not_carded_separately(delivery):
    """网页和 Markdown 报告引用的配图不单独出卡，没被引用的图片照常出卡。"""
    plugin, work = delivery
    begin(plugin)
    (work / "charts").mkdir()
    embedded = [work / "charts/趋势 图.png", work / "pie.png"]
    alone = work / "封面.png"
    page = work / "report.html"
    notes = work / "notes.md"
    page.write_text(
        '<img src="charts/%E8%B6%8B%E5%8A%BF%20%E5%9B%BE.png">', encoding="utf-8"
    )
    notes.write_text('![饼图](<pie.png> "标题")', encoding="utf-8")
    for file in (*embedded, alone):
        file.write_bytes(b"image")
    plugin.after_tool(
        tool_name="custom_tool",
        args={},
        result={"output": "\n".join(map(str, (*embedded, alone, page, notes)))},
        status="ok",
        session_id="s",
        turn_id="t",
    )
    result = reply(plugin)
    assert all(str(file) in result for file in (alone, page, notes))
    assert not any(str(file) in result for file in embedded)


@pytest.mark.parametrize("only_scratch", [False, True])
def test_explicit_scratch_media_stays_text_even_without_final_files(delivery, only_scratch):
    """临时 MEDIA 不能绕过自动过滤，只有临时文件时也保留说明而不补卡。"""
    plugin, work = delivery
    begin(plugin)
    scratch = work / ".tmp" / "draft (1).pptx"
    scratch.parent.mkdir()
    scratch.write_bytes(b"draft")
    final = work / "report.pptx"
    if not only_scratch:
        final.write_bytes(b"final")
    source = f"草稿：MEDIA:`{scratch}`\n\nMEDIA:.tmp/draft.wav\n结束。"
    result = reply(plugin, source) or source
    assert f"MEDIA:`{scratch}`" not in result
    assert "MEDIA:.tmp/" not in result
    assert str(scratch) in result and "结束。" in result
    assert result.count("MEDIA:") == (0 if only_scratch else 1)
    assert scratch.read_bytes() == b"draft"


@pytest.mark.parametrize("explicit", [False, True])
def test_report_html_dependencies_only_suppress_automatic_cards(delivery, explicit):
    """报告直连图表不自动补卡，明确交付与普通 CSV 保留，依赖文件不删除。"""
    plugin, work = delivery
    begin(plugin)
    chart = work / "charts" / "趋势 图.html"
    chart.parent.mkdir()
    chart.write_text("<p>chart</p>", encoding="utf-8")
    page = work / "report.html"
    page.write_text('<iframe src="charts/%E8%B6%8B%E5%8A%BF%20%E5%9B%BE.html?view=1#plot"></iframe>', encoding="utf-8")
    data = work / "data.csv"
    data.write_text("value\n1", encoding="utf-8")
    source = f"独立图表：\nMEDIA:`{chart}`" if explicit else "报告完成。"
    result = reply(plugin, source) or source
    assert str(page) in result and str(data) in result
    assert (str(chart) in result) == explicit
    assert chart.read_text(encoding="utf-8") == "<p>chart</p>"


@pytest.mark.parametrize("kind", ["document-and-image", "nine"])
def test_unappended_standalone_media_is_preserved(delivery, kind):
    """有文档时被过滤的图片和超过八张的标记仍在原位，不丢模型已经写出的交付。"""
    plugin, work = delivery
    begin(plugin)
    names = (
        ["picture.png", "report.docx"]
        if kind == "document-and-image"
        else [f"{n}.md" for n in range(9)]
    )
    files = [work / name for name in names]
    for file in files:
        file.write_bytes(b"deliverable")
    original = "\n".join(f"MEDIA:{file}" for file in files)
    result = reply(plugin, original) or original
    for file in files:
        assert result.count(f"MEDIA:{file}") == 1


def test_link_detection_works_without_path_is_junction(delivery, tmp_path):
    """普通目录和不存在路径不是链接，Windows 联接也不依赖 Python 3.12 API。"""
    plugin, work = delivery
    from delivery_test import paths

    assert not paths.is_link(work)
    assert not paths.is_link(work / "missing")
    link = work / "linked"
    if os.name == "nt":
        import subprocess

        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(tmp_path)],
            check=True,
            capture_output=True,
        )
    else:
        link.symlink_to(tmp_path, target_is_directory=True)
    assert paths.is_link(link)
    assert plugin.snapshot(work) == {}


def test_symbolic_link_is_detected(delivery):
    """具备创建权限时检查真实符号链接，无权限则明确跳过。"""
    _, work = delivery
    from delivery_test import paths

    link = work / "symbolic"
    try:
        link.symlink_to(work, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"无法创建符号链接：{error.errno}")
    assert paths.is_link(link)


@pytest.mark.parametrize("operation", ["walk", "lstat", "stat", "vanish"])
def test_unreadable_or_vanishing_entries_are_skipped(delivery, monkeypatch, operation):
    """读不到或扫描中途消失的条目只跳过它自己，其余文件照常进入基线。"""
    _, work = delivery
    from delivery_test import paths

    visible = work / "visible.pdf"
    visible.write_bytes(b"visible")
    blocked = work / "blocked"
    blocked.mkdir()
    hidden = blocked / "hidden.pdf"
    hidden.write_bytes(b"hidden")
    target = {"walk": blocked, "lstat": blocked, "stat": hidden, "vanish": blocked}
    error = FileNotFoundError if operation == "vanish" else PermissionError
    owner, name = {
        "walk": (paths.os, "scandir"),
        "vanish": (paths.os, "scandir"),
        "lstat": (paths.os, "lstat"),
        "stat": (Path, "stat"),
    }[operation]
    original = getattr(owner, name)

    def deny(path, *args, **kwargs):
        """只让指定目录或文件失败，其它文件操作保持真实。"""
        if Path(path) == target[operation]:
            raise error(13, "controlled failure", str(path))
        return original(path, *args, **kwargs)

    with monkeypatch.context() as fault:
        fault.setattr(owner, name, deny)
        before = paths.snapshot(work)
    assert before[visible.resolve()] is not None
    assert before.get(hidden.resolve()) is None
    # 恢复可读后，之前读漏的文件不能被当成新增。
    assert paths.changed(before, paths.snapshot(work)) == []
    assert paths.snapshot(work / "not-created") == {}


@pytest.mark.parametrize("completed", [False, True])
def test_video_notification_owns_delivery_even_during_another_foreground_turn(delivery, completed):
    """后台下载文件不能混进天气回复；完成通知显式交付的卡片仍保留。"""
    import json

    plugin, work = delivery
    begin(plugin)
    video = work / "电影.mp4"
    video.write_bytes(b"partial-or-finished-video")
    video.with_suffix('.meta.json').write_text(json.dumps({
        "managed": True, "out": str(video), "completed": completed,
    }))
    assert reply(plugin, '杭州今天有雨。') is None
    begin(plugin, turn='completion')
    text = f'下载完成。\nMEDIA:{video}'
    result = reply(plugin, text, turn='completion')
    assert (result or text).count('MEDIA:') == 1


def test_desktop_turn_reminds_where_intermediate_files_go(delivery, tmp_path, monkeypatch):
    """桌面本机会话每轮提醒中间文件放工作目录下的 .tmp；其它平台、子任务和远程不提醒。"""
    plugin, work = delivery
    context = plugin.before_turn(
        session_id="s", turn_id="t", task_id="s", platform="desktop"
    )["context"]
    assert f"本轮工作目录：{work}。" in context
    assert str(work / ".tmp") in context
    assert "MEDIA:<绝对路径>" in context
    assert not (work / ".tmp").exists()

    # 用户自选目录同样提醒，路径跟随本轮实际工作目录，目录由模型按需新建。
    chosen = tmp_path / "我的项目"
    chosen.mkdir()
    monkeypatch.setenv("TERMINAL_CWD", str(chosen))
    context = plugin.before_turn(
        session_id="s", turn_id="u", task_id="s", platform="desktop"
    )["context"]
    assert str(chosen / ".tmp") in context
    assert not (chosen / ".tmp").exists()

    assert (
        plugin.before_turn(
            session_id="s", turn_id="v", task_id="s", platform="telegram"
        )
        is None
    )
    plugin.background.remember_child(parent_session_id="s", child_session_id="child")
    assert (
        plugin.before_turn(
            session_id="child", turn_id="w", task_id="child", platform="subagent"
        )
        is None
    )
    monkeypatch.setenv("TERMINAL_ENV", "docker")
    assert (
        plugin.before_turn(session_id="s", turn_id="x", task_id="s", platform="desktop")
        is None
    )


@pytest.mark.parametrize("folder", [".tmp", "deep/.tmp/charts"])
def test_intermediate_files_in_scratch_folder_are_not_carded(delivery, folder):
    """.tmp 里的本轮新文件，无论写入、命令前后对比还是回复提到，都不补卡片。"""
    plugin, work = delivery
    begin(plugin)
    plugin.before_tool(
        tool_name="terminal", args={}, session_id="s", turn_id="t", tool_call_id="call"
    )
    scratch = work / folder
    scratch.mkdir(parents=True)
    draft = scratch / "draft.md"
    draft.write_text("draft")
    chart = scratch / "chart.png"
    chart.write_bytes(b"png")
    output = work / "report.docx"
    output.write_bytes(b"docx")
    plugin.after_tool(
        tool_name="terminal",
        args={},
        result=f'{{"exit_code":0,"output":"{draft.as_posix()}"}}',
        status="ok",
        session_id="s",
        turn_id="t",
        tool_call_id="call",
    )
    plugin.after_tool(
        tool_name="write_file",
        args={"path": str(draft)},
        result="{}",
        status="ok",
        session_id="s",
        turn_id="t",
    )
    result = reply(plugin, f"草稿在 {draft}，图表在 {chart}。")
    assert str(output) in result
    assert f"MEDIA:`{draft}`" not in result and f"MEDIA:`{chart}`" not in result
    assert result.count("MEDIA:") == 1


def test_scratch_files_stay_hidden_after_terminal_cd_into_scratch(delivery, monkeypatch):
    """模型 cd 进 .tmp 后终端目录停在那里，.tmp 里的文件仍不出卡，下一轮也以对话目录为准。"""
    from tools import terminal_tool

    plugin, work = delivery
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {})
    monkeypatch.setattr(terminal_tool, "_session_cwd", {})
    terminal_tool.register_task_env_overrides("s", {"cwd": str(work)})
    scratch = work / ".tmp"
    scratch.mkdir()

    def run(turn, call, made):
        """模拟一次终端命令：命令前后取快照，命令里写出 made 中的文件。"""
        plugin.before_tool(
            tool_name="terminal", args={}, session_id="s", turn_id=turn, tool_call_id=call
        )
        for file in made:
            file.write_text("data")
        plugin.after_tool(
            tool_name="terminal",
            args={},
            result='{"exit_code":0}',
            status="ok",
            session_id="s",
            turn_id=turn,
            tool_call_id=call,
        )

    begin(plugin)
    # 照真实会话：`cd .tmp && ...` 之后终端目录一直停在 .tmp。
    terminal_tool.record_session_cwd("s", str(scratch))
    tables = [scratch / f"table-{index}.csv" for index in range(9)]
    run("t", "data", tables)
    report = work / "report.html"
    run("t", "report", [report])
    result = reply(plugin, "\n".join(map(str, tables)))
    assert f"MEDIA:{report}" in result
    assert result.count("MEDIA:") == 1

    # 下一轮开始时终端仍在 .tmp：提醒和观察都用对话目录，不出现 .tmp\.tmp。
    context = plugin.before_turn(
        session_id="s", turn_id="u", task_id="s", platform="desktop"
    )["context"]
    assert f"本轮工作目录：{work}。" in context
    assert str(scratch / ".tmp") not in context
    draft = scratch / "next.md"
    run("u", "next", [draft])
    assert reply(plugin, str(draft), turn="u") is None


def test_native_final_receipt_delivers_snapshot_and_hides_working_draft(delivery):
    plugin, work = delivery
    begin(plugin)
    source = work / "outputs/project/deck.pptx"
    final = work / "outputs/deliveries/v/deck.pptx"
    for file in [source, final]:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"pptx")
    import json
    plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", result=json.dumps({
        "ok": True, "presentation": {"source_path": str(source), "file_path": str(final), "status": "final", "written_pages": 3, "version": "v"}
    }))
    result = reply(plugin, text="MEDIA:" + str(source))
    assert str(final) in result
    assert "MEDIA:" + str(source) not in result


@pytest.mark.parametrize("mention_old", [False, True])
def test_native_revisions_deliver_only_latest_per_source(delivery, mention_old):
    """同一工作稿只交最新版本，同名但独立的另一份成品仍需保留。"""
    plugin, work = delivery
    begin(plugin)
    source_a = work / "outputs/project-a/deck.pptx"
    source_b = work / "outputs/project-b/deck.pptx"
    old = work / "outputs/deliveries/a1/deck.pptx"
    latest = work / "outputs/deliveries/a2/deck.pptx"
    other = work / "outputs/deliveries/b1/deck.pptx"
    for file in [source_a, source_b, old, latest, other]:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(str(file).encode())
    for source, final in [(source_a, old), (source_b, other), (source_a, latest)]:
        plugin.after_tool(
            tool_name="TencentPpt", session_id="s", turn_id="t", status="ok",
            result={"ok": True, "presentation": {
                "source_path": str(source), "file_path": str(final), "status": "final",
                "written_pages": 1, "version": final.parent.name,
            }},
        )
    original = "做好了。" + (f"\n\n**MEDIA:{old}**" if mention_old else "")
    result = reply(plugin, original) or original
    assert str(old) not in result
    assert result.count(f"MEDIA:{latest}") == 1
    assert result.count(f"MEDIA:{other}") == 1
    assert result.count("MEDIA:") == 2
    assert old.is_file()


def test_internal_native_receipt_never_becomes_a_media_card(delivery):
    import json
    plugin, work = delivery
    begin(plugin)
    path = work / "ordinary-name.pptx"
    path.write_bytes(b"internal")
    state = path.parent / ".ppt-state" / (path.name + ".json")
    state.parent.mkdir()
    state.write_text(json.dumps({"purpose": "internal", "pages": {"0": {}}}))
    plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", result=json.dumps({
        "ok": True, "presentation": {"source_path": str(path), "file_path": str(path), "status": "draft", "purpose": "internal", "written_pages": 1}
    }))
    assert str(path) not in (reply(plugin, text="MEDIA:" + str(path)) or "")


@pytest.mark.parametrize("outcome", ["unconfirmed", "final", "corrupt", "empty", "internal"])
def test_saved_native_draft_stays_local_until_final_approval(delivery, outcome):
    import zipfile
    plugin, work = delivery
    begin(plugin)
    source = work / "outputs/project/report.pptx"
    source.parent.mkdir(parents=True)
    p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(source, "w") as archive:
        slide = '' if outcome == "empty" else '<p:sldId id="256" r:id="rId1"/>'
        archive.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{p}" xmlns:r="{r}"><p:sldIdLst>{slide}</p:sldIdLst></p:presentation>')
        archive.writestr("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>')
        archive.writestr("ppt/slides/slide1.xml", f'<p:sld xmlns:p="{p}"><p:cSld/></p:sld>')
    if outcome == "corrupt":
        source.write_bytes(b'broken zip')
    receipt = {"source_path": str(source), "file_path": str(source), "status": "draft", "written_pages": 1,
               "purpose": "internal" if outcome == "internal" else "deliverable",
               "visual_unconfirmed_pages": {"0": "识图服务暂时不可用"}, "visual_pending_pages": [0]}
    plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", result={"ok": True, "presentation": receipt})
    if outcome == "final":
        final = work / "outputs/deliveries/final/report.pptx"
        final.parent.mkdir(parents=True)
        final.write_bytes(source.read_bytes())
        plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", result={"ok": True,
            "presentation": {**receipt, "status": "final", "file_path": str(final)}})
    result = reply(plugin, text="暂未完成。\n\nMEDIA:" + str(source)) or ""
    drafts = list(source.parent.glob("recovery/*/*.pptx"))
    if outcome == "unconfirmed":
        assert not drafts and "MEDIA:" not in result
        assert source.is_file()
        assert "已保留待核对工作稿" not in result
    elif outcome == "final":
        assert not drafts and result.count("MEDIA:") == 1 and str(final) in result
        assert "尚未通过最终验收" not in result
    else:
        assert not drafts and "MEDIA:" not in result


def test_draft_recovery_does_not_publish_other_workspaces(delivery):
    plugin, work = delivery
    begin(plugin)
    outside = work.parent / "other-session.pptx"
    outside.write_bytes(b'not this task')
    plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", result={"ok": True,
        "presentation": {"source_path": str(outside), "file_path": str(outside), "status": "draft", "written_pages": 1}})
    result = reply(plugin, "尚未完成。") or ""
    assert "MEDIA:" not in result
    assert outside.read_bytes() == b'not this task'


@pytest.mark.parametrize("suffix", ["pptx", "docx", "xlsx", "pdf"])
def test_office_handoff_excludes_prose_mentions_and_explicit_drafts(delivery, suffix):
    plugin, work = delivery
    begin(plugin)
    final = work / f"成品.{suffix}"
    another = work / f"独立成果.{suffix}"
    old = work / f"旧版v1.{suffix}"
    draft = work / f"方案-草稿.{suffix}"
    for path in (final, another, old, draft):
        path.write_bytes(b"saved document")
        plugin.after_tool(tool_name="write_file", args={"path": str(path)}, result="{}",
                          status="ok", session_id="s", turn_id="t")
    original = f"旧文件位置：`{old}`\n\nMEDIA:{final}\nMEDIA:{another}\nMEDIA:{draft}\n[草稿下载]({draft.as_posix()})"
    result = reply(plugin, original) or original
    assert result.count("MEDIA:") == 2
    assert str(final) in result and str(another) in result
    assert "MEDIA:" + str(old) not in result and "MEDIA:" + str(draft) not in result
    assert f"]({draft.as_posix()})" not in result
    assert all(path.is_file() for path in (final, another, old, draft))


def test_native_success_does_not_recover_other_working_paths(delivery):
    plugin, work = delivery
    begin(plugin)
    old = work / "v1/report.pptx"
    source = work / "v3/report.pptx"
    final = work / "deliveries/ready/report.pptx"
    for path in (old, source, final):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"saved document")
    for path in (old, source):
        plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", status="ok",
            result={"ok":True,"presentation":{"source_path":str(path),"file_path":str(path),"status":"draft","written_pages":4}})
    plugin.after_tool(tool_name="TencentPpt", session_id="s", turn_id="t", status="ok",
        result={"ok":True,"presentation":{"source_path":str(source),"file_path":str(final),"status":"final","written_pages":4}})
    result = reply(plugin, "已完成。")
    assert result.count("MEDIA:") == 1 and str(final) in result
    assert "待核对" not in result and not list(work.rglob("recovery"))
    assert old.is_file() and source.is_file()
