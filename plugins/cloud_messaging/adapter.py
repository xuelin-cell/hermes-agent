"""Thin persistent execution boundary over Hermes' existing relay adapter/transport."""
import asyncio
from gateway.config import Platform
from gateway.platforms.base import SendResult
from gateway.relay.adapter import RelayAdapter
from gateway.relay.descriptor import CapabilityDescriptor
from gateway.relay.ws_transport import WebSocketRelayTransport

from .ledger import Ledger


class CloudMessagingAdapter(RelayAdapter):
    def __init__(self, config, settings, home):
        descriptor = CapabilityDescriptor(1,'uniagentgate','5G 消息',20000,False,False,False,'plain','chars',supported_ops=('send',))
        transport = WebSocketRelayTransport(settings['relay_url'],'uniagentgate',settings['bot_id'],
            gateway_id=settings['gateway_id'],upgrade_secret=settings['upgrade_secret'],reconnect=True)
        super().__init__(config,descriptor,transport)
        self.platform = Platform('uniagentgate')
        self.settings = settings
        self.ledger = Ledger(home)
        self.current_delivery = None
        self.receipts_task = None

    async def _on_inbound(self, event):
        delivery, chat = event.message_id, event.source.chat_id
        old = self.ledger.get(delivery)
        if old:
            return
        if self.current_delivery and self.ledger.get(self.current_delivery)['state'] != 'completed':
            raise RuntimeError('Another delivery is still active')
        if not self.ledger.accept(delivery,chat,self.settings['revision']): return
        self.current_delivery = delivery
        await super()._on_inbound(event)

    async def _publish(self, delivery, chat, content):
        result = await self._transport.send_outbound({'op':'send','chat_id':chat,'content':content,
            'metadata':{'delivery_id':delivery,'binding_revision':self.settings['revision']}},platform='uniagentgate')
        if result.get('success') is True: self.ledger.queued(delivery)
        return SendResult(success=result.get('success') is True,message_id=result.get('message_id'),error=result.get('error'))

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        if (metadata or {}).get('_interim_send'):
            return SendResult(success=True)
        if not self.current_delivery:
            return SendResult(success=False,error='No active delivery')
        receipt = self.ledger.get(self.current_delivery)
        if receipt['chat_id'] != chat_id:
            return SendResult(success=False,error='Delivery route mismatch')
        try:
            self.ledger.complete(self.current_delivery,content)
        except ValueError:
            return SendResult(success=False,error='The final response is already frozen')
        return await self._publish(self.current_delivery,chat_id,content)

    async def on_processing_complete(self, event, outcome):
        row = self.ledger.get(event.message_id)
        if row and row['result'] is None:
            self.ledger.complete(event.message_id,'任务未能完成，请稍后重新发起。')
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
            for row in self.ledger.pending(self.settings['revision']):
                await self._publish(row['delivery_id'],row['chat_id'],row['result'])
            await asyncio.sleep(5)

    async def send_for_platform(self, logical_platform, chat_id, content, reply_to=None, metadata=None):
        if str(getattr(logical_platform,'value',logical_platform)) != 'uniagentgate':
            return SendResult(success=False,error='Unsupported platform')
        return await self.send(chat_id,content,reply_to,metadata)

    async def on_processing_start(self, event):
        self.ledger.running(event.message_id)
        await super().on_processing_start(event)
