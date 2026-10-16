"""使用 Hermes 原生钩子观测来源，来源未知时不授予公开发布资格。"""

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

from .bridge_client import call_bridge

_PENDING = {}
_LOCK = threading.Lock()
_SUFFIXES = {".html", ".htm", ".md", ".mdx", ".markdown"}
_ATTACHMENT = re.compile(r"\[(?:attached file|user attached|image attached|attached image)\b|@file:", re.I)


def _user_has_attachment(value) -> bool:
    """识别结构化附件及 Hermes 附件引用，不根据目录名判断来源。"""
    if isinstance(value, str):
        return bool(_ATTACHMENT.search(value))
    if isinstance(value, list):
        return any(_user_has_attachment(item) for item in value)
    if isinstance(value, dict):
        if value.get("type") in {"image_url", "image", "input_image", "input_file", "file", "document"}:
            return True
        if value.get("attachments"):
            return True
        return _user_has_attachment(value.get("content", value.get("text", "")))
    return False


def _event(session_id: str, kind: str, **payload) -> None:
    """在调用时读取所属 profile，避免模块级缓存默认账号路径。"""
    from hermes_constants import get_hermes_home

    if not payload.get("parentSessionId"):
        payload["parentSessionId"] = _lineage_parent(session_id)
    call_bridge("/origin", {
        "sessionId": session_id, "profileHome": str(get_hermes_home()), "type": kind, **payload,
    })


def _lineage_parent(session_id: str) -> str | None:
    """只读当前 profile 的会话关系，让压缩续接和委派继承上传限制；失败保持未知。"""
    from hermes_constants import get_hermes_home

    database = get_hermes_home() / "state.db"
    if not database.is_file():
        return None
    try:
        with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)) as connection:
            row = connection.execute("SELECT parent_session_id FROM sessions WHERE id = ?", (session_id,)).fetchone()
            return str(row[0]) if row and row[0] else None
    except sqlite3.Error:
        # 数据库损坏或暂时不可读时不认证新会话，不影响模型本身继续运行。
        return None


def before_turn(*, session_id="", platform="", user_message=None, conversation_history=None, is_first_turn=False, parent_session_id="", **kwargs):
    """在模型运行前登记上传事实，历史不完整的旧会话保持来源未知。"""
    if not session_id or platform != "desktop":
        return
    history = conversation_history or []
    uploaded = _user_has_attachment(user_message) or any(
        _user_has_attachment(message)
        for message in history if isinstance(message, dict) and message.get("role") == "user"
    )
    _event(session_id, "context", fresh=is_first_turn, hasUploads=uploaded, parentSessionId=parent_session_id)


def _cwd(task_id: str) -> Path | None:
    """只观测本地终端的真实工作目录，不把容器或远程路径当作本机文件。"""
    from tools.terminal_tool import _get_env_config, get_session_cwd

    if _get_env_config().get("env_type") != "local":
        return None
    cwd = get_session_cwd(task_id)
    return Path(cwd).resolve() if cwd and Path(cwd).is_dir() else None


def _snapshot(root: Path) -> dict | None:
    """有界枚举可分享文件，用前后差异归属同步终端创建的文件；超出预算则不认证。"""
    result = {}
    count = 0
    bytes_read = 0
    started = time.monotonic()
    for folder, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if not name.startswith(".") and not (Path(folder) / name).is_symlink()]
        count += len(directories) + len(files)
        if count > 4096 or time.monotonic() - started > 2:
            return None
        for name in files:
            file = Path(folder) / name
            if file.suffix.lower() in _SUFFIXES and not file.is_symlink() and file.is_file() and file.stat().st_size <= 2 * 1024 * 1024:
                bytes_read += file.stat().st_size
                if bytes_read > 16 * 1024 * 1024 or time.monotonic() - started > 2:
                    return None
                result[str(file.resolve())] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def _pending_key(session_id: str, task_id: str, tool_call_id: str) -> tuple:
    """把待处理快照绑定所属 profile，避免相同工具调用标识跨账号串用。"""
    from hermes_constants import get_hermes_home

    return (str(get_hermes_home()), session_id, task_id, tool_call_id)


def before_tool(*, tool_name="", args=None, session_id="", task_id="", tool_call_id="", **kwargs):
    """为同步终端记录工作区快照，后台命令不冒充可准确归属的产物创建事件。"""
    if tool_name != "terminal" or not session_id or not tool_call_id or (args or {}).get("background"):
        return
    root = _cwd(task_id)
    if root is None:
        return
    snapshot = _snapshot(root)
    if snapshot is not None:
        with _LOCK:
            if len(_PENDING) >= 128:
                _PENDING.clear()
            _PENDING[_pending_key(session_id, task_id, tool_call_id)] = (root, snapshot)


def after_tool(*, tool_name="", args=None, result=None, status="", session_id="", task_id="", tool_call_id="", **kwargs):
    """成功写入后登记真实字节摘要；局部修改不能把未知文件变成模型产物。"""
    with _LOCK:
        pending = _PENDING.pop(_pending_key(session_id, task_id, tool_call_id), None)
    if not session_id or status != "ok" or tool_name not in {"terminal", "write_file", "patch"}:
        return
    data = json.loads(result) if isinstance(result, str) else result
    if not isinstance(data, dict) or data.get("error") or data.get("status") in {"running", "background", "error"} or data.get("exit_code") not in (None, 0):
        return
    files = []
    if tool_name == "terminal":
        if pending is None or (args or {}).get("background") or data.get("session_id"):
            return
        root, before = pending
        after = _snapshot(root)
        if after is None:
            return
        files = [{"path": path, "hash": digest, "replace": path not in before}
                 for path, digest in after.items() if before.get(path) != digest]
    else:
        root = _cwd(task_id)
        if root is None:
            return
        paths = data.get("files_modified") or [data.get("resolved_path") or (args or {}).get("path")]
        for raw_path in paths:
            if not isinstance(raw_path, str):
                continue
            file = (root / raw_path).resolve()
            if file.suffix.lower() not in _SUFFIXES or not file.is_file() or file.stat().st_size > 2 * 1024 * 1024:
                continue
            content = file.read_bytes()
            if tool_name == "write_file" and content != (args or {}).get("content", "").encode("utf-8"):
                continue
            files.append({"path": str(file), "hash": hashlib.sha256(content).hexdigest(), "replace": tool_name == "write_file"})
    if files:
        _event(session_id, "files", files=files[:128])


def after_turn(*, session_id="", platform="", assistant_response=None, **kwargs):
    """仅登记完成回复中的 HTML 围栏正文，流式生成中的片段不提前授予分享资格。"""
    if not session_id or platform != "desktop" or not isinstance(assistant_response, str):
        return
    contents = []
    fence = None
    lines = []
    for line in assistant_response.splitlines():
        if fence is None:
            match = re.match(r"^ {0,3}(`{3,}|~{3,})(?:html|htm|xhtml)\s*$", line, re.I)
            if match:
                fence = match.group(1)
                lines = []
        elif re.fullmatch(r"\s*" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*", line):
            contents.append("\n".join(lines).strip())
            fence = None
        else:
            lines.append(line)
    if contents:
        _event(session_id, "inline", contents=contents[-24:])
