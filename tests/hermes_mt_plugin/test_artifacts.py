"""产物上传（plugin/uniwork_enterprise/artifacts.py）：选哪些文件、待传清单和返回码、一轮的钩子。

和 hermes 的钩子分发一起跑的在 test_plugin.py。
"""

from __future__ import annotations

import json
import mimetypes
import os
import time
from pathlib import Path

import pytest

from .support import SERVER, TOKEN_ENV, write_settings, write_token  # 先把插件目录加进 sys.path
from uniwork_enterprise import artifacts as art  # noqa: E402
from uniwork_enterprise.artifacts import PATH, PER_TURN, Uploader, make_turn_hook, make_write_hook, named_paths, pick
from uniwork_enterprise.outbox import CLIENT_VERSION
from uniwork_enterprise.settings import Source
from uniwork_enterprise.status import Status
from uniwork_enterprise.turns import Turns


def _file(path: Path, data: bytes = b"x", *, at: float | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if at is not None:
        os.utime(path, (at, at))
    return path


def _real(path: Path) -> Path:
    return Path(os.path.realpath(path))


def _bump(path: Path) -> None:
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


@pytest.fixture
def workspace(root: Path) -> Path:
    path = root / "workspace"
    path.mkdir()
    return path


@pytest.fixture
def on(root: Path) -> Path:
    """平台开着产物上传。"""
    write_settings(root, artifacts=True, profiles={"uw-agent_a": {"agentId": "agent_a", "collaborators": []}})
    return root


# ---------------------------------------------------------------- 选文件

def test_the_ways_a_reply_points_at_files(workspace: Path) -> None:
    report = workspace / "季度报告.docx"
    chart = workspace / "图表 一.png"
    text = (f"报告写好了：{report}。\n"
            f"MEDIA:`{chart}`\n"
            "明细见 [这里](明细.xlsx) 和 `out/summary.md`，原始数据 data.csv")
    found = named_paths(text, workspace)
    for want in (report, chart, workspace / "明细.xlsx", workspace / "out" / "summary.md", workspace / "data.csv"):
        assert want in found, want


def test_only_fresh_deliverables_inside_the_workspace(root: Path, workspace: Path) -> None:
    stale = _file(workspace / "旧.pdf", b"old", at=time.time() - 3600)  # 这一轮以前建的、改的
    since = time.time() + 3  # 这一轮在它之后开始（Windows 的 st_birthtime 是刚才，沙箱的 Linux 只看修改时间）
    good = _file(workspace / "报告.docx", b"doc", at=since)
    nested = _file(workspace / "out" / "图.png", b"png", at=since)
    others = [
        stale,
        _file(workspace / ".tmp" / "草稿.docx", b"d", at=since),  # 点开头的目录
        _file(workspace / "assets" / "logo.png", b"l", at=since),  # 素材目录
        _file(workspace / "uploads" / "attachments" / "合同.pdf", b"c", at=since),  # 员工上传的附件
        _file(workspace / "make.py", b"print()", at=since),  # 不在交付白名单
        _file(workspace / "空.md", b"", at=since),  # 空文件
        _file(workspace / "~$报告.docx", b"l", at=since),  # Office 锁文件
        _file(root / "scratch" / "外面.docx", b"o", at=since),  # 工作区外
        workspace / "没有.docx",  # 不存在
    ]
    assert pick([good, nested, *others, good], workspace=workspace, since=since) == [_real(good), _real(nested)]


def test_a_link_out_of_the_workspace_does_not_count(root: Path, workspace: Path) -> None:
    secret = _file(root / "outside.md", b"secret")
    link = workspace / "看这个.md"
    try:
        link.symlink_to(secret)
    except OSError:
        pytest.skip("这台机器建不了符号链接")
    assert pick([link], workspace=workspace, since=time.time() - 5) == []


def test_a_workspace_reached_through_a_link_still_counts(root: Path, tmp_path: Path) -> None:
    """沙箱里 /opt/data/workspace 是指向卷的链接：按解开后的路径比。"""
    volume = tmp_path / "volume-workspace"
    volume.mkdir()
    linked = root / "workspace-link"
    try:
        linked.symlink_to(volume, target_is_directory=True)
    except OSError:
        pytest.skip("这台机器建不了符号链接")
    made = _file(volume / "报告.pdf", b"pdf")
    assert pick([linked / "报告.pdf"], workspace=linked, since=time.time() - 5) == [_real(made)]


def test_at_most_eight_a_turn_documents_first(workspace: Path) -> None:
    images = [_file(workspace / f"图{i}.png") for i in range(6)]
    documents = [_file(workspace / f"文档{i}.pdf") for i in range(4)]
    chosen = pick(images + documents, workspace=workspace, since=time.time() - 5)
    assert len(chosen) == PER_TURN == 8
    assert [p.suffix for p in chosen] == [".pdf"] * 4 + [".png"] * 4


def test_too_big_is_not_a_deliverable(workspace: Path) -> None:
    big = _real(_file(workspace / "大.zip", b"0" * 10))
    assert not art.deliverable(big, _real(workspace), time.time() - 5, max_bytes=9)
    assert art.deliverable(big, _real(workspace), time.time() - 5, max_bytes=10)


# ---------------------------------------------------------------- 上传

class _Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


class _Platform:
    """按顺序回状态码（用完了一律 200），记下每次收到的东西。"""

    def __init__(self, codes=()):
        self.codes = list(codes)
        self.calls: list[dict] = []

    def __call__(self, url, fields, file, headers, timeout):
        name, handle, content_type = file
        self.calls.append({"url": url, "fields": dict(fields), "name": name, "data": handle.read(),
                           "type": content_type, "headers": dict(headers)})
        code = self.codes.pop(0) if self.codes else 200
        if code == "network":
            raise OSError("connection refused")
        return code


def _uploader(root: Path, platform: _Platform, clock: _Clock, status=None) -> Uploader:
    return Uploader(Source(root), root, status=status, post=platform, titles=lambda profile, session: "季度汇报",
                    clock=clock, monotonic=clock, background=False)


def _put(box: Uploader, *paths: Path) -> int:
    return box.put([_real(p) for p in paths], session="s2", root="s1", profile="uw-agent_a", agent_id="agent_a")


def test_an_upload_carries_the_session_and_the_agent(on: Path, workspace: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _uploader(on, platform, clock)
    _put(box, _file(workspace / "季度报告.docx", b"report"))
    assert box.flush() == 1 and len(box) == 0
    [call] = platform.calls
    assert call["url"] == SERVER + PATH
    assert call["fields"] == {"sessionId": "s1", "sessionName": "季度汇报", "agentId": "agent_a"}
    assert call["name"] == "季度报告.docx" and call["data"] == b"report"
    assert call["type"] == (mimetypes.guess_type("x.docx")[0] or "application/octet-stream")
    assert call["headers"] == {"Authorization": "Bearer tok-1", "X-Uniwork-Version": CLIENT_VERSION}


def test_a_file_goes_once_until_it_changes(on: Path, workspace: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _uploader(on, platform, clock)
    made = _file(workspace / "报告.md", b"v1")
    assert _put(box, made) == 1 and _put(box, made) == 0  # 在队里的不重复入队
    box.flush()
    assert _put(box, made) == 0  # 传过、没变
    _file(made, b"version 2")
    _bump(made)
    assert _put(box, made) == 1
    box.flush()
    assert [c["data"] for c in platform.calls] == [b"v1", b"version 2"]


def test_the_pending_list_survives_a_restart(on: Path, workspace: Path) -> None:
    clock = _Clock()
    box = _uploader(on, _Platform([503]), clock)
    _put(box, _file(workspace / "报告.pdf", b"pdf"))
    assert box.flush() == 0 and len(box) == 1
    pending = json.loads((on / art.PENDING_FILE).read_text(encoding="utf-8"))
    assert [Path(i["path"]).name for i in pending["items"]] == ["报告.pdf"]
    assert "tok-1" not in json.dumps(pending)
    platform = _Platform()
    again = _uploader(on, platform, clock)  # 实例重启以后
    assert len(again) == 1 and again.flush() == 1
    assert platform.calls[0]["fields"]["sessionId"] == "s1"


def test_a_401_rereads_the_token_and_sends_the_whole_file_again(on: Path, workspace: Path) -> None:
    platform, clock = _Platform([401]), _Clock()
    box = _uploader(on, platform, clock)
    box.source.token(TOKEN_ENV)  # 缓存住旧令牌
    before = (on / ".env").stat()
    write_token(on, "tok-2")
    os.utime(on / ".env", ns=(before.st_atime_ns, before.st_mtime_ns))
    _put(box, _file(workspace / "报告.pdf", b"whole file"))
    assert box.flush() == 1
    assert [c["headers"]["Authorization"] for c in platform.calls] == ["Bearer tok-1", "Bearer tok-2"]
    assert [c["data"] for c in platform.calls] == [b"whole file", b"whole file"]


def test_a_second_401_keeps_the_file_and_waits_a_minute(on: Path, workspace: Path) -> None:
    platform, clock = _Platform([401, 401]), _Clock()
    box = _uploader(on, platform, clock)
    _put(box, _file(workspace / "报告.pdf"))
    assert box.flush() == 0 and len(box) == 1
    clock.now += art.UNAUTHORIZED_PAUSE_S - 1
    assert box.flush() == 0 and len(platform.calls) == 2
    clock.now += 2
    assert box.flush() == 1


@pytest.mark.parametrize(("code", "kept", "pause"), [
    (403, 0, art.FORBIDDEN_PAUSE_S),  # 成员停用、没有权限：清空
    (404, 2, art.MISSING_PAUSE_S),  # 平台没有这个接口：歇着，留着
    (500, 2, art.BACKOFF_MIN_S),
    ("network", 2, art.BACKOFF_MIN_S),
])
def test_what_the_platform_says(on: Path, workspace: Path, code, kept: int, pause: float) -> None:
    platform, clock = _Platform([code]), _Clock()
    box = _uploader(on, platform, clock)
    _put(box, _file(workspace / "a.pdf"), _file(workspace / "b.pdf"))
    assert box.flush() == 0 and len(box) == kept
    clock.now += pause - 1
    assert box.flush() == 0 and len(platform.calls) == 1
    clock.now += 2
    assert box.flush() == kept


@pytest.mark.parametrize("code", [400, 413, 422])
def test_a_rejected_file_is_dropped_and_the_next_still_goes(on: Path, workspace: Path, code: int) -> None:
    platform, clock = _Platform([code]), _Clock()
    box = _uploader(on, platform, clock)
    _put(box, _file(workspace / "a.pdf"), _file(workspace / "b.pdf"))
    assert box.flush() == 1 and len(box) == 0


def test_skipped_by_the_platform_counts_as_done(on: Path, workspace: Path) -> None:
    """成员在对话日志屏蔽名单里：平台回 200 {"skipped": true}，不再传。"""
    platform, clock = _Platform([200]), _Clock()
    box = _uploader(on, platform, clock)
    made = _file(workspace / "a.pdf")
    _put(box, made)
    assert box.flush() == 1 and _put(box, made) == 0


def test_a_vanished_file_is_dropped(on: Path, workspace: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _uploader(on, platform, clock)
    gone = _file(workspace / "a.pdf")
    _put(box, gone, _file(workspace / "b.pdf"))
    gone.unlink()
    assert box.flush() == 1 and [c["name"] for c in platform.calls] == ["b.pdf"]


def test_switching_it_off_clears_the_list(on: Path, workspace: Path) -> None:
    platform, clock = _Platform(), _Clock()
    box = _uploader(on, platform, clock)
    _put(box, _file(workspace / "a.pdf"))
    write_settings(on, artifacts=False)
    _bump(on / ".cache/uniwork-enterprise/plugin.json")
    assert box.flush() == 0 and len(box) == 0 and platform.calls == []


def test_a_day_old_file_is_given_up(on: Path, workspace: Path) -> None:
    platform, clock = _Platform([503]), _Clock()
    box = _uploader(on, platform, clock)
    _put(box, _file(workspace / "a.pdf"))
    box.flush()
    clock.now += art.MAX_AGE_S + 1
    assert box.flush() == 0 and len(box) == 0 and len(platform.calls) == 1


def test_the_status_file_counts_artifacts(on: Path, workspace: Path) -> None:
    platform, clock = _Platform([500]), _Clock()
    box = _uploader(on, platform, clock, status=Status(on))
    _put(box, _file(workspace / "a.pdf"))
    box.flush()
    status = json.loads((on / ".cache/uniwork-enterprise/plugin-status.json").read_text(encoding="utf-8"))
    assert status["artifacts"] == {"lastSend": status["artifacts"]["lastSend"], "queued": 1, "sent": 0}
    assert status["artifacts"]["lastSend"]["code"] == 500
    clock.now += 10
    box.flush()
    status = json.loads((on / ".cache/uniwork-enterprise/plugin-status.json").read_text(encoding="utf-8"))
    assert status["artifacts"]["queued"] == 0 and status["artifacts"]["sent"] == 1


# ---------------------------------------------------------------- 一轮的钩子

class _Roots:
    def root(self, session_id: str) -> str:
        return {"s2": "s1"}.get(session_id, session_id)


class _Queue:
    def __init__(self):
        self.put_calls: list[dict] = []

    def put(self, paths, **kw):
        self.put_calls.append({"paths": [Path(p).name for p in paths], **kw})
        return len(paths)


def _turn(on: Path, workspace: Path, platform: str):
    turns, queue = Turns(clock=lambda: time.time() - 5), _Queue()
    source = Source(on)
    write = make_write_hook(turns, workspace)
    end = make_turn_hook(source, _Roots(), turns, queue, "uw-agent_a", workspace)
    turns.hook_begin(session_id="s2", turn_id="s1:t:1", platform=platform, task_id="t")
    named = _file(workspace / "报告.docx", b"r")
    written = _file(workspace / "数据.csv", b"1,2")
    write(tool_name="write_file", args={"path": str(written)}, status="ok", session_id="s2", turn_id="s1:t:1")
    write(tool_name="read_file", args={"path": str(named)}, status="ok", session_id="s2", turn_id="s1:t:1")
    end(session_id="s2", turn_id="s1:t:1", task_id="t", assistant_response=f"报告：{named}", platform=platform)
    return queue, turns


def test_a_turn_queues_what_the_reply_hands_over(on: Path, workspace: Path) -> None:
    queue, turns = _turn(on, workspace, "desktop")
    assert queue.put_calls == [{"paths": ["报告.docx"], "session": "s2", "root": "s1", "profile": "uw-agent_a",
                                "agent_id": "agent_a"}]
    assert turns.current("s2") is None  # 一轮结束就忘掉


def test_a_platform_run_also_hands_over_what_it_wrote(on: Path, workspace: Path) -> None:
    queue, _ = _turn(on, workspace, "api_server")
    assert queue.put_calls[0]["paths"] == ["报告.docx", "数据.csv"]


def test_a_subagent_reply_is_not_a_delivery(on: Path, workspace: Path) -> None:
    queue, _ = _turn(on, workspace, "subagent")
    assert queue.put_calls == []


def test_nothing_is_queued_while_the_platform_says_no(root: Path, workspace: Path) -> None:
    queue, _ = _turn(root, workspace, "desktop")  # root 的 plugin.json 没开 artifacts
    assert queue.put_calls == []


def test_a_turn_that_compressed_midway_still_counts(on: Path, workspace: Path) -> None:
    """压缩换了会话号：结束时带新会话号、同一个 turn_id。"""
    turns, queue = Turns(clock=lambda: time.time() - 5), _Queue()
    end = make_turn_hook(Source(on), _Roots(), turns, queue, "uw-agent_a", workspace)
    turns.hook_begin(session_id="s1", turn_id="s1:t:1", platform="desktop")
    made = _file(workspace / "报告.pdf")
    end(session_id="s2", turn_id="s1:t:1", assistant_response=f"见 {made}", platform="desktop")
    assert queue.put_calls[0]["paths"] == ["报告.pdf"] and queue.put_calls[0]["root"] == "s1"
