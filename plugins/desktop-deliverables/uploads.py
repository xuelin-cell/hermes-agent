"""元景工具读不到本机文件：调用前替模型把参数里的本机文件传到对象存储，换成 ossPath。

做法参考 UniWork 的 SandboxUploadMiddleware 与 postgresql-multitenant 的 pre_upload：
只在模型真的调用元景工具、参数里填了本机文件时才上传，用户不用元景就什么都不传；
只换 ossPath，不调 confirm_oss_upload，ossPath 不带签名、不会过期。
"""

from collections import OrderedDict
import json
import logging
import mimetypes
import re
from threading import RLock
import time
from urllib.parse import unquote, urlsplit

import httpx

from .paths import resolve_path

logger = logging.getLogger(__name__)
UPLOADER = "get_oss_upload_url"
OSS_TOOLS = {UPLOADER, "confirm_oss_upload"}
# 元景工具箱在不同版本里注册成这几个名字，与 uniwork-kits 的 media_slot 一致。
SERVERS = ("UniAI_Toolkit", "yuanjing", "1")
UPLOAD_PATH = "/app-agent-prod/temp/"
MAX_BYTES = 64 * 1024 * 1024
TIMEOUT = 120
CACHE_SECONDS = 24 * 3600
_REFERENCE = re.compile(
    r"(?<![\w/])@(?:file|image):(?:`([^`\n]+)`|\"([^\"\n]+)\"|'([^'\n]+)'|(\S+))"
)
_UPLOAD_URL = re.compile(r"上传地址[：:]\s*(https?://[^\s\"'\\]+)")
_CONTENT_TYPE = re.compile(r"Content-Type\s*[=:：]\s*([A-Za-z0-9._+/-]+)")
_OSS_PATH = re.compile(r"ossPath[^：:\n]{0,16}[：:]\s*\"?([A-Za-z0-9._/-]+)")
REMINDER = (
    "元景工具箱（UniAI-Toolkit）的工具需要文件时，文件参数直接填本机绝对路径"
    "（附件、当前工作目录里的文件都可以），桌面程序会在调用前自动上传并换成 ossPath。"
    "不要自己调用 get_oss_upload_url、confirm_oss_upload，也不要写代码上传。"
    "要看懂图片内容，用该工具箱的 analyze_image。"
)

_lock = RLock()
# (账号 Home, 会话) -> 会话里用户贴过的文件；(账号 Home, 路径, 修改时间, 大小) -> (ossPath, 时间)。
_sessions = OrderedDict()
_cache = OrderedDict()


class Refusal(Exception):
    """没能替模型上传：说明原因后拦下这次调用，不带着本机路径去调远程工具。"""


def has_tool(name):
    """按当前账号查注册表；多账号进程里只看得到本账号连上的工具。"""
    from tools.registry import registry

    return registry.get_entry(name) is not None


def call_tool(name, args):
    """与模型调用走同一个注册表入口，MCP 调用在它自己的事件循环上执行。"""
    from tools.registry import registry

    return registry.dispatch(name, args)


def session_key(session_id):
    """与交付物插件相同：账号 Home 加会话标识，不同账号的同名会话互不相通。"""
    from . import scope

    return scope(session_id)


def attachments_folder():
    """桌面上传的附件统一落在账号 Home 的 attachments 目录。"""
    from hermes_constants import get_hermes_home

    return get_hermes_home().resolve() / "attachments"


def working_folder(task_id):
    """本机终端的当前工作目录；容器或远程后端返回 None。"""
    from . import local_cwd

    return local_cwd(task_id)


def message_text(message):
    """取用户消息里的文字部分；多段内容只看文字段，不展开图片数据。"""
    content = message.get("content") if isinstance(message, dict) else message
    if isinstance(content, str):
        return content[:200_000]
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content[:64]
            if isinstance(part, (dict, str))
        )[:200_000]
    return ""


def referenced_files(text):
    """找出 @file:、@image: 引用的本机文件；带行号范围的去掉范围再认。"""
    found = set()
    for match in _REFERENCE.finditer(text):
        raw = next(value for value in match.groups() if value is not None)
        for value in (raw, re.sub(r":\d+(?:-\d+)?$", "", raw)):
            path = resolve_path(value, attachments_folder())
            if path is not None and path.is_absolute() and path.is_file():
                found.add(path)
                break
    return found


def remember_session(
    *, session_id="", user_message=None, conversation_history=None, **_
):
    """每轮开始时从本轮消息和会话历史收集贴过的文件，元景已连上时给模型加一句提醒。"""
    try:
        history = list(conversation_history or [])[-200:]
        texts = [message_text(user_message)] + [
            message_text(message)
            for message in history
            if isinstance(message, dict) and message.get("role") == "user"
        ]
        files = set()
        for text in texts:
            files |= referenced_files(text)
        key = session_key(session_id)
        with _lock:
            _sessions[key] = set(list(files)[:256])
            _sessions.move_to_end(key)
            while len(_sessions) > 64:
                _sessions.popitem(last=False)
        if any(has_tool(f"mcp__{server}__{UPLOADER}") for server in SERVERS):
            return {"context": REMINDER}
    except Exception:
        logger.warning("Upload reminder skipped", exc_info=True)
    return None


