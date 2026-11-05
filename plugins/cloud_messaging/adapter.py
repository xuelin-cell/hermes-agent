"""Thin persistent execution boundary over Hermes' existing relay adapter/transport."""
import asyncio
import functools
import json
import logging
import mimetypes
from contextvars import ContextVar
from pathlib import Path
from gateway.config import Platform
from gateway.platforms.base import SendResult
from gateway.platforms.event import ProcessingOutcome
from gateway.relay.adapter import RelayAdapter
from gateway.relay.descriptor import CapabilityDescriptor
from .transport import AcceptedRelayTransport

from .ledger import Ledger
from .media import pack,localize,attachment_limit

log = logging.getLogger(__name__)
MEDIA_WARNING = '⚠️ 部分附件未能发送或发送结果未确认，请在网页会话中查看。'


class CloudMessagingAdapter(RelayAdapter):
    def __init__(self, config, settings, home):
        self.channel = settings.get('platform','uniagentgate')
        descriptor = CapabilityDescriptor(1,self.channel,self.channel,20000,False,False,False,'plain','chars',supported_ops=('send','send_media'))
        ledger = Ledger(home)
        transport = AcceptedRelayTransport(settings, descriptor, ledger)
        super().__init__(config,descriptor,transport)
        self.platform = Platform(self.channel)
        self.settings = settings
        self.ledger = ledger
        self._delivery = ContextVar("cloud_delivery",default=None)
        self.home=home
        self.current_delivery = None
        self.receipts_task = None
        self._final_text = {}

    async def _on_inbound(self, event):
        if event.media_urls: localize(event,self.home)
        delivery, chat = event.message_id, event.source.chat_id
        old = self.ledger.get(delivery)
        if old:
            return
        if self.current_delivery and self.ledger.get(self.current_delivery)['state'] != 'completed':
            raise RuntimeError('Another delivery is still active')
        if not self.ledger.accept(delivery,chat,self.settings['revision'],self.settings.get('binding_id','')): return
        self.current_delivery = delivery
        self._delivery.set(delivery)
        await super()._on_inbound(event)

    async def _publish(self, delivery, chat, content):
        result = await self._transport.send_outbound({'op':'send','chat_id':chat,'content':content,
            'metadata':{'delivery_id':delivery,'binding_revision':self.settings['revision'],'binding_id':self.settings.get('binding_id','')}},platform=self.channel)
        if result.get('success') is True: self.ledger.queued(delivery)
        return SendResult(success=result.get('success') is True,message_id=result.get('message_id'),error=result.get('error'))

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        if (metadata or {}).get('_interim_send'):
            return SendResult(success=True)
        delivery=self._delivery.get() or self.current_delivery
        if not delivery:
            return SendResult(success=False,error='No active delivery')
        receipt = self.ledger.get(delivery)
        if not receipt or receipt['chat_id'] != chat_id:
            return SendResult(success=False,error='Delivery route mismatch')
        with self._media_delivery_scope(self.build_source(chat_id=chat_id)):
            media_files,cleaned=self.extract_media(content)
            images,cleaned=self.extract_images(cleaned)
            local_files,cleaned=self.extract_local_files(cleaned)
            dropped = []
            paths=[(path,voice) for path,voice in self.filter_media_delivery_paths(media_files, dropped=dropped)]
            local_paths = self.filter_local_delivery_paths(local_files)
            paths.extend((path,False) for path in local_paths)
        failed = bool(dropped) or len(local_paths) < len(local_files)
        for image,alt in images:
            try:
                result=await self.send_image(chat_id,image,alt)
                failed = failed or not result.success
            except Exception as error:
                log.warning('Reply image preparation failed: %s', type(error).__name__)
                failed = True
        for path,voice in paths:
            mime=mimetypes.guess_type(path)[0] or ''
            kind='audio' if voice or mime.startswith('audio/') else 'image' if mime.startswith('image/') else 'video' if mime.startswith('video/') else 'file'
            try:
                result=await self._file(chat_id,path,kind)
                failed = failed or not result.success
            except Exception as error:
                log.warning('Reply attachment preparation failed: %s', type(error).__name__)
                failed = True
        content=cleaned
        if failed:
            content = (content.rstrip() + '\n\n' + MEDIA_WARNING).strip()
        try:
            self.ledger.complete(delivery,content)
        except ValueError:
            return SendResult(success=False,error='The final response is already frozen')
        return await self._publish(delivery,chat_id,content)

    # The base turn sends the final text first and its extracted attachments after it. Entry
    # completes the delivery on that text and closes the relay, so every attachment of the reply
    # then failed with "Relay disconnected" and the phone received the text alone. Entry bundles
    # media recorded before the closing text into the same downlink, so send the text last.
    async def _send_final_text(self, event, session_key, text_content, metadata,
                               is_ephemeral_response, ephemeral_ttl, record_delivery):
        self._final_text[event.message_id] = functools.partial(
            super()._send_final_text, event, session_key, text_content, metadata,
            is_ephemeral_response, ephemeral_ttl, record_delivery)

    async def _deliver_attachments(self, event, extracted, metadata, *, anything_sent, record_delivery):
        final_text = self._final_text.pop(event.message_id, None)
        try:
            await super()._deliver_attachments(event, extracted, metadata,
                                               anything_sent=anything_sent or final_text is not None,
                                               record_delivery=record_delivery)
        finally:
            if final_text is not None:
                await final_text()

    async def on_processing_complete(self, event, outcome):
        row = self.ledger.get(event.message_id)
        if row and row['result'] is None:
            media=self.ledger.delivered_media(event.message_id)
            pending = any(item['delivery_id'] == event.message_id for item in self.ledger.media_pending(
                self.settings['revision'], self.settings.get('binding_id','')))
            if pending and outcome==ProcessingOutcome.SUCCESS:
                content = MEDIA_WARNING
            elif media and outcome==ProcessingOutcome.SUCCESS:
                content='\n'.join(dict.fromkeys(item.get('caption','') for item in media if item.get('caption'))) or '附件已提交发送，请留意接收。'
            else:
                content='处理已结束，未收到可发送的结果，请在网页会话中查看。' if outcome==ProcessingOutcome.SUCCESS else '任务未能完成，请稍后重新发起。'
                if pending:
                    content += '\n' + MEDIA_WARNING
            self.ledger.complete(event.message_id,content)
            await self._publish(event.message_id,row['chat_id'],content)
        await super().on_processing_complete(event,outcome)

    async def connect(self, *, is_reconnect=False):
        ready = await super().connect(is_reconnect=is_reconnect)
        if ready:
            self.receipts_task = asyncio.create_task(self.replay_receipts())
        return ready

    async def disconnect(self):
        if self.receipts_task:
            self.receipts_task.cancel()
            await asyncio.gather(self.receipts_task,return_exceptions=True)
            self.receipts_task = None
        await super().disconnect()

    async def replay_receipts(self):
        while True:
            for row in self.ledger.pending(self.settings['revision'],self.settings.get('binding_id','')):
                await self._publish(row['delivery_id'],row['chat_id'],row['result'])
            for row in self.ledger.media_pending(self.settings['revision'],self.settings.get('binding_id','')):
                await self._publish_media(row['delivery_id'],row['chat_id'],json.loads(row['payload']))
            await asyncio.sleep(5)

    async def send_for_platform(self, logical_platform, chat_id, content, reply_to=None, metadata=None):
        if str(getattr(logical_platform,'value',logical_platform)) != self.channel:
            return SendResult(success=False,error='Unsupported platform')
        return await self.send(chat_id,content,reply_to,metadata)

    async def on_processing_start(self, event):
        self.ledger.running(event.message_id)
        await super().on_processing_start(event)

    async def _localize_inbound_media(self,event):
        # _on_inbound has already validated and materialized our bounded envelopes.
        return

    async def _publish_media(self,delivery,chat,media):
        result=await self._transport.send_outbound({'op':'send_media','chat_id':chat,'media':media,
            'metadata':{'delivery_id':delivery,'binding_revision':self.settings['revision'],'binding_id':self.settings.get('binding_id','')}},platform=self.channel)
        if result.get('success') is True: self.ledger.media_queued(delivery,media['id'])
        return SendResult(success=result.get('success') is True,message_id=result.get('message_id'),error=result.get('error'))

    async def _file(self,chat,path,kind,name=None,caption=None):
        from gateway.platforms.base import validate_media_delivery_path
        safe=validate_media_delivery_path(path)
        delivery=self._delivery.get() or self.current_delivery
        row=self.ledger.get(delivery) if delivery else None
        if not safe or not row or row['chat_id']!=chat: return SendResult(success=False,error='Invalid media delivery route or path')
        try:
            with Path(safe).open('rb') as stream: data=stream.read(attachment_limit(self.channel,kind)+1)
            media=pack(data,name or Path(safe).name,kind)
            if caption: media['caption']=str(caption)[:20000]
            self.ledger.media_accept(delivery,media)
            return await self._publish_media(delivery,chat,media)
        except (OSError,ValueError):
            return SendResult(success=False,error='Attachment is unavailable or exceeds the media limit')

    async def send_image_file(self,chat_id,image_path,caption=None,reply_to=None,metadata=None,**kwargs):
        return await self._file(chat_id,image_path,'image',caption=caption)

    async def send_document(self,chat_id,file_path,caption=None,file_name=None,reply_to=None,metadata=None,**kwargs):
        return await self._file(chat_id,file_path,'file',file_name,caption)

    async def send_voice(self,chat_id,audio_path,caption=None,reply_to=None,metadata=None,**kwargs):
        return await self._file(chat_id,audio_path,'audio',caption=caption)

    async def send_video(self,chat_id,video_path,caption=None,reply_to=None,metadata=None,**kwargs):
        return await self._file(chat_id,video_path,'video',caption=caption)

    async def send_image(self,chat_id,image_url,caption=None,reply_to=None,metadata=None,**kwargs):
        if image_url.startswith(('http://','https://')):
            from gateway.platforms.base import cache_image_from_url
            try:
                with self._media_delivery_scope(self.build_source(chat_id=chat_id)):
                    path=await cache_image_from_url(image_url,retries=0)
            except Exception:
                return SendResult(success=False,error='Image download failed')
        else: path=image_url.removeprefix('file://')
        return await self._file(chat_id,path,'image',caption=caption)
