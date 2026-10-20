"""只观察本机桌面产物，通过原生输出钩子把卡片和回复一同持久化。"""

from collections import OrderedDict
import asyncio
from dataclasses import dataclass, field
import json
from itertools import islice
from pathlib import Path
import re
from threading import RLock
import time

from .paths import (
    changed,
    DOCUMENTS,
    IMAGES,
    fresh,
    is_dir,
    media_line,
    named_paths,
    remove_media_lines,
    resolve_path,
    requested_roots,
    shown_paths,
    snapshot,
)

_turns = OrderedDict()
_lock = RLock()
WRITERS = {"terminal", "execute_code", "write_file", "patch"}


@dataclass
class Turn:
    """观察数据只属于账号、会话和本轮；不保存凭据或跨轮缓存。"""

    turn_id: str
    cwd: Path
    started: float
    task_id: str = ""
    uploads: set = field(default_factory=set)
    paths: dict = field(default_factory=dict)
    pending: dict = field(default_factory=dict)
    scans: dict = field(default_factory=dict)
    roots: set = field(default_factory=set)
    ambiguous: set = field(default_factory=set)
    guess: bool = True
    downloads: dict = field(default_factory=dict)


def scope(session_id):
    """每次从原生 profile 上下文取 Home，不能缓存某个账号为进程默认值。"""
    from hermes_constants import get_hermes_home

    return (str(get_hermes_home().resolve()), session_id)


def local_cwd(task_id):
    """只接收本机终端目录，容器和远程后端不读取宿主文件。"""
    from tools.terminal_tool import _get_env_config, get_session_cwd

    config = _get_env_config()
    if config.get("env_type") != "local":
        return None
    raw = get_session_cwd(task_id) or config.get("cwd")
    root = resolve_path(raw, Path.cwd())
    return root if root and is_dir(root) else None


def as_text(value, depth=0):
    """工具结构只提取受限文本用作路径证据，不保存完整输出。"""
    if isinstance(value, str):
        return value[:200_000]
    if depth >= 4:
        return ""
    items = (
        value.values()
        if isinstance(value, dict)
        else value
        if isinstance(value, list)
        else []
    )
    return "\n".join(as_text(item, depth + 1) for item in islice(items, 256))[:200_000]


def attachment_paths(value, cwd):
    """只排除上传标记和结构化附件中的路径，不误排除用户指定的新产物路径。"""
    if isinstance(value, str):
        return {
            path
            for match in re.finditer(
                r"\[(?:user attached file|attached file|image attached):\s*([^\]]+)\]",
                value,
                re.I,
            )
            for path in [resolve_path(match.group(1), cwd)]
            if path is not None
        }
    if isinstance(value, list):
        return set().union(*(attachment_paths(item, cwd) for item in value))
    if isinstance(value, dict):
        if value.get("type") in {
            "input_file",
            "file",
            "document",
            "image",
            "image_url",
        }:
            return set(named_paths(as_text(value), cwd))
        return attachment_paths(value.get("attachments", []), cwd) | attachment_paths(
            value.get("content", value.get("text", "")), cwd
        )
    return set()


def before_turn(
    *, session_id="", turn_id="", task_id="", platform="", user_message=None, **kwargs
):
    """本轮开始时固定本机目录和附件排除表，缺少桌面身份则不观察。"""
    if not session_id or platform != "desktop":
        return
    cwd = local_cwd(task_id)
    if cwd is None:
        return
    with _lock:
        key = scope(session_id)
        _turns[key] = Turn(
            turn_id,
            cwd,
            time.time(),
            task_id=task_id,
            uploads=attachment_paths(user_message, cwd),
        )
        _turns.move_to_end(key)
        turn = _turns[key]
        budget = [time.monotonic(), 0]
        for root in requested_roots(as_text(user_message), cwd):
            watch_root(turn, root, budget)
        while len(_turns) > 128:
            _turns.popitem(last=False)


def current(key, turn_id):
    """旧轮迟到的工具结果不能进入新轮；调用方在锁内读取和修改。"""
    turn = _turns.get(key)
    return turn if turn and turn.turn_id == turn_id else None


def invalidate(turn, root):
    """与其他会话的目录重叠时，作废本轮所有重叠基线，持续到本轮结束。"""
    turn.ambiguous.update(
        other
        for other in turn.roots
        if root.is_relative_to(other) or other.is_relative_to(root)
    )
    for pending in turn.pending.values():
        if root.is_relative_to(pending[0]) or pending[0].is_relative_to(root):
            pending[1] = None


