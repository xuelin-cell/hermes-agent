"""观察本机桌面及已登记后台产物，通过原生输出钩子持久化文件引用。"""

from collections import OrderedDict
import asyncio
from dataclasses import dataclass, field
import json
from itertools import islice
from pathlib import Path
import re
from threading import RLock
import time

from . import background, interrupted
from .paths import (
    changed,
    DOCUMENTS,
    IMAGES,
    embedded,
    fresh,
    is_dir,
    mask_examples,
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
    declared: set = field(default_factory=set)
    paths: dict = field(default_factory=dict)
    pending: dict = field(default_factory=dict)
    scans: dict = field(default_factory=dict)
    roots: set = field(default_factory=set)
    ambiguous: set = field(default_factory=set)
    background: bool = False
    # 成品交给谁：desktop 出卡片，消息平台发附件；子任务沿用父会话的来源。
    platform: str = "desktop"
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


def workspace(task_id):
    """对话登记的工作目录；模型 cd 进 .tmp 后终端目录会变，它不变。没登记时用终端目录。"""
    root = local_cwd(task_id)
    if root is None:
        return None
    from tools.terminal_tool import resolve_task_overrides

    raw = resolve_task_overrides(task_id).get("cwd")
    chosen = resolve_path(raw, root) if isinstance(raw, str) and raw.strip() else None
    return chosen if chosen and is_dir(chosen) else root


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


def scratch_reminder(cwd):
    """每轮提醒模型把中间文件放进工作目录下的 .tmp；点开头的目录不补交付卡片。"""
    scratch = cwd / ".tmp"
    return (
        f"本轮工作目录：{cwd}。草稿、数据、脚本、下载的素材、临时图片等中间文件放到 {scratch}"
        "（没有就新建），装依赖也在这里装。只有交给用户的成品放在工作目录或用户指定的位置，"
        "每个成品在回复里单独一行写 `MEDIA:<绝对路径>`。"
        "如果技能要求脚本和成品放在同一目录，就在 .tmp 里做完，再把成品复制到工作目录。"
    )


def before_turn(
    *, session_id="", turn_id="", task_id="", platform="", user_message=None, **kwargs
):
    """本轮开始时固定本机目录和附件排除表，并提醒中间文件放哪；消息平台只登记下载，不观察目录。"""
    message = platform in background.DELIVERY_PLATFORMS
    if not session_id or not (message or platform in {"desktop", "subagent"}):
        return
    origin = background.child_origin(session_id) if platform == "subagent" else None
    if platform == "subagent" and origin is None:
        return
    cwd = origin[0] if origin else workspace(task_id)
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
            declared=set(named_paths(as_text(user_message), cwd)),
            background=platform == "subagent",
            platform=origin[1] if origin else platform,
            guess=platform == "desktop",
        )
        _turns.move_to_end(key)
        turn = _turns[key]
        while len(_turns) > 128:
            _turns.popitem(last=False)
        if turn.background:
            return
        # 后台完成通知带回的成品在本轮回复时补出；被打断就留到下一轮。
        background.mark_returned(key, as_text(user_message))
        if message:
            return
        budget = [time.monotonic(), 0]
        for root in requested_roots(as_text(user_message), cwd):
            watch_root(turn, root, budget)
    # 后台子任务只交付缓存成品，不加提醒；用户自选目录也提醒，.tmp 由模型按需新建。
    # 上一轮被关掉、用户这次发的是新消息时，先提醒模型别自行接着做旧任务。
    note = interrupted.begin(session_id, turn_id, user_message)
    return {"context": "\n\n".join(filter(None, [note, scratch_reminder(cwd)]))}


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
        # 消息会话不扫描目录，也就不会和桌面会话的目录重叠而作废桌面卡片。
        if not turn or turn.background or turn.platform != "desktop" or len(turn.pending) >= 64:
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
        if turn is None or turn.background or turn.platform != "desktop":
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
    if (
        platform not in {"desktop", "subagent", *background.DELIVERY_PLATFORMS}
        or not isinstance(response_text, str)
    ):
        return None
    key = scope(session_id)
    with _lock:
        turn = current(key, turn_id)
        if not turn or (platform == "subagent" and not turn.background):
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
    returned = [] if turn.background else background.returned_results(key)
    if turn.platform != "desktop" and not turn.background:
        return attach(key, turn, response_text, returned)
    cwd = turn.cwd if turn.background else local_cwd(turn.task_id) or turn.cwd
    roots = {*turn.roots, turn.cwd, cwd}
    masked = mask_examples(response_text)
    # 用户指定或最终回复明确交付的文件，不因 assets 等素材目录名漏卡。
    # 代码块里的路径不算交付声明；隐藏目录、附件和未完成文件仍走原有过滤。
    declared = turn.declared | set(named_paths(mask_examples(response_text, inline=False), cwd))
    # 子代理只交付两项工具已缓存的成品，其他子代理的普通回复不新增卡片。
    paths = dict.fromkeys(
        turn.paths if turn.background else [*turn.paths, *declared]
    )
    paths = [
        path
        for path in paths
        if path not in turn.uploads
        and not background.managed_video(path)
        and fresh(path, turn.started, roots, explicit=path in declared)
    ]
    # 后台带回的成品早于本轮生成，不按“本轮新建”判断。
    paths += [path for path in returned if path not in paths]
    if not paths:
        return None
    managed = set(paths)
    shown = shown_paths(masked, cwd)
    # 有文档时图片多是文档的素材；网页和 Markdown 报告只去掉它引用到的图片。
    # 元景生成的图片是成品本身，结果里已没有链接，不出卡用户就看不到。
    suffixes = {path.suffix.lower().lstrip(".") for path in paths}
    generated = {path for path in turn.downloads.values() if path} | set(returned)
    if suffixes & DOCUMENTS:
        materials = set(paths)
    else:
        reports = [
            path for path in paths if path.suffix.lower() in {".md", ".html", ".htm"}
        ]
        materials = set().union(*map(embedded, reports)) if suffixes & IMAGES else set()
    paths = [
        path
        for path in paths
        if path.suffix.lower().lstrip(".") not in IMAGES
        or path not in materials
        or path in generated
    ]
    from .paths import priority

    appended = [path for path in sorted(paths, key=priority) if path not in shown][:8]
    background.forget_results(key, [path for path in returned if path in appended or path in shown])
    moved = set(appended) | (managed & shown)
    # 只移走将追加或已有另一展示位置的独立行，未选中卡片不能被误删。
    text = remove_media_lines(response_text, masked, cwd, moved)
    return appended_reply(response_text, text, appended)