def allowed(path, session_id, cwd):
    """只自动上传附件、当前工作目录里的文件，以及本会话里用户贴过的文件。"""
    roots = [attachments_folder()] + ([cwd] if cwd else [])
    if any(path.is_relative_to(root) for root in roots):
        return True
    with _lock:
        return path in _sessions.get(session_key(session_id), set())


def result_text(raw):
    """MCP 结果是 {"result": 文本} 的 JSON；报错时抛出，交给调用方说明失败步骤。"""
    data = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw
    if isinstance(data, dict):
        if data.get("error"):
            raise ValueError("tool error")
        data = data.get("result", data.get("content", ""))
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    # 有的传输把换行转义成两个字符，先还原，避免链接把下一行吞进去。
    return text.replace("\\r\\n", "\n").replace("\\n", "\n")


def upload_target(text):
    """从上传工具的结果里取 PUT 地址、内容类型和 ossPath；地址必须在固定对象存储的临时目录。"""
    from .downloads import TRUSTED_HOST

    match = _UPLOAD_URL.search(text)
    if not match:
        raise ValueError("no upload url")
    url = match.group(1)
    parsed = urlsplit(url)
    path = unquote(parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.hostname != TRUSTED_HOST
        or parsed.username
        or parsed.password
        or not path.startswith(UPLOAD_PATH)
        or ".." in path.split("/")
    ):
        raise ValueError("untrusted upload url")
    named = _OSS_PATH.search(text)
    # 现在的服务端不单独返回 ossPath，按路径式地址取“桶/对象”这一段。
    oss_path = named.group(1) if named else path.lstrip("/")
    content_type = _CONTENT_TYPE.search(text)
    return url, oss_path, content_type.group(1) if content_type else None


def upload(prefix, path):
    """取上传地址、PUT 文件，返回 ossPath；失败时说明卡在哪一步，不记录签名链接。"""
    stage = "取上传地址"
    try:
        url, oss_path, content_type = upload_target(
            result_text(call_tool(prefix + UPLOADER, {"fileName": path.name}))
        )
        stage = "上传文件"
        content_type = (
            content_type
            or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream"
        )
        # Content-Type 签进了上传签名，必须与服务端给的一致。
        with (
            path.open("rb") as stream,
            httpx.Client(timeout=TIMEOUT, follow_redirects=False) as client,
        ):
            response = client.put(
                url, content=stream, headers={"Content-Type": content_type}
            )
            response.raise_for_status()
        return oss_path
    except Exception as exc:
        logger.info("Local file upload failed at %s (%s)", stage, type(exc).__name__)
        raise Refusal(
            f"本机文件 {path} 没能自动上传到元景（失败在“{stage}”这一步，{type(exc).__name__}），"
            "这次工具调用没有执行。可以稍后重试。"
        ) from None


def convert(prefix, value, session_id, cwd):
    """参数值是允许的本机文件就上传并返回 ossPath；不是本机文件返回 None，原样保留。"""
    if (
        not isinstance(value, str)
        or "\n" in value
        or len(value) > 1024
        or re.match(r"^(?:https?|data):", value, re.I)
    ):
        return None
    path = (
        resolve_path(value, cwd) if cwd else resolve_path(value, attachments_folder())
    )
    if path is None or not path.is_absolute() or not path.is_file():
        return None
    if not allowed(path, session_id, cwd):
        place = f"当前工作目录 {cwd}" if cwd else "当前工作目录"
        raise Refusal(
            f"本机文件 {path} 不在附件或{place}里，出于隐私没有自动上传，这次工具调用没有执行。"
            f"如果确实要用它，先把它复制到{place}，再用新路径调用。"
        )
    info = path.stat()
    if info.st_size > MAX_BYTES:
        raise Refusal(
            f"本机文件 {path} 超过 {MAX_BYTES // 1024 // 1024} MB，没有自动上传，这次工具调用没有执行。"
        )
    key = (str(attachments_folder()), str(path), info.st_mtime_ns, info.st_size)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[1] < CACHE_SECONDS:
            return hit[0]
    oss_path = upload(prefix, path)
    with _lock:
        _cache[key] = (oss_path, time.time())
        _cache.move_to_end(key)
        while len(_cache) > 256:
            _cache.popitem(last=False)
    return oss_path


def before_call(*, tool_name="", args=None, session_id="", task_id="", **_):
    """元景工具调用前把参数里的本机文件换成 ossPath；上传不了就拦下并说明原因。"""
    try:
        if not tool_name.startswith("mcp__") or not isinstance(args, dict):
            return None
        prefix, _, leaf = tool_name.rpartition("__")
        prefix += "__"
        # 只管带上传工具的远程服务器；本机 MCP 本来就能读本机路径，不能替换。
        if leaf in OSS_TOOLS or prefix == "mcp__" or not has_tool(prefix + UPLOADER):
            return None
        cwd = working_folder(task_id)
        changed = {}
        for name, value in args.items():
            if isinstance(value, list):
                items = [convert(prefix, item, session_id, cwd) for item in value[:16]]
                if any(items):
                    changed[name] = [
                        new or old for new, old in zip(items, value)
                    ] + value[16:]
            else:
                new = convert(prefix, value, session_id, cwd)
                if new:
                    changed[name] = new
        return {"action": "modify", "args": changed} if changed else None
    except Refusal as refusal:
        return {"action": "block", "message": str(refusal)}
    except Exception:
        # 自身出错不拦调用，退回原来的做法。
        logger.warning("Local file upload skipped", exc_info=True)
        return None