def watch_root(turn, root, budget=None):
    """登记目录并与其他会话核对重叠；前四个目录记基线，返回是否刚记下基线。"""
    if root in turn.roots:
        return False
    turn.roots.add(root)
    for active in _turns.values():
        if active is turn:
            continue
        for other in active.roots:
            if root.is_relative_to(other) or other.is_relative_to(root):
                invalidate(active, root)
                invalidate(turn, other)
    if len(turn.scans) >= 4:
        return False
    turn.scans[root] = snapshot(root, budget)
    return True


def before_tool(
    *, tool_name="", args=None, session_id="", turn_id="", tool_call_id="", **kwargs
):
    """同步命令及代码运行前取快照；观察窗口重叠时放弃无法确认归属的差异。"""
    if tool_name not in WRITERS:
        return
    with _lock:
        turn = current(scope(session_id), turn_id)
        if not turn or len(turn.pending) >= 64:
            return
        root = local_cwd(kwargs.get("task_id") or turn.task_id) or turn.cwd
        if tool_name == "terminal" and (args or {}).get("workdir"):
            root = resolve_path(args["workdir"], root)
            if root is None or not is_dir(root):
                return
        added = watch_root(turn, root)
        observe = (
            tool_name in {"terminal", "execute_code"}
            and not (args or {}).get("background")
            and root not in turn.ambiguous
        )
        # 目录刚登记时的基线就是命令前状态，不再重复扫描。
        before = (turn.scans[root] if added else snapshot(root)) if observe else None
        # 任何会话（包括本轮并行的命令）的执行窗口重叠，只作废这些窗口的差异；
        # 本轮结束扫描不受影响，因为同一轮的产物本就都属于本轮。
        for active in _turns.values():
            for pending in active.pending.values():
                if pending[0].is_relative_to(root) or root.is_relative_to(pending[0]):
                    pending[1] = before = None
        if tool_call_id and tool_name in {"terminal", "execute_code"}:
            turn.pending[tool_call_id] = [root, before]


def after_tool(
    *,
    tool_name="",
    args=None,
    result=None,
    status="ok",
    session_id="",
    turn_id="",
    tool_call_id="",
    **kwargs,
):
    """合并写入参数、工具输出和执行差异，失败或后台任务不冒充已完成交付。"""
    with _lock:
        turn = current(scope(session_id), turn_id)
        if turn is None:
            return
        pending = turn.pending.pop(tool_call_id, None)
        try:
            data = json.loads(result) if isinstance(result, str) else result
        except ValueError:
            data = None
        if not completed(data, status, args):
            if tool_name in WRITERS:
                turn.guess = False
            return
        root = (
            pending[0]
            if pending
            else local_cwd(kwargs.get("task_id") or turn.task_id) or turn.cwd
        )
        candidates = named_paths(as_text(result), root)
        if tool_name in {"write_file", "patch"}:
            candidate = resolve_path((args or {}).get("path"), root)
            if candidate:
                candidates.insert(0, candidate)
        if pending and pending[1] is not None:
            after = snapshot(pending[0])
            if after is not None:
                candidates += changed(pending[1], after)
        # 素材目录名只在这些工作目录里面判断，目录本身叫什么不影响。
        roots = {*turn.roots, turn.cwd, root}
        for path in candidates:
            if len(turn.paths) >= 256:
                break
            if path not in turn.uploads and fresh(path, turn.started, roots):
                turn.paths[path] = None