def appended_reply(response_text, text, appended):
    """把选中的成品逐行追加到回复末尾；与原回复相同时返回 None，表示不改。"""
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


def attach(key, turn, response_text, returned):
    """消息平台只补本轮下载和后台带回的成品，由网关作为附件发出；不猜目录里的其他文件。"""
    from gateway.platforms.base import MEDIA_TAG_CLEANUP_RE
    from .paths import MEDIA, priority

    paths = [
        path
        for path in dict.fromkeys([*filter(None, turn.downloads.values()), *returned])
        if path.is_file()
    ]
    if not paths:
        return None
    masked = mask_examples(response_text)
    # 句中的 MEDIA 标记网关也会照发；Markdown 链接在聊天里只是文字，不算已发送。
    inline = {
        resolve_path(match.group("path"), turn.cwd)
        for match in MEDIA_TAG_CLEANUP_RE.finditer(MEDIA.sub("", masked).replace(">", " "))
    }
    appended = [path for path in sorted(paths, key=priority) if path not in inline][:8]
    background.forget_results(key, [path for path in returned if path in appended or path in inline])
    # 模型自己写的独立行挪到末尾统一列出，同一文件不发两次。
    text = remove_media_lines(
        response_text, masked, turn.cwd, set(appended) | (set(paths) & inline)
    )
    return appended_reply(response_text, text, appended)


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
    from .uploads import remember_download

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
        if turn is None or not background.handles(
            turn.platform, tool_name.rsplit("__", 1)[-1], turn.background
        ):
            return None
        wanted = [url for url in urls if url not in turn.downloads][
            : max(0, 4 - len(turn.downloads))
        ]
        turn.downloads.update(dict.fromkeys(wanted))
    # 成品存进对话目录，不跟着终端 cd 进 .tmp，否则下载的图片视频不出卡。
    root = turn.cwd if turn.background else workspace(turn.task_id) or turn.cwd
    # 同批最多四个并行，避免顺序等待突破原生钩子的三十秒上限；描述参数用于起文件名。
    fetched = await asyncio.gather(
        *(fetch(url, root, tool_name, args) for url in wanted)
    )
    with _lock:
        active = current(key, turn_id) is turn
        if active:
            turn.downloads.update(zip(wanted, fetched))
            saved = {
                url: turn.downloads[url] for url in urls if turn.downloads.get(url)
            }
            for path in saved.values():
                turn.paths[path] = None
    if not active:
        for path in fetched:
            if path:
                path.unlink(missing_ok=True)
        return None
    # 再调用元景工具时可换回原链接；子任务的成品记到父会话，完成后由父会话补出。
    for url, path in zip(wanted, fetched):
        if path:
            remember_download(path, url)
    if turn.background:
        background.remember_results(session_id, list(saved.values()))
    missing = [url for url in urls if url not in saved]
    return annotate(result, data, root, saved, missing, platform=turn.platform)


