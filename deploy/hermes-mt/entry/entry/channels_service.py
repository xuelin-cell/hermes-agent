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

from .channels_auth import verify_upgrade
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
                delivery = await self.store.claim(self.owner)
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
            rows = await db.fetch("SELECT b.* FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id WHERE u.status='active' AND b.enabled AND b.deleted_at IS NULL AND b.platform='uniagentgate'")
        wanted = {row['id']: row for row in rows}
        for key, (revision, client) in list(self.clients.items()):
            if key not in wanted or wanted[key]['revision'] != revision:
                await client.stop()
                async with self.database.acquire() as db:
                    user = await db.fetchval('SELECT user_id FROM messaging_bindings WHERE id=$1',key)
                socket = self.sockets.get(user)
                if socket and socket[2] == revision:
                    await socket[1].close(code=4401)
                self.clients.pop(key, None)
        for key, row in wanted.items():
            if key in self.clients: continue
            async def persist(envelope, binding=dict(row)):
                request = self.protocol.parse_agent_request(envelope)
                if not request or request.agent_id != binding['bot_key'] or not request.phone_number or not request.text or len(request.text)>20000 or any(item.type!='text' for item in request.inputs):
                    raise ValueError('Only authenticated text messages are supported')
                await self.store.ingest(binding['id'], binding['revision'], request.phone_number, request.message_id, envelope)
            async def accepted(raw, context): pass  # Admission already committed; execution is scheduled independently.
            client = self.stream.UniAgentGateStreamClient(json.loads(row['config'])['gateway_url'], row['bot_key'], self.store.cipher.decrypt(row['secret_enc']), accepted, persist_inbound=persist,capabilities=['text'])
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
        heartbeat = asyncio.create_task(self.maintain_lease(delivery['delivery_id']))
        try:
            async with asyncio.timeout(1800):
                await self.dispatch(delivery, heartbeat)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning('delivery requires reconciliation: %s', type(error).__name__)
            async with self.database.acquire() as db:
                # No inbound frame can leave before accepted is committed. A failed
                # wake is safe to retry; loss after that boundary remains uncertain.
                await db.execute("""UPDATE messaging_inbox SET
                    lease_owner=CASE WHEN state='dispatching' THEN NULL ELSE lease_owner END,
                    instance_epoch=CASE WHEN state='dispatching' THEN NULL ELSE instance_epoch END,
                    state=CASE WHEN state='dispatching' THEN 'queued' ELSE 'uncertain' END,
                    error_code='dispatch_unconfirmed',next_at=now()+interval '30 seconds',lease_until=NULL,updated_at=now()
                    WHERE delivery_id=$1 AND lease_owner=$2 AND state IN('dispatching','accepted','running')""",delivery['delivery_id'],self.owner)
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat,return_exceptions=True)

    async def dispatch(self, delivery, heartbeat):
        url = self.config['entry_url'].rstrip('/') + self.s.base_path + '/__entry/messaging/wake'
        async with self.http.post(url, json={'delivery_id':delivery['delivery_id'],'owner':self.owner},
                headers={'Authorization':'Bearer '+self.s.channels_key}, timeout=aiohttp.ClientTimeout(total=240)) as response:
            if response.status != 200: raise RuntimeError('Wake rejected')
            ready = await response.json()
        epoch = ready['epoch']
        async with self.database.acquire() as db:
            row = await db.fetchrow('SELECT i.*,b.bot_key FROM messaging_inbox i JOIN messaging_bindings b ON b.id=i.binding_id WHERE delivery_id=$1',delivery['delivery_id'])
            updated = await db.fetchval("UPDATE messaging_inbox SET state='accepted',instance_epoch=$2 WHERE delivery_id=$1 AND lease_owner=$3 AND state='dispatching' AND lease_until>now() RETURNING delivery_id",row['delivery_id'],epoch,self.owner)
        if not updated: raise RuntimeError('Lease lost before dispatch')
        request = self.protocol.parse_agent_request(json.loads(row['payload']))
        event = {'text':request.text,'message_id':row['delivery_id'],'source':{'platform':'uniagentgate','chat_id':request.phone_number,'user_id':request.phone_number,'chat_type':'dm','scope_id':delivery['user_id']},
                 'raw_message':{'delivery_id':row['delivery_id'],'binding_revision':row['binding_revision']}}
        sent_socket = None
        while not heartbeat.done():
            socket = self.sockets.get(delivery['user_id'])
            if socket and socket[0] == epoch and socket[1] is not sent_socket:
                await self.send_frame(socket[1],{'type':'inbound','bufferId':row['delivery_id'],'event':event})
                sent_socket = socket[1]
            await asyncio.sleep(1)
        await heartbeat

    async def send_pending(self):
        async with self.database.acquire() as db:
            rows = await db.fetch('''SELECT o.*,i.binding_id,i.payload AS inbound,b.enabled,b.revision,b.deleted_at FROM messaging_outbox o
                JOIN messaging_inbox i ON i.delivery_id=o.delivery_id JOIN messaging_bindings b ON b.id=i.binding_id
                JOIN users u ON u.user_id=b.user_id WHERE u.status='active' AND o.state='pending' ORDER BY o.created_at LIMIT 10''')
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
        request = self.protocol.parse_agent_request(json.loads(row['inbound']))
        receipt = None
        try:
            _, ack = await client[1].send_channel_message(phone_number=request.phone_number, text=json.loads(row['payload'])['content'],session_id=request.session_id,turn_id=request.turn_id,message_id=message_id)
            state, code = 'sent', ''
            receipt = {'ok':True,'downlink_msg_ids':ack.downlink_msg_ids}
        except self.stream.DownlinkRejected:
            state, code, receipt = 'failed', 'gateway_rejected', {'ok':False}
        except Exception:
            state, code = 'unknown', 'outbound_unconfirmed'
        async with self.database.acquire() as db:
            await db.execute('UPDATE messaging_outbox SET state=$2,error_code=$3,platform_ack=$4::jsonb,updated_at=now() WHERE outbound_id=$1 AND state=\'sending\'',row['outbound_id'],state,code,json.dumps(receipt))

    async def relay(self, request):
        auth = request.headers.get('Authorization', '').removeprefix('Bearer ')
        identity = verify_upgrade(auth, self.s.channels_key)
        if not identity: raise web.HTTPUnauthorized()
        user, epoch, revision = identity
        async with self.database.acquire() as db:
            current = await db.fetchval('SELECT state_epoch FROM tenant_runtime WHERE user_id=$1',user)
            binding = await db.fetchrow("SELECT b.* FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id WHERE b.user_id=$1 AND u.status='active' AND b.enabled AND b.deleted_at IS NULL",user)
        if current != epoch or not binding or binding['revision'] != revision: raise web.HTTPForbidden()
        old = self.sockets.get(user)
        if old: await old[1].close()
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.sockets[user] = (epoch, ws, revision)
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT: continue
                frame = json.loads(msg.data)
                if frame.get('type') == 'hello':
                    if frame.get('platform') != 'uniagentgate' or frame.get('botId') != binding['bot_key']:
                        await ws.close(code=4401); break
                    descriptor = {'contract_version':1,'platform':'uniagentgate','label':'5G 消息','max_message_length':20000,'supports_draft_streaming':False,'supports_edit':False,'supports_threads':False,'markdown_dialect':'plain','len_unit':'chars','supported_ops':['send'],'pii_safe':True}
                    await self.send_frame(ws,{'type':'descriptor','descriptor':descriptor})
                elif frame.get('type') == 'outbound':
                    action = frame.get('action') or {}
                    meta = action.get('metadata') or {}
                    if action.get('op') != 'send' or not isinstance(action.get('content'), str):
                        result = {'success':False,'error':'Unsupported text operation'}
                    else:
                        async with self.database.acquire() as db:
                            row = await db.fetchrow('SELECT * FROM messaging_inbox WHERE delivery_id=$1 AND user_id=$2',meta.get('delivery_id',''),user)
                            generation = await db.fetchval('SELECT state_epoch FROM tenant_runtime WHERE user_id=$1',user)
                        if not row or generation != epoch or meta.get('binding_revision') != revision or action.get('chat_id') != row['external_chat_id']:
                            raise web.HTTPForbidden()
                        outbound = await self.store.complete(row['delivery_id'], row['lease_owner'], epoch, {'content':action['content']})
                        result = {'success':True,'message_id':outbound}
                    await self.send_frame(ws,{'type':'outbound_result','requestId':frame['requestId'],'result':result})
                elif frame.get('type') == 'going_idle':
                    await self.send_frame(ws,{'type':'going_idle_ack'})
        finally:
            if self.sockets.get(user) == (epoch, ws, revision): self.sockets.pop(user,None)
        return ws


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
