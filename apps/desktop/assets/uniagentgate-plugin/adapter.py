"""Bridge uag.agent.v1 into the normal Hermes gateway, without an agent loop."""

import asyncio
from collections import OrderedDict
from contextlib import suppress
import hashlib
import logging
from urllib.parse import urlsplit, urlunsplit

from gateway.config import Platform
from gateway.platforms._shared import get_scoped_secret
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType

logger = logging.getLogger(__name__)


def gateway_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("5G 网关地址必须是无凭据、查询参数及片段的 HTTP(S) 地址")
    return urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path.rstrip("/"), "", ""))


def check_requirements() -> bool:
    from importlib.util import find_spec
    return all(find_spec(name) is not None for name in ("httpx", "websockets"))


def validate_config(config) -> bool:
    extra = config.extra or {}
    try:
        gateway_url(extra.get("gateway_url", ""))
    except (ValueError, AttributeError):
        return False
    return bool(extra.get("agent_id") and get_scoped_secret("UNIAGENTGATE_AGENT_SK", ""))


class UniAgentGateAdapter(BasePlatformAdapter):
    def __init__(self, config):
        super().__init__(config=config, platform=Platform("uniagentgate"))
        self._client = None
        self._monitor_task = None
        self._contexts = OrderedDict()
        self._stopping = False
        self._bot_id = ""

    @property
    def name(self):
        return "5G 消息"

    @property
    def authorization_is_upstream(self) -> bool:
        """个人 Agent 的上行归属由已鉴权网关校验，sa_ 标识不是手机号白名单。"""
        return bool(self._client and self._client.health.state == "running" and not self._stopping)

    @staticmethod
    def normalize_user_id(value):
        value = str(value).strip()
        return value[3:] if value.startswith("+86") else value

    async def connect(self, *, is_reconnect=False) -> bool:
        """连接同时开放账号内控制；探测接口不会调用此主动操作。"""
        if getattr(self, "_control", None):
            await self._control.start(self)
        self._connecting = True
        try:
            return await self._connect()
        finally:
            self._connecting = False

    async def _connect(self) -> bool:
        """注册与握手成功后才报告在线。"""
        from .stream import UniAgentGateStreamClient

        if self._client is not None:
            return self._client.health.state == "running"
        if not validate_config(self.config):
            self._set_fatal_error("config_missing", "5G 个人绑定不完整，请重新登录", retryable=False)
            return False
        extra = self.config.extra
        url = gateway_url(extra["gateway_url"])
        self._bot_id = f"{url}\0{extra['agent_id']}"
        lock_id = hashlib.sha256(self._bot_id.encode()).hexdigest()
        if not self._acquire_platform_lock("uniagentgate", lock_id, "5G personal Agent"):
            return False
        self._stopping = False
        client = self._client = UniAgentGateStreamClient(
            url, extra["agent_id"], get_scoped_secret("UNIAGENTGATE_AGENT_SK", ""), self._inbound)
        client.health.on_change = self._health_changed
        await client.start()
        ready = asyncio.create_task(client.ready.wait())
        try:
            await asyncio.wait({ready, client._task}, timeout=45, return_when=asyncio.FIRST_COMPLETED)
        except BaseException:
            await self.disconnect()
            raise
        finally:
            ready.cancel()
            with suppress(asyncio.CancelledError):
                await ready
        if client.health.state != "running":
            error = client.health.last_error or "5G 网关连接超时"
            terminal = not client.is_alive
            await self.disconnect()
            self._set_fatal_error("connection_failed", error, retryable=not terminal)
            return False
        self._monitor_task = asyncio.create_task(self._monitor(client), name="uniagentgate-monitor")
        return True

    def _health_changed(self, state):
        if self._stopping:
            return
        if state == "running":
            self._mark_connected()
        elif state in {"degraded", "starting"}:
            self._write_runtime_status_safe("transport", platform_state="retrying", error_code=None,
                                            error_message=self._client.health.last_error or None)

    async def _monitor(self, client):
        try:
            await asyncio.shield(client._task)
        except asyncio.CancelledError:
            return
        except Exception:
            client.health.mark_failed("5G 网关连接异常终止")
        if not self._stopping:
            self._set_fatal_error("transport_stopped", client.health.last_error or "5G 连接已停止", retryable=False)
            # 协议接管/鉴权耗尽保持停止，由本平台控制入口恢复，避免关闭其它通道或整个网关。

    async def disconnect(self):
        self._stopping = True
        task, self._monitor_task = self._monitor_task, None
        if task and task is not asyncio.current_task():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        client, self._client = self._client, None
        if client:
            await client.stop()
        await self.cancel_background_tasks()
        self._contexts.clear()
        self._release_platform_lock()
        self._mark_disconnected()

    async def _inbound(self, raw, context):
        from .protocol import PROTOCOL_VERSION, message_ref

        ref = message_ref(raw.get("msgId"))
        if context.client is not self._client or not self.authorization_is_upstream:
            logger.warning("uniAgentGate inbound ignored: ref=%s reason=unverified_connection", ref)
            return
        phone = self.normalize_user_id(context.phone_number)
        text = raw["text"]["content"].strip()
        message_id = raw["msgId"]
        self._contexts[message_id] = context
        while len(self._contexts) > 2048:
            self._contexts.popitem(last=False)
        source = self.build_source(chat_id=phone, user_id=phone, chat_type="dm", message_id=message_id,
                                   scope_id=hashlib.sha256(self._bot_id.encode()).hexdigest()[:16])
        from .media import receive_files
        with self._media_delivery_scope(source):
            attachments = await receive_files(raw.get("fileUrls") or ([raw["fileUrl"]] if raw.get("fileUrl") else []))
        if not text and not attachments:
            if raw.get("fileUrl"):
                await self.send(phone, "附件下载失败，请重新发送。", reply_to=message_id)
            else:
                logger.warning("uniAgentGate inbound ignored: ref=%s reason=empty_text_or_attachment_only", ref)
            return
        # 文本类附件未被内联，让 Hermes 的标准附件处理器读取缓存路径。
        kinds = {"image": MessageType.PHOTO, "audio": MessageType.VOICE,
                 "video": MessageType.VIDEO, "document": MessageType.DOCUMENT}
        notes = "\n".join(item.context_note() for item in attachments)
        event = MessageEvent(text="\n".join(part for part in (text, notes) if part),
                             source=source, user_id=phone, message_id=message_id,
                             message_type=kinds[attachments[0].kind] if attachments else MessageType.TEXT,
                             media_urls=[item.path for item in attachments],
                             media_types=[item.media_type for item in attachments],
                             media_text_inlined=[False] * len(attachments),
                             metadata={"protocol_version": PROTOCOL_VERSION})
        logger.info("uniAgentGate dispatch to Hermes: ref=%s text_chars=%s attachment_count=%s",
                    ref, len(text), len(attachments))
        await self.handle_message(event)

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        from .protocol import message_ref

        if metadata and metadata.get("_interim_send"):
            return SendResult(success=True)  # No billable progress bubbles.
        ref = message_ref(reply_to)
        client = self._client
        if not client or client.health.state != "running":
            logger.warning("uniAgentGate reply blocked: ref=%s reason=not_connected", ref)
            return SendResult(success=False, error="5G WebSocket 未连接")
        context = self._contexts.get(reply_to) if reply_to else None
        if reply_to and context is None:
            logger.warning("uniAgentGate reply blocked: ref=%s reason=context_expired", ref)
            return SendResult(success=False, error="5G 回复上下文已失效，未发送")
        if context and (context.client is not client
                        or self.normalize_user_id(context.phone_number) != self.normalize_user_id(chat_id)):
            logger.warning("uniAgentGate reply blocked: ref=%s reason=owner_changed", ref)
            return SendResult(success=False, error="5G 回复归属已变更，未发送")
        logger.info("uniAgentGate reply sending: ref=%s text_chars=%s media_count=%s",
                    ref, len(content), len((metadata or {}).get("uniagentgate_media", [])))
        try:
            message_id, ack = await client.send_channel_message(
                phone_number=self.normalize_user_id(chat_id), text=self.format_message(content),
                session_id=context.session_id if context else "",
                turn_id=context.turn_id if context else "", media=(metadata or {}).get("uniagentgate_media"))
        except (RuntimeError, OSError) as exc:
            logger.warning("uniAgentGate reply unconfirmed: ref=%s error_type=%s", ref, type(exc).__name__)
            return SendResult(success=False, error="5G 下发未获确认，请检查网关状态（不会自动重复发送）")
        logger.info("uniAgentGate reply accepted: ref=%s downlink_ref=%s", ref, message_ref(message_id))
        return SendResult(success=True, message_id=message_id,
                          raw_response={"downlink_msg_ids": ack.downlink_msg_ids})

    async def _send_final_text(self, event, session_key, text_content, metadata,
                               is_ephemeral_response, ephemeral_ttl, record_delivery):
        """最终文字延至附件阶段，同一业务下行携带本轮所有可交付内容。"""
        event._uniagentgate_ephemeral = is_ephemeral_response

    async def _deliver_attachments(self, event, extracted, metadata, *, anything_sent, record_delivery):
        """复用 Hermes 本轮路径提取和投递账本，避免文字和每个文件分别计费。"""
        from .media import build_media

        paths = [path for path, _ in extracted.images]
        paths.extend(path for path, _ in extracted.media_files)
        paths.extend(extracted.local_files)
        with self._media_delivery_scope(event.source):
            media, links = await build_media(paths, self.config.extra.get("upload_server", "UniAI-Toolkit"))
        content = "\n\n".join(part for part in (extracted.text_content, "\n".join(links)) if part)
        if not content and not media:
            if paths:
                record_delivery(SendResult(success=False, error="5G 文件处理或上传失败"))
            return
        result, _ = await self.send_final_ledgered(
            event, self._event_session_key(event), content,
            {**(metadata or {}), "uniagentgate_media": media},
            reply_to=event.reply_anchor_override or event.message_id,
            is_ephemeral_response=getattr(event, "_uniagentgate_ephemeral", False))
        record_delivery(result)

    def _wants_auto_tts(self, *args, **kwargs):
        """只发送模型明确输出的音频产物，不额外生成单独计费的语音气泡。"""
        return False

    async def send_document(self, chat_id, file_path, caption=None, file_name=None,
                            reply_to=None, metadata=None, **kwargs):
        """发送工具等直接投递路径复用相同文件规则。"""
        from .media import build_media
        media, links = await build_media([file_path], self.config.extra.get("upload_server", "UniAI-Toolkit"))
        content = "\n\n".join(part for part in (caption, "\n".join(links)) if part)
        if not content and not media:
            return SendResult(success=False, error="5G 文件处理或上传失败")
        return await self.send(chat_id, content, reply_to=reply_to,
                               metadata={**(metadata or {}), "uniagentgate_media": media})

    async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None, **kwargs):
        """原生图片与其它产物共用上传路径。"""
        return await self.send_document(chat_id, image_url, caption, reply_to=reply_to, metadata=metadata)

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
        """音频沿用 WAV 转码与 RCS 白名单。"""
        return await self.send_document(chat_id, audio_path, caption, reply_to=reply_to, metadata=metadata)

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
        """视频沿用原生媒体大小规则。"""
        return await self.send_document(chat_id, video_path, caption, reply_to=reply_to, metadata=metadata)

    async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
        """本地图片的直接发送入口与 URL 图片使用同一规则。"""
        return await self.send_image(chat_id, image_path, caption, reply_to=reply_to, metadata=metadata)

    def _send_retry_is_final(self, result):
        # ACK loss is an unknown delivery outcome; plain-text fallback can double-bill.
        return not result.success

    def format_message(self, content):
        from gateway.platforms.helpers import strip_markdown
        return strip_markdown(content, keep_link_targets=True)

    async def send_typing(self, chat_id, metadata=None):
        pass  # The RCS protocol has no typing message.

    async def get_chat_info(self, chat_id):
        return {"name": "5G 联系人", "type": "dm", "chat_id": chat_id}
