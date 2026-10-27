"""记住桌面会话还没结束的一轮；程序被关掉后，下一条新消息提醒模型别自行接着做旧任务。"""

import json
from pathlib import Path
from threading import Lock

_lock = Lock()
_MAX_ENTRIES = 256
# 点 ▶ 续跑和 Hermes 自动续跑的说明都以这句开头，这两种本来就是要接着做。
CONTINUE_PREFIX = "[System note: Your previous turn was interrupted mid-run"
NOTE = (
    "上一轮没有正常结束（程序可能被关闭或中断），用户没有点“继续”，而是发来了下面这条新消息。"
    "按这条新消息的意思办：用户没有要求继续时，不要自行接着做上一轮没做完的任务。"
)


def _state_file():
    """每个账号或 Profile 各存一份，跟随 Hermes 当前的 HERMES_HOME。"""
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "desktop" / "deliverables-open-turns.json"


def _load(path):
    """文件缺失或损坏都当作没有记录，记录出错不能影响对话。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


def _store(path, entries):
    """原子写入；条目过多时只留最近的，防止文件无限增长。"""
    from utils import atomic_json_write

    if len(entries) > _MAX_ENTRIES:
        entries = dict(list(entries.items())[-_MAX_ENTRIES:])
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json_write(path, entries, indent=None)


def _text(message):
    """用户消息可能是多段内容，只取文字部分判断是不是续跑说明。"""
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        return "".join(
            part.get("text", "") for part in message if isinstance(part, dict)
        )
    return ""


def begin(session_id, turn_id, user_message):
    """登记本轮开始；上一轮还挂着说明它被中断了，这次又不是续跑说明时返回提醒文字。"""
    if not session_id or not turn_id:
        return None
    try:
        with _lock:
            path = _state_file()
            entries = _load(path)
            previous = entries.pop(session_id, None)
            entries[session_id] = turn_id
            _store(path, entries)
    except Exception:
        return None
    if not previous or previous == turn_id:
        return None
    return None if _text(user_message).lstrip().startswith(CONTINUE_PREFIX) else NOTE


def finish(session_id, turn_id):
    """本轮结束（完成、失败或被停止）就擦掉登记；迟到的旧轮结束事件不能擦掉新一轮。"""
    if not session_id:
        return
    try:
        with _lock:
            path = _state_file()
            entries = _load(path)
            if session_id not in entries or (turn_id and entries[session_id] != turn_id):
                return
            entries.pop(session_id)
            _store(path, entries)
    except Exception:
        return
