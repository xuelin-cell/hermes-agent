"""按桌面账号固定的工作根路由本机消息与定时任务。"""
import json
import logging
import re
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from hermes_constants import get_default_hermes_root

IM = frozenset("weixin feishu wecom wecom_callback dingtalk uniagentgate telegram discord whatsapp "
               "whatsapp_cloud slack signal mattermost matrix email sms bluebubbles qqbot yuanbao".split())
_assigned = OrderedDict()
_lock = Lock()
_cwd_line = re.compile(r"(?m)^Current working directory: .*$")
_log = logging.getLogger(__name__)


def route(*, platform="", task_id="", **_):
    """每个本机任务首次进入对应目录，以后保留工具切换过的目录。"""
    if not task_id or (platform not in IM and platform not in ("cron", "subagent")):
        return
    from tools.terminal_tool import (
        _get_env_config, clear_task_env_overrides, get_session_cwd, register_task_env_overrides,
    )
    if _get_env_config().get("env_type") != "local":
        return
    with _lock:
        folder = _assigned.get(task_id)
        if platform == "subagent":
            inherited = get_session_cwd(task_id)
            if not inherited or Path(inherited) not in _assigned.values():
                return
            folder = Path(inherited)
        elif folder:
            try:
                folder.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                _log.warning("工作目录不可用: %s", exc)
                return
        else:
            if platform == "cron" and get_session_cwd(task_id):
                return
            try:
                config = json.loads((get_default_hermes_root() / "desktop-work-root.json").read_text("utf-8"))
                roots = [config["root"], config["fallback"]]
                if not all(isinstance(root, str) and Path(root).is_absolute() for root in roots):
                    return
            except (OSError, ValueError, KeyError, TypeError):
                return
            for root in dict.fromkeys(roots):
                folder = Path(root) / ("cron" if platform == "cron" else "IM")
                try:
                    (folder / ".tmp").mkdir(parents=True, exist_ok=True)
                    break
                except (OSError, ValueError) as exc:
                    _log.warning("无法创建工作目录: %s", exc)
            else:
                return
            register_task_env_overrides(task_id, {"cwd": str(folder), "cwd_source": "session"})
        _assigned[task_id] = folder
        _assigned.move_to_end(task_id)
        if len(_assigned) > 512:
            expired, _ = _assigned.popitem(last=False)
            clear_task_env_overrides(expired)
    if platform == "cron":
        return {"context": f"本轮工作目录：{folder}。这个文件夹由所有定时任务共用。草稿、数据、脚本等中间文件放到 "
                           f"{folder / '.tmp'}（没有就新建）。成品放工作目录，文件名带上任务名和日期，避免盖掉之前的结果。"}
    if platform in IM:
        # 消息的 before_turn 仅登记下载，提前返回；在此复用同一条草稿提醒。
        from . import scratch_reminder
        return {"context": scratch_reminder(folder)}


def rewrite_prompt(request, task_id):
    """仅替换请求里的系统工作目录行，保留原请求和用户正文。"""
    with _lock:
        folder = _assigned.get(task_id)
    if not folder or not isinstance(request, dict):
        return None
    line = f"Current working directory: {folder}"

    def rewrite(content):
        """保留内容块的类型和其它字段，仅处理文本。"""
        if isinstance(content, str):
            return _cwd_line.sub(lambda _: line, content)
        if isinstance(content, list):
            return [{**part, "text": rewrite(part["text"])} if isinstance(part, dict)
                    and isinstance(part.get("text"), str) else part for part in content]
        return content

    result = dict(request)
    for key in ("instructions", "system"):
        if key in request:
            result[key] = rewrite(request[key])
    messages = request.get("messages")
    if isinstance(messages, list):
        for i, msg in enumerate(messages):
            if isinstance(msg, dict) and msg.get("role") in ("developer", "system") and "content" in msg:
                result["messages"] = [*messages[:i], {**msg, "content": rewrite(msg["content"])}, *messages[i+1:]]
                break
    return result if result != request else None