def end_turn(*, session_id="", turn_id="", **kwargs):
    """取消、失败和会话结束都清除观察状态；迟到的旧轮结束事件不能清掉新一轮。"""
    background.forget_child(session_id)
    interrupted.finish(session_id, turn_id)
    key = scope(session_id)
    with _lock:
        turn = _turns.get(key)
        if turn and (not turn_id or turn.turn_id == turn_id):
            _turns.pop(key)


def rewrite_llm_request(*, request=None, **context):
    """llm_request 中间件：先改看图提示，再去掉思考深度档位。

    Hermes 给每个请求中间件的都是原始请求，后一个的结果会盖掉前一个，所以两步合在这里依次做。
    """
    from .image_hints import rewrite_request
    from .reasoning import strip_reasoning_levels

    reasons = []
    hinted = rewrite_request(request=request, **context)
    if hinted:
        request = hinted["request"]
        reasons.append(hinted.get("reason") or "image-hint")
    stripped = strip_reasoning_levels(request)
    if stripped is not None:
        request = stripped
        reasons.append("reasoning-default")
    if not reasons:
        return None
    return {"request": request, "source": "desktop-deliverables", "reason": "+".join(reasons)}


def register(ctx):
    """只使用现有原生钩子和中间件，不增加模型工具或修改 Hermes 核心。"""
    from .uploads import around_call, remember_session

    # 元景工具读不到本机文件：执行时替模型上传并换成 ossPath。
    ctx.register_middleware("tool_execution", around_call)
    # 看不到图的主模型：看图提示换成元景写法；所有模型的思考深度交给服务器默认。
    ctx.register_middleware("llm_request", rewrite_llm_request)
    for name, handler in [
        ("pre_llm_call", before_turn),
        ("pre_llm_call", background.remember_message_parent),
        ("pre_llm_call", remember_session),
        ("pre_tool_call", before_tool),
        ("post_tool_call", after_tool),
        ("transform_tool_result", download_result),
        ("transform_llm_output", transform),
        ("subagent_start", background.remember_child),
        ("on_session_end", end_turn),
    ]:
        ctx.register_hook(name, handler)
