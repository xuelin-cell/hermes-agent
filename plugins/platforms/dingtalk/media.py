"""钉钉本地附件：有界读取、原生媒体上传和明确收件人投递。"""

import asyncio
from collections.abc import Awaitable, Callable
import json
import logging
import mimetypes
import os
from pathlib import Path, PureWindowsPath
from typing import Any

import httpx

from gateway.platforms.base import SendResult, validate_media_delivery_path

logger = logging.getLogger(__name__)

MAX_FILE_BYTES = 20_000_000
UPLOAD_URL = "https://oapi.dingtalk.com/media/upload"
DM_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
GROUP_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send"


class MediaError(ValueError):
    """只承载固定的安全说明，不携带平台原始正文、路径或凭据。"""


def _recipient(message: Any, chat_id: str) -> tuple[str, dict]:
    """只从本适配器的原始入站上下文取目标，拒绝猜测员工或群会话 ID。"""
    if message is None:
        raise MediaError("缺少钉钉收件上下文，请先从目标会话向机器人发送消息。")
    kind = str(getattr(message, "conversation_type", ""))
    conversation = getattr(message, "conversation_id", None)
    expected = conversation or (getattr(message, "sender_id", None) if kind == "1" else None)
    if not expected or chat_id != expected:
        raise MediaError("钉钉收件上下文与当前会话不一致，已取消附件发送。")
    if kind == "2":
        return GROUP_URL, {"openConversationId": conversation}
    staff_id = getattr(message, "sender_staff_id", None)
    if kind != "1" or not staff_id:
        raise MediaError("缺少钉钉单聊员工 ID 或会话类型，无法安全发送附件。")
    return DM_URL, {"userIds": [staff_id]}


def _read_file(file_path: str, file_name: str | None, image: bool) -> tuple[str, bytes, str]:
    """复用原版路径策略并限制读取大小，不执行、转换或改写原文件。"""
    safe = validate_media_delivery_path(file_path)
    if safe is None:
        raise MediaError("附件不存在、不是普通文件或被原版文件安全策略拒绝。")
    name = PureWindowsPath(file_name).name if file_name else Path(safe).name
    if not name or name in {".", ".."} or len(name) > 255 or any(ord(char) < 32 for char in name):
        raise MediaError("附件文件名无效，请使用正常的文件名。")
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    if image and not mime.startswith("image/"):
        raise MediaError("该文件不是可识别的图片格式，请通过文件入口发送。")
    if not image and not Path(name).suffix:
        raise MediaError("文件缺少扩展名，无法确定钉钉文件类型。")
    with Path(safe).open("rb") as stream:
        if os.fstat(stream.fileno()).st_size > MAX_FILE_BYTES:
            raise MediaError("附件超过本次钉钉上传上限 20 MB，请缩小文件后重试。")
        content = stream.read(MAX_FILE_BYTES + 1)
    if not content:
        raise MediaError("附件为空文件，无法发送。")
    if len(content) > MAX_FILE_BYTES:
        raise MediaError("附件超过本次钉钉上传上限 20 MB，请缩小文件后重试。")
    return name, content, mime


def _body(response: httpx.Response, stage: str) -> dict:
    """同时核对 HTTP 与业务错误；外部正文不进入返回值或日志。"""
    if response.status_code == 429:
        raise MediaError(f"钉钉{stage}被限流，请稍后再试。")
    if response.status_code in {401, 403}:
        raise MediaError(f"钉钉{stage}的身份或权限被拒绝，请检查机器人授权。")
    if response.status_code in {400, 404}:
        raise MediaError(f"钉钉{stage}请求或机器人不可用（HTTP {response.status_code}），请检查机器人权限、收件目标和文件格式。")
    if not 200 <= response.status_code < 300:
        raise MediaError(f"钉钉{stage}失败（HTTP {response.status_code}）。")
    try:
        body = response.json()
    except ValueError as exc:
        raise MediaError(f"钉钉{stage}返回了无法识别的响应。") from exc
    if not isinstance(body, dict):
        raise MediaError(f"钉钉{stage}返回了无法识别的响应。")
    if body.get("errcode", 0) not in (0, "0") or body.get("code") not in (None, "", 0, "0"):
        raise MediaError(f"钉钉{stage}被接口拒绝，请检查机器人权限、凭据和文件格式。")
    return body


async def send_local_media(client: httpx.AsyncClient, token_getter: Callable[[], Awaitable[str | None]],
                           robot_code: str, message: Any, chat_id: str, file_path: str,
                           *, image: bool, file_name: str | None = None) -> SendResult:
    """一次上传后一次投递；不跟随重定向、不自动重试、不冒充成功。"""
    try:
        endpoint, target = _recipient(message, chat_id)
        name, content, mime = await asyncio.to_thread(_read_file, file_path, file_name, image)
        token = await asyncio.wait_for(token_getter(), timeout=15.0)
        if not isinstance(token, str) or not token.strip() or not robot_code:
            raise MediaError("未取得当前钉钉机器人的有效凭据，附件未发送。")
        uploaded = _body(await client.post(
            UPLOAD_URL, params={"access_token": token, "type": "image" if image else "file"},
            files={"media": (name, content, mime)}, timeout=60.0, follow_redirects=False), "媒体上传")
        media_id = uploaded.get("media_id")
        if not isinstance(media_id, str) or not media_id.strip():
            raise MediaError("钉钉上传响应缺少媒体 ID，附件未投递。")
        params = {"photoURL": media_id} if image else {
            "mediaId": media_id, "fileName": name, "fileType": Path(name).suffix[1:].lower()}
        delivered = _body(await client.post(
            endpoint, headers={"x-acs-dingtalk-access-token": token},
            json={"robotCode": robot_code, "msgKey": "sampleImageMsg" if image else "sampleFile",
                  "msgParam": json.dumps(params, ensure_ascii=False), **target},
            timeout=20.0, follow_redirects=False), "附件投递")
        if delivered.get("invalidStaffIdList"):
            raise MediaError("钉钉拒绝了目标员工 ID，附件未完成投递。")
        if delivered.get("flowControlledStaffIdList"):
            raise MediaError("钉钉目标员工被限流，附件未完成投递。")
        receipt = delivered.get("processQueryKey")
        if not isinstance(receipt, str) or not receipt.strip():
            raise MediaError("钉钉未返回有效投递回执，请先检查目标会话，不要重复发送。")
        return SendResult(success=True, message_id=receipt)
    except MediaError as exc:
        error = str(exc)
    except (TimeoutError, httpx.TimeoutException):
        error = "钉钉附件请求超时，平台是否已接收尚不确定，请先检查目标会话，不要重复发送。"
    except httpx.RequestError:
        error = "钉钉附件请求发生网络错误，请检查连接及目标会话后再决定是否重试。"
    except OSError:
        error = "无法读取附件，请检查文件是否仍存在以及读取权限。"
    except Exception as exc:
        logger.warning("DingTalk media delivery failed (%s)", type(exc).__name__)
        error = "钉钉附件发送失败，请检查当前连接和机器人配置。"
    return SendResult(success=False, error=error)
