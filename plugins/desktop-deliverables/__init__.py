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
    DOCUMENTS,
    IMAGES,
    LINKS,
    MEDIA,
    fresh,
    media_line,
    named_paths,
    resolve_path,
    requested_roots,
    snapshot,
)

_turns = OrderedDict()
_lock = RLock()


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
    return root if root and root.is_dir() else None


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


def current(session_id, turn_id):
    """旧轮迟到的工具结果不能进入新轮；调用方在锁内读取和修改。"""
    turn = _turns.get(scope(session_id))
    return turn if turn and turn.turn_id == turn_id else None


def watch_root(turn, root, budget=None):
    """开始观察时记基线；包含关系也算并发，歧义保留到两轮都结束。"""
    if root in turn.scans or len(turn.scans) >= 4:
        return
    turn.scans[root] = snapshot(root, budget)
    for active in _turns.values():
        if active is turn:
            continue
        for other in active.scans:
            if root.is_relative_to(other) or other.is_relative_to(root):
                active.ambiguous.add(other)
                turn.ambiguous.add(root)
                for observed in (active, turn):
                    for pending in observed.pending.values():
                        if pending[0].is_relative_to(root) or root.is_relative_to(
                            pending[0]
                        ):
                            pending[1] = None


def before_tool(
    *, tool_name="", args=None, session_id="", turn_id="", tool_call_id="", **kwargs
):
    """同步命令及代码运行前取快照；观察窗口重叠时放弃无法确认归属的差异。"""
    if tool_name not in {"terminal", "execute_code", "write_file", "patch"}:
        return
    with _lock:
        turn = current(session_id, turn_id)
        if not turn or len(turn.pending) >= 64:
            return
        root = local_cwd(kwargs.get("task_id") or turn.task_id) or turn.cwd
        if tool_name == "terminal" and (args or {}).get("workdir"):
            root = resolve_path(args["workdir"], root)
            if root is None or not root.is_dir():
                return
        watch_root(turn, root)
        before = (
            snapshot(root)
            if tool_name in {"terminal", "execute_code"}
            and not (args or {}).get("background")
            and root not in turn.ambiguous
            else None
        )
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
        turn = current(session_id, turn_id)
        if turn is None:
            return
        pending = turn.pending.pop(tool_call_id, None)
        try:
            data = json.loads(result) if isinstance(result, str) else result
        except ValueError:
            data = None
        if not completed(data, status, args):
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
                candidates += [
                    path for path, stat in after.items() if pending[1].get(path) != stat
                ]
        for path in candidates:
            if len(turn.paths) >= 256:
                break
            if path not in turn.uploads and fresh(path, turn.started):
                turn.paths[path] = None


def transform(*, response_text="", session_id="", turn_id="", platform="", **kwargs):
    """只改本轮尚未存储的回复，统一排序、去重和最多八张交付卡。"""
    if platform != "desktop" or not isinstance(response_text, str):
        return None
    with _lock:
        turn = current(session_id, turn_id)
        if not turn:
            return None
        watch_root(turn, local_cwd(turn.task_id) or turn.cwd)
        budget = [time.monotonic(), 0]
        if turn.guess:
            for root, before in turn.scans.items():
                if root in turn.ambiguous or before is None:
                    continue
                after = snapshot(root, budget)
                if after is not None:
                    for path, stat in after.items():
                        if before.get(path) != stat:
                            turn.paths.setdefault(path, None)
        _turns.pop(scope(session_id), None)
    cwd = local_cwd(turn.task_id) or turn.cwd
    paths = dict.fromkeys([*turn.paths, *named_paths(response_text, cwd)])
    paths = [
        path for path in paths if path not in turn.uploads and fresh(path, turn.started)
    ]
    if not paths:
        return None
    managed = set(paths)
    if any(path.suffix.lower().lstrip(".") in DOCUMENTS for path in paths):
        paths = [
            path for path in paths if path.suffix.lower().lstrip(".") not in IMAGES
        ]
    from .paths import priority

    # 只移除本轮确认的独立 MEDIA 行再统一追加；旧文件、附件和未知标记不擅自改写。
    text = MEDIA.sub(
        lambda match: (
            "" if resolve_path(match.group(1), cwd) in managed else match.group()
        ),
        response_text,
    )
    linked = {resolve_path(match.group(1), cwd) for match in LINKS.finditer(text)}
    lines = [
        media_line(path) for path in sorted(paths, key=priority) if path not in linked
    ][:8]
    if not lines:
        return None
    rewritten = "\n\n".join(part for part in [text.rstrip(), "\n".join(lines)] if part)
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
    """原结果保留，成功下载才向模型补本地路径；每轮最多四次，网络不占状态锁。"""
    from .downloads import fetch, generator_urls

    try:
        data = json.loads(result) if isinstance(result, str) else result
    except ValueError:
        data = result
    if not completed(data, status, args):
        return None
    urls = generator_urls(tool_name, as_text(data))
    if not urls:
        return None
    with _lock:
        turn = current(session_id, turn_id)
        if turn is None:
            return None
        root = local_cwd(turn.task_id) or turn.cwd
        wanted = [url for url in urls if url not in turn.downloads][
            : max(0, 4 - len(turn.downloads))
        ]
        turn.downloads.update(dict.fromkeys(wanted))
    # 同批最多四个并行，避免顺序等待突破原生钩子的三十秒上限。
    saved = await asyncio.gather(*(fetch(url, root) for url in wanted))
    with _lock:
        if current(session_id, turn_id) is not turn:
            for path in saved:
                if path:
                    path.unlink(missing_ok=True)
            return None
        turn.downloads.update(zip(wanted, saved))
        paths = [turn.downloads[url] for url in urls if turn.downloads.get(url)]
        for path in paths:
            turn.paths[path] = None
    if not paths:
        return None
    if isinstance(data, dict):
        return json.dumps(
            {**data, "desktop_deliverables": [str(path) for path in paths]},
            ensure_ascii=False,
        )
    return str(result) + "\n\n已下载到本机：\n" + "\n".join(str(path) for path in paths)


def end_turn(*, session_id="", **kwargs):
    """取消、失败和会话结束都清除观察状态，不在下轮补旧文件。"""
    with _lock:
        _turns.pop(scope(session_id), None)


def register(ctx):
    """只使用现有原生钩子，不增加模型工具或修改 Hermes 核心。"""
    for name, handler in [
        ("pre_llm_call", before_turn),
        ("pre_tool_call", before_tool),
        ("post_tool_call", after_tool),
        ("transform_tool_result", download_result),
        ("transform_llm_output", transform),
        ("on_session_end", end_turn),
    ]:
        ctx.register_hook(name, handler)
