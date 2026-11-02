"""为桌面四项生成任务及消息渠道的后台生成交付本机成品。"""

from collections import OrderedDict
import json

TOOLS = frozenset({"doc_translate", "ai_podcast_generate", "txt2vid_generate", "img2vid_generate"})
MESSAGE_TOOLS = frozenset({"doc_translate", "ai_podcast_generate"})
VIDEO_TOOLS = frozenset({"txt2vid_generate", "img2vid_generate"})
# 与桌面一样下载成品、以附件交付的消息平台；企业微信只含机器人模式（回调模式是 wecom_callback）。
# 其他平台保持原样：只缓存后台翻译、播客，链接保留。
DELIVERY_PLATFORMS = frozenset({"weixin", "feishu", "wecom", "dingtalk", "uniagentgate"})
_children = OrderedDict()
_message_parents = OrderedDict()
# (账号 Home, 父会话) -> {成品路径: 完成通知是否已带回}；补进回复后才删，每轮结束不清。
_results = OrderedDict()


def handles(platform, tool, child):
    """来源平台的这个生成工具是否由插件下载：钉钉没有发视频的接口，视频保持原样；子任务只管后台业务。"""
    if platform == "dingtalk" and tool in VIDEO_TOOLS:
        return False
    if not child:
        return True
    return tool in (TOOLS if platform == "desktop" or platform in DELIVERY_PLATFORMS else MESSAGE_TOOLS)


def remember_message_parent(*, session_id="", task_id="", platform="", **kwargs):
    """仅记消息父会话的本机目录和来源，不观察普通消息工具或注入桌面文件提醒。"""
    from gateway.config import Platform
    from . import _lock, scope, workspace

    try:
        source = Platform(platform)
    except ValueError:
        return
    if not session_id or source in {Platform.LOCAL, Platform.API_SERVER, Platform.WEBHOOK}:
        return
    cwd = workspace(task_id)
    if cwd is None:
        return
    with _lock:
        key = scope(session_id)
        _message_parents[key] = (cwd, platform)
        _message_parents.move_to_end(key)
        while len(_message_parents) > 128:
            _message_parents.popitem(last=False)


def remember_child(*, parent_session_id="", child_session_id="", **kwargs):
    """创建子代理时继承父会话的目录、来源平台和会话，不允许子代理递归认领。"""
    from . import _lock, _turns, scope

    with _lock:
        key = scope(parent_session_id)
        parent = _turns.get(key)
        if not child_session_id or (parent is not None and parent.background):
            return
        origin = (parent.cwd, parent.platform) if parent else _message_parents.get(key)
        if origin is None:
            return
        _children[scope(child_session_id)] = (*origin, key)
        while len(_children) > 128:
            _children.popitem(last=False)


def child_root(session_id):
    """只返回已登记父会话授权的子任务目录。"""
    origin = child_origin(session_id)
    return origin[0] if origin else None


def child_origin(session_id):
    """已登记父会话授权的子任务：(目录, 来源平台, 父会话键)，没有时为 None。"""
    from . import _lock, scope

    with _lock:
        return _children.get(scope(session_id))


def remember_results(session_id, paths):
    """子任务下载成功后记到父会话名下，由父会话回复时补出；其他消息平台保持原样不记。"""
    from . import _lock, scope

    with _lock:
        origin = _children.get(scope(session_id))
        if not origin or not paths or (origin[1] != "desktop" and origin[1] not in DELIVERY_PLATFORMS):
            return
        pending = _results.setdefault(origin[2], {})
        for path in paths:
            pending.setdefault(path, False)
        _results.move_to_end(origin[2])
        while len(_results) > 128:
            _results.popitem(last=False)


def mark_returned(key, text):
    """父会话收到的消息里出现成品路径（后台完成通知）才标记可补；没带回的不提前补，免得与完成那轮重复。"""
    from . import _lock

    with _lock:
        pending = _results.get(key) or {}
        for path in pending:
            if str(path) in text or path.as_posix() in text:
                pending[path] = True


def returned_results(key):
    """已带回、尚未补出且文件仍在的成品。"""
    from . import _lock

    with _lock:
        return [path for path, ready in (_results.get(key) or {}).items() if ready and path.is_file()]


def forget_results(key, paths):
    """成品已补进回复，或文件已经不在，就删掉记录。"""
    from . import _lock

    with _lock:
        pending = _results.get(key)
        if pending is None:
            return
        for path in [*paths, *(path for path in pending if not path.is_file())]:
            pending.pop(path, None)
        if not pending:
            _results.pop(key, None)


def forget_child(session_id):
    """按账号和会话清理子代理交付权限；父会话的待补成品不在这里清（每轮结束都会调用）。"""
    from . import _lock, scope

    with _lock:
        _children.pop(scope(session_id), None)
        _message_parents.pop(scope(session_id), None)


def managed_video(path):
    """影视后台下载由原生完成通知交付，目录扫描不能抢先或重复认领。"""
    if path.suffix.lower() not in {".mp4", ".mov", ".webm", ".m4v"}:
        return False
    meta = path.with_suffix(".meta.json")
    if not meta.is_file():
        return False
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
        return (
            isinstance(data, dict)
            and data.get("managed") is True
            and data.get("out") == str(path)
        )
    except (OSError, ValueError):
        # 元数据写入期间也不猜测成品；显式 MEDIA 交付仍由原生通知保留。
        return True
