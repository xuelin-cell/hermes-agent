"""为桌面四项生成任务及消息渠道的翻译、播客交付本机成品。"""

from collections import OrderedDict
import json

TOOLS = frozenset({"doc_translate", "ai_podcast_generate", "txt2vid_generate", "img2vid_generate"})
MESSAGE_TOOLS = frozenset({"doc_translate", "ai_podcast_generate"})
_children = OrderedDict()
_message_parents = OrderedDict()


def remember_message_parent(*, session_id="", task_id="", platform="", **kwargs):
    """仅记消息父会话的本机目录，不观察普通消息工具或注入桌面文件提醒。"""
    from gateway.config import Platform
    from . import _lock, local_cwd, scope

    try:
        source = Platform(platform)
    except ValueError:
        return
    if not session_id or source in {Platform.LOCAL, Platform.API_SERVER, Platform.WEBHOOK}:
        return
    cwd = local_cwd(task_id)
    if cwd is None:
        return
    with _lock:
        key = scope(session_id)
        _message_parents[key] = cwd
        _message_parents.move_to_end(key)
        while len(_message_parents) > 128:
            _message_parents.popitem(last=False)


def remember_child(*, parent_session_id="", child_session_id="", **kwargs):
    """创建子代理时继承已登记父会话的目录与交付方式，不允许子代理递归认领。"""
    from . import _lock, _turns, scope

    with _lock:
        key = scope(parent_session_id)
        parent = _turns.get(key)
        message_root = _message_parents.get(key)
        if not child_session_id or (parent is not None and parent.background):
            return
        if parent is None and message_root is None:
            return
        _children[scope(child_session_id)] = (parent.cwd if parent else message_root, parent is None)
        while len(_children) > 128:
            _children.popitem(last=False)


def child_root(session_id):
    """只返回已登记父会话授权的子任务目录。"""
    from . import _lock, scope

    with _lock:
        origin = _children.get(scope(session_id))
        return origin[0] if origin else None


def message_child(session_id):
    """区分消息子任务与桌面预览，避免给消息渠道承诺桌面卡片。"""
    from . import _lock, scope

    with _lock:
        origin = _children.get(scope(session_id))
        return bool(origin and origin[1])


def forget_child(session_id):
    """按账号和会话清理子代理交付权限。"""
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