def transform(*, response_text="", session_id="", turn_id="", platform="", **kwargs):
    """只改本轮尚未存储的回复，统一排序、去重和最多八张交付卡。"""
    if platform != "desktop" or not isinstance(response_text, str):
        return None
    key = scope(session_id)
    with _lock:
        turn = current(key, turn_id)
        if not turn:
            return None
        budget = [time.monotonic(), 0]
        if turn.guess:
            for root, before in turn.scans.items():
                if root in turn.ambiguous or before is None:
                    continue
                after = snapshot(root, budget)
                if after is not None:
                    for path in changed(before, after):
                        turn.paths.setdefault(path, None)
        _turns.pop(key, None)
    cwd = local_cwd(turn.task_id) or turn.cwd
    roots = {*turn.roots, turn.cwd, cwd}
    paths = dict.fromkeys([*turn.paths, *named_paths(response_text, cwd)])
    paths = [
        path
        for path in paths
        if path not in turn.uploads and fresh(path, turn.started, roots)
    ]
    if not paths:
        return None
    from gateway.platforms.base import _mask_media_scan_text

    # 代码和引用里的示例只屏蔽一次，两处识别共用同一份结果。
    masked = _mask_media_scan_text(response_text)
    managed = set(paths)
    shown = shown_paths(masked, cwd)
    if any(path.suffix.lower().lstrip(".") in DOCUMENTS for path in paths):
        paths = [
            path for path in paths if path.suffix.lower().lstrip(".") not in IMAGES
        ]
    from .paths import priority

    appended = [path for path in sorted(paths, key=priority) if path not in shown][:8]
    moved = set(appended) | (managed & shown)
    # 只移走将追加或已有另一展示位置的独立行，未选中卡片不能被误删。
    text = remove_media_lines(response_text, masked, cwd, moved)
    rewritten = (
        "\n\n".join(
            part
            for part in [text.rstrip(), "\n".join(map(media_line, appended))]
            if part
        )
        if appended
        else text
    )
    return rewritten if rewritten != response_text else None


def completed(data, status, args):
    """观察和下载共用完成判据，MCP 失败、非零退出和后台任务都不能冒充成品。"""
    return (
        status == "ok"
        and not (args or {}).get("background")
        and not (
            isinstance(data, dict)
            and (
                data.get("error")
                or data.get("isError")
                or data.get("status") in {"error", "running", "background"}
                or data.get("exit_code") not in (None, 0)
            )
        )
    )


async def download_result(
    *,
    tool_name="",
    args=None,
    result=None,
    status="ok",
    session_id="",
    turn_id="",
    **kwargs,
):
    """下载成品并写明本机副本；未能保存的成品保留链接并说明交付方式。每轮最多四次，网络不占状态锁。"""
    from .downloads import annotate, fetch, generator_urls

    try:
        data = json.loads(result) if isinstance(result, str) else result
    except ValueError:
        data = result
    if not completed(data, status, args):
        return None
    urls = generator_urls(tool_name, as_text(data))
    if not urls:
        return None
    key = scope(session_id)
    with _lock:
        turn = current(key, turn_id)
        if turn is None:
            return None
        wanted = [url for url in urls if url not in turn.downloads][
            : max(0, 4 - len(turn.downloads))
        ]
        turn.downloads.update(dict.fromkeys(wanted))
    root = local_cwd(turn.task_id) or turn.cwd
    # 同批最多四个并行，避免顺序等待突破原生钩子的三十秒上限；描述参数用于起文件名。
    fetched = await asyncio.gather(
        *(fetch(url, root, tool_name, args) for url in wanted)
    )
    with _lock:
        active = current(key, turn_id) is turn
        if active:
            turn.downloads.update(zip(wanted, fetched))
            saved = {url: turn.downloads[url] for url in urls if turn.downloads.get(url)}
            for path in saved.values():
                turn.paths[path] = None
    if not active:
        for path in fetched:
            if path:
                path.unlink(missing_ok=True)
        return None
    missing = [url for url in urls if url not in saved]
    return annotate(tool_name, result, data, root, saved, missing)


def end_turn(*, session_id="", turn_id="", **kwargs):
    """取消、失败和会话结束都清除观察状态；迟到的旧轮结束事件不能清掉新一轮。"""
    key = scope(session_id)
    with _lock:
        turn = _turns.get(key)
        if turn and (not turn_id or turn.turn_id == turn_id):
            _turns.pop(key)


def register(ctx):
    """只使用现有原生钩子，不增加模型工具或修改 Hermes 核心。"""
    from .uploads import before_call, remember_session

    for name, handler in [
        ("pre_llm_call", before_turn),
        # 元景工具读不到本机文件：调用前替模型上传并换成 ossPath。
        ("pre_llm_call", remember_session),
        ("pre_tool_call", before_tool),
        ("pre_tool_call", before_call),
        ("post_tool_call", after_tool),
        ("transform_tool_result", download_result),
        ("transform_llm_output", transform),
        ("on_session_end", end_turn),
    ]:
        ctx.register_hook(name, handler)
