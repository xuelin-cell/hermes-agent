"""Single active channel connector: durable admission and conservative outbound ACKs."""
import asyncio
import importlib
import json
import logging
import secrets
from pathlib import Path

import aiohttp
import yaml
from aiohttp import web

from .channels_delivery import deliver
from .channel_dingtalk import DingTalk, ReplyRejected
from .channel_weixin import Weixin
from .channel_wecom import WeCom
from .channel_feishu import Feishu
from .channel_media import download,pack,add_inbound,MEDIA_UNAVAILABLE
from plugins.cloud_messaging.media import unpack
from .messaging_media_routes import media_link,media_response,MediaLinkUnavailable

TEXT_CLIENTS = {'dingtalk': DingTalk, 'weixin': Weixin, 'wecom': WeCom, 'feishu': Feishu}
from .config import Settings
from .crypto import CredentialCipher
from .db import Database
from .messaging_store import MessagingStore

log = logging.getLogger('channels')


class Channels:
    def __init__(self, settings, config):
        self.s, self.config = settings, config
        self.database = Database(settings.database_url)
        self.store = MessagingStore(self.database, CredentialCipher(settings.credential_key))
        self.clients, self.sockets, self.tasks = {}, {}, set()
        self.owner = secrets.token_hex(16)
        self.protocol = importlib.import_module('apps.desktop.assets.uniagentgate-plugin.protocol')
        self.stream = importlib.import_module('apps.desktop.assets.uniagentgate-plugin.stream')
        self.http = None
        self.leader = None
        self.sender = None

    async def start(self, app):
        await self.database.connect()
        self.http = aiohttp.ClientSession()
        # Dedicated lock connection: losing PG stops all external I/O, not just claims.
        import asyncpg
        self.leader = await asyncpg.connect(self.s.database_url)
        if not await self.leader.fetchval('SELECT pg_try_advisory_lock(629614209)'):
            raise RuntimeError('Another channels connector is active')
        await self.store.recover(startup=True)
        self.task = asyncio.create_task(self.run())

    async def close(self, app):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        for task in self.tasks: task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.gather(*(client.stop() for _, client in self.clients.values()), return_exceptions=True)
        await asyncio.gather(*(ws.close() for _, ws, _ in self.sockets.values()), return_exceptions=True)
        if self.leader: await self.leader.close()
        if self.http: await self.http.close()
        await self.database.close()

    async def run(self):
        while True:
            try:
                await self.leader.fetchval('SELECT 1')
                await self.reconcile()
                await self.store.recover()
                delivery = await self.store.claim_recovery(self.owner) or await self.store.claim(self.owner)
                if delivery:
                    task = asyncio.create_task(self.deliver(delivery))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                if self.sender and self.sender.done():
                    self.sender.result()
                if not self.sender or self.sender.done():
                    self.sender = asyncio.create_task(self.send_pending())
                    self.tasks.add(self.sender)
                    self.sender.add_done_callback(self.tasks.discard)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log.error('channels stopped after control failure: %s', type(error).__name__)
                # A DB outage is not permission to keep sending on old WebSockets.
                await asyncio.gather(*(client.stop() for _, client in self.clients.values()), return_exceptions=True)
                self.clients.clear()
                for task in self.tasks: task.cancel()
                await asyncio.gather(*(ws.close(code=1011) for _, ws, _ in self.sockets.values()),return_exceptions=True)
                raise
            await asyncio.sleep(1)

    async def reconcile(self):
        async with self.database.acquire() as db:
            rows = await db.fetch("SELECT b.* FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id WHERE u.status='active' AND b.enabled AND b.deleted_at IS NULL AND b.platform IN('uniagentgate','dingtalk','weixin','wecom','feishu')")
        wanted = {row['id']: row for row in rows}
        for key, (revision, client) in list(self.clients.items()):
            if key not in wanted or wanted[key]['revision'] != revision:
                await client.stop()
                async with self.database.acquire() as db:
                    user = await db.fetchval('SELECT user_id FROM messaging_bindings WHERE id=$1',key)
                socket = self.sockets.get(user)
                if socket and socket[2] == revision and getattr(socket[1],'binding_id',key)==key:
                    await socket[1].close(code=4401)
                self.clients.pop(key, None)
        for key, row in wanted.items():
            if key in self.clients: continue
            async def persist(envelope, binding=dict(row)):
                request = self.protocol.parse_agent_request(envelope)
                if not request or request.agent_id != binding['bot_key'] or not request.phone_number or (not request.text and not any(item.url for item in request.inputs)) or len(request.text)>20000 or any(item.type not in {'text','file_url','image_url','audio_url','video_url'} for item in request.inputs):
                    raise ValueError('Only authenticated text messages are supported')
                if await self.store.seen(binding['id'],binding['revision'],request.phone_number,request.message_id): return
                attachments=[]
                media_text=request.text
                for item in request.inputs:
                    if item.url:
                        try: data,mime=await download(self.http,item.url)
                        except ValueError:
                            media_text+='\n'+MEDIA_UNAVAILABLE
                            continue
                        from urllib.parse import urlsplit,unquote
                        from pathlib import Path
                        filename=unquote(Path(urlsplit(item.url).path).name) or 'attachment.bin'
                        kind='image' if mime.startswith('image/') else 'audio' if mime.startswith('audio/') else 'video' if mime.startswith('video/') else 'file'
                        try: attachments.append(pack(data,filename,kind,mime or None))
                        except ValueError: media_text+='\n'+MEDIA_UNAVAILABLE
                if attachments or media_text!=request.text:
                    envelope['_media_event']=add_inbound({'text':media_text,'source':{'platform':'uniagentgate','chat_id':request.phone_number,'user_id':request.phone_number,'chat_type':'dm'}},attachments)
                await self.store.ingest(binding['id'], binding['revision'], request.phone_number, request.message_id, envelope)
            async def accepted(raw, context): pass  # Admission already committed; execution is scheduled independently.
            client = TEXT_CLIENTS[row['platform']](row['bot_key'],self.store.cipher.decrypt(row['secret_enc']),self.store,dict(row),self.http) if row['platform'] in TEXT_CLIENTS else self.stream.UniAgentGateStreamClient(json.loads(row['config'])['gateway_url'], row['bot_key'], self.store.cipher.decrypt(row['secret_enc']), accepted, persist_inbound=persist,capabilities=['text'])
            self.clients[key] = (row['revision'], client)
            await client.start()
        for key, (revision, client) in self.clients.items():
            async with self.database.acquire() as db:
                await db.execute('UPDATE messaging_bindings SET connection_state=$3,updated_at=now() WHERE id=$1 AND revision=$2',key,revision,client.health.state)

    @staticmethod
    async def send_frame(ws, frame):
        # The existing Hermes transport consumes newline-delimited frames.
        await ws.send_str(json.dumps(frame, ensure_ascii=False) + '\n')

    async def maintain_lease(self, delivery):
        async with asyncio.timeout(1800):
            while await self.store.renew(delivery, self.owner):
                await asyncio.sleep(20)

    async def deliver(self, delivery):
        await deliver(self, delivery)

    async def send_pending(self):
        async with self.database.acquire() as db:
            rows = await db.fetch('''SELECT o.*,i.platform,i.binding_id,i.payload AS inbound,b.enabled,b.revision,b.deleted_at FROM messaging_outbox o
                JOIN messaging_inbox i ON i.delivery_id=o.delivery_id JOIN messaging_bindings b ON b.id=i.binding_id
                JOIN users u ON u.user_id=b.user_id WHERE u.status='active' AND o.state='pending' AND NOT EXISTS(SELECT 1 FROM messaging_outbox previous WHERE previous.delivery_id=o.delivery_id AND previous.state IN('pending','sending') AND (previous.created_at,previous.outbound_id)<(o.created_at,o.outbound_id)) ORDER BY o.created_at LIMIT 10''')
        await asyncio.gather(*(self.send_one(row) for row in rows))

    async def send_one(self, row):
        client = self.clients.get(row['binding_id'])
        if not client or client[0] != row['binding_revision'] or client[1].health.state != 'running': return
        message_id = 'msg_cms_' + row['outbound_id']
        async with self.database.acquire() as db:
            if not row['enabled'] or row['deleted_at'] or row['revision'] != row['binding_revision']:
                await db.execute("UPDATE messaging_outbox SET state='cancelled' WHERE outbound_id=$1 AND state='pending'",row['outbound_id'])
                return
            if not await db.fetchval("UPDATE messaging_outbox SET state='sending',attempts=attempts+1,platform_message_id=$2,updated_at=now() WHERE outbound_id=$1 AND state='pending' RETURNING outbound_id",row['outbound_id'],message_id): return
        payload=json.loads(row['inbound'])
        if payload.get('_cloud_notification') and 'reply_enc' in payload:
            context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
            context.update(uuid=row['outbound_id'],client_id=row['outbound_id'])
            payload['reply_enc']=self.store.cipher.encrypt(json.dumps(context)).decode()
        request=self.protocol.parse_agent_request(payload) if row['platform']=='uniagentgate' else None
        receipt = None
        try:
            content=json.loads(row['payload'])
            if 'media' not in content and not content.get('content'):
                receipt={'ok':True}
                state,code='sent',''
            elif row['platform'] in TEXT_CLIENTS:
                receipt=await client[1].send_media(payload,{**content['media'],'client_id':row['outbound_id']}) if 'media' in content else await client[1].send(payload,content['content'])
                state,code='sent',''
            else:
                media=[]
                text=content.get('content','')
                if 'media' in content:
                    item=content['media']
                    url=media_link(self.s,row['outbound_id'])
                    if item['kind'] in {'image','audio','video'}:
                        media=[{'url':url,'kind':item['kind'],'mime_type':item['mime'],'file_name':item['name']}]
                    else: text='📎 '+item['name']+' 下载链接：'+url
                _, ack = await client[1].send_channel_message(phone_number=request.phone_number, text=text,media=media,session_id=request.session_id,turn_id=request.turn_id,message_id=message_id)
                state, code = 'sent', ''
                receipt = {'ok':True,'downlink_msg_ids':ack.downlink_msg_ids}
        except MediaLinkUnavailable:
            state, code, receipt = 'failed', 'media_entry_unconfigured', {'ok':False}
        except (self.stream.DownlinkRejected,ReplyRejected):
            state, code, receipt = 'failed', 'gateway_rejected', {'ok':False}
        except Exception:
            state, code = 'unknown', 'outbound_unconfirmed'
        async with self.database.acquire() as db:
            await db.execute('UPDATE messaging_outbox SET state=$2,error_code=$3,platform_ack=$4::jsonb,updated_at=now() WHERE outbound_id=$1 AND state=\'sending\'',row['outbound_id'],state,code,json.dumps(receipt))

    async def media(self,request):
        import hmac
        token=request.headers.get('Authorization','').removeprefix('Bearer ')
        if not self.s.channels_key or not hmac.compare_digest(token.encode(),self.s.channels_key.encode()): raise web.HTTPUnauthorized()
        async with self.database.acquire() as db:
            row=await db.fetchrow("SELECT o.payload FROM messaging_outbox o JOIN messaging_inbox i USING(delivery_id) JOIN messaging_bindings b ON b.id=i.binding_id JOIN users u ON u.user_id=b.user_id WHERE o.outbound_id=$1 AND u.status='active' AND b.enabled AND b.deleted_at IS NULL AND b.revision=o.binding_revision AND o.state IN('sending','sent','unknown')",request.match_info['id'])
        if not row: raise web.HTTPNotFound()
        return media_response(json.loads(row['payload'])['media'])

    async def relay(self, request):
        from .channels_relay import relay
        return await relay(self,request)


def main():
    import sys
    settings = Settings()
    if not settings.channels_key: raise RuntimeError('MT_CHANNELS_KEY required')
    config = yaml.safe_load(Path(sys.argv[1]).read_text())
    service = Channels(settings, config)
    app = web.Application()
    async def health(request):
        if not hasattr(service,'task') or service.task.done(): raise web.HTTPServiceUnavailable()
        return web.json_response({'ok':True})
    app.router.add_get('/health', health)
    app.router.add_get('/relay', service.relay)
    app.router.add_get('/media/{id}', service.media)
    app.on_startup.append(service.start)
    async def supervise(app):
        def stopped(task):
            if not task.cancelled():
                task.exception()
                raise web.GracefulExit()
        service.task.add_done_callback(stopped)
    app.on_startup.append(supervise)
    app.on_cleanup.append(service.close)
    web.run_app(app, port=int(config.get('port',9500)))


if __name__ == '__main__': main()
