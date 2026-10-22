"""仅把桌面委派的翻译、播客和视频生成结果接入现有本机预览交付。"""

from collections import OrderedDict
import json

TOOLS = frozenset({"doc_translate", "ai_podcast_generate", "txt2vid_generate", "img2vid_generate"})
_children = OrderedDict()


def remember_child(*, parent_session_id="", child_session_id="", **kwargs):
    """创建子代理时记录桌面父会话的工作区，不改变其它来源的子代理。"""
    from . import _lock, _turns, scope

    with _lock:
        parent = _turns.get(scope(parent_session_id))
        if parent is None or parent.background or not child_session_id:
            return
        _children[scope(child_session_id)] = parent.cwd
        while len(_children) > 128:
            _children.popitem(last=False)


def child_root(session_id):
    """只返回由桌面主会话登记过的子任务目录。"""
    from . import _lock, scope

    with _lock:
        return _children.get(scope(session_id))


def forget_child(session_id):
    """按账号和会话清理子代理交付权限。"""
    from . import _lock, scope

    with _lock:
        _children.pop(scope(session_id), None)


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
