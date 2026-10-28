"""Three-table durable messaging: real PG, HTTP, upstream and instance WebSockets."""
import asyncio
import importlib
import json
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.channels_auth import instance_secret, verify_upgrade
from entry.channels_service import Channels
from entry.config import Settings
from entry.crypto import CredentialCipher
from entry.db import Database
from entry.messaging_credentials import cloud_binding
from entry.messaging_store import MessagingStore
from entry.store import Store
from gateway.config import Platform, PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from gateway.relay.auth import make_upgrade_token
from plugins.cloud_messaging.adapter import CloudMessagingAdapter
from plugins.cloud_messaging.ledger import Ledger


async def wait_for(predicate, timeout=15):
    async with asyncio.timeout(timeout):
        while not await predicate():
            await asyncio.sleep(.02)


async def users(database, cipher):
    store = Store(database,cipher)
    for user in ('alice','bob'):
        await store.finish_login(user_id=user,phone='',api_key='model-'+user,endpoint=None,catalog=None,
            ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
        await store.ensure_tenant_token(user)
    return store


@pytest.mark.asyncio
async def test_binding_dedupe_leases_and_immutable_outbox(postgres_database_url):
    database = Database(postgres_database_url)
    cipher = CredentialCipher(Fernet.generate_key().decode())
    await database.connect()
    try:
        store = await users(database,cipher)
        messages = MessagingStore(database,cipher)
        binding = await messages.configure('alice','http://localhost','bot','private-sk')
        assert binding['secret_enc'] != b'private-sk'
        assert not binding['enabled']
        with pytest.raises(web.HTTPConflict):
            await messages.configure('bob','http://localhost','bot','other-sk')
        await messages.set_enabled('alice',True)
        binding = await messages.binding('alice')
        first = await messages.ingest(binding['id'],binding['revision'],'phone','external-1',{'text':'first'})
        assert await messages.ingest(binding['id'],binding['revision'],'phone','external-1',{}) == first
        await messages.ingest(binding['id'],binding['revision'],'phone','external-2',{})
        claims = await asyncio.gather(messages.claim('owner-a'),messages.claim('owner-b'))
        claim = next(row for row in claims if row)
        assert sum(row is not None for row in claims) == 1
        async with database.acquire() as db:
            await db.execute("UPDATE messaging_inbox SET state='accepted',instance_epoch=1 WHERE delivery_id=$1",first)
        from entry.tenants import TenantManager
        manager = TenantManager(Settings(backend='cube',channels_key='configured'),None,store,None,SimpleNamespace())
        # A real lifecycle lock and PG lease prevent pause before any Cube I/O.
        await manager.stop('alice',reason='idle')
        assert await manager._messaging_busy('alice')
        outbound = await messages.complete(first,claim['lease_owner'],1,{'content':'frozen answer'})
        assert await messages.complete(first,claim['lease_owner'],1,{'content':'frozen answer'}) == outbound
        with pytest.raises(web.HTTPConflict):
            await messages.complete(first,claim['lease_owner'],1,{'content':'changed answer'})
        async with database.acquire() as db:
            await db.execute("UPDATE messaging_outbox SET state='sending' WHERE outbound_id=$1",outbound)
        await messages.recover(startup=True)
        async with database.acquire() as db:
            assert await db.fetchval('SELECT state FROM messaging_outbox WHERE outbound_id=$1',outbound) == 'unknown'
        await messages.set_enabled('alice',False,remove=True)
        new = await messages.configure('bob','http://localhost','bot','other-sk')
        await messages.set_enabled('bob',True)
        new = await messages.binding('bob')
        assert await messages.ingest(new['id'],new['revision'],'phone','external-1',{}) == first
        assert not await messages.claim('owner-c')
        assert cloud_binding({'agentId':'personal','agentKey':'personal'}, {'http://localhost'})[0] == 'missing'
        assert cloud_binding({'ipUrl':'http://evil','agentIdCloud':'bot','agentKeyCloud':'sk'}, {'http://localhost'})[0] == 'invalid'
        assert cloud_binding({'uniagentgate':None}, set())[0] == 'clear'
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_text_roundtrip_ack_loss_and_instance_receipts(tmp_path, postgres_database_url, monkeypatch):
    settings = Settings(database_url=postgres_database_url,credential_key=Fernet.generate_key().decode(),
        channels_key='test-channels-master',backend='cube',channels_relay_url='ws://placeholder')
    app = build_app(settings)
    entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    await entry.database.connect()
    await users(entry.database,entry.store.cipher)
    epoch = await entry.store.next_epoch('alice')
    service = Channels(settings,{'entry_url':''})
    await service.database.connect()
    executions, downlinks = [], []
    peer, inbound_ack = asyncio.Queue(), asyncio.Queue()
    drop_ack = False
    async def register(request):
        assert request.headers['Authorization'] == 'Bearer cloud-sk'
        return web.json_response({'agent_id':'cloud-bot','session_token':'session','ttl_sec':600})
    async def upstream(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({'type':'connection.accepted','connection_id':'fixture','agent_id':'cloud-bot','payload':{'heartbeat_interval_sec':60}})
        await peer.put(ws)
        async for message in ws:
            frame = json.loads(message.data)
            if frame['type'] == 'ack':
                # ACK cannot precede the PG commit.
                async with entry.database.acquire() as db:
                    assert await db.fetchval('SELECT 1 FROM messaging_inbox WHERE external_message_id=$1',frame['in_reply_to'])
                await inbound_ack.put(frame)
            elif frame['type'] == 'channel.message.send':
                downlinks.append(frame)
                if not drop_ack:
                    await ws.send_json({'type':'ack','in_reply_to':frame['message_id'],'payload':{'ok':True}})
        return ws
    external = web.Application()
    external.router.add_post('/v1/agent-runtimes/register',register)
    external.router.add_get('/v1/agent-runtimes/connect',upstream)
    relay = web.Application()
    relay.router.add_get('/relay',service.relay)
    adapter = None
    async def ensure(user, touch=False):
        assert user == 'alice' and not touch
        return SimpleNamespace(token='instance-token',origin=forward_origin,host_header='',traffic_token='')
    async def start_instance(request):
        nonlocal adapter
        assert request.headers['X-MT-Token'] == 'instance-token'
        data = await request.json()
        assert 'cloud-sk' not in json.dumps(data)
        adapter = CloudMessagingAdapter(PlatformConfig(enabled=True),data,tmp_path)
        async def handle(event):
            executions.append((event.message_id,event.source.platform.value,event.source.chat_id))
            result = await adapter.send_for_platform(event.source.platform,event.source.chat_id,'answer: '+event.text)
            assert result.success
        adapter.set_message_handler(handle)
        assert await adapter.connect()
        return web.json_response({'ok':True})
    forward = web.Application()
    forward.router.add_post('/__mt/messaging/start',start_instance)
    async def stop_adapter(app):
        if adapter: await adapter.disconnect()
    async def stop_clients(app):
        await asyncio.gather(*(client.stop() for _,client in service.clients.values()))
    forward.on_shutdown.append(stop_adapter)
    external.on_shutdown.append(stop_clients)
    platform_registry.register(PlatformEntry(name='uniagentgate',label='5G',adapter_factory=lambda c:None,check_fn=lambda:True))
    try:
        async with TestServer(external) as upstream_server, TestServer(relay) as relay_server, TestServer(forward) as forward_server, aiohttp.ClientSession() as http:
            forward_origin = str(forward_server.make_url('')).removeprefix('http://').rstrip('/')
            entry.tenants = SimpleNamespace(ensure_running=ensure)
            entry.http, service.http = http, http
            # Frozen dataclass: replacement preserves all production defaults.
            from dataclasses import replace
            entry.s = replace(settings,channels_relay_url=str(relay_server.make_url('/relay')).replace('http://','ws://'))
            async with TestClient(TestServer(app)) as client:
                service.config['entry_url'] = str(client.make_url('')).rstrip('/')
                gateway = str(upstream_server.make_url('')).rstrip('/')
                entry.s = replace(entry.s,channels_gateway_origins=gateway)
                await entry.messaging_routes.apply_login('alice',{'ipUrl':gateway,'agentIdCloud':'cloud-bot','agentKeyCloud':'cloud-sk'})
                unauthorized = await client.post('/hermes/__entry/messaging/platforms',json={})
                assert unauthorized.status == 401
                auth = await entry.store.finish_login(user_id='alice',phone='',api_key='',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
                response = await client.post('/hermes/__entry/messaging/platforms',json={},headers={'Cookie':settings.cookie_name+'='+auth.session.sid})
                info = await response.json()
                assert [row['id'] for row in info['platforms']] == ['uniagentgate']
                assert info['platforms'][0]['configured'] and not info['platforms'][0]['enabled']
                assert 'cloud-sk' not in json.dumps(info)
                await service.store.set_enabled('alice',True)
                await service.reconcile()
                ws = await asyncio.wait_for(peer.get(),10)
                binding = await service.store.binding('alice')
                stream_client = service.clients[binding['id']][1]
                await asyncio.wait_for(stream_client.ready.wait(),10)
                def event(message):
                    return {'type':'agent.request','agent_id':'cloud-bot','message_id':message,
                        'channel':{'phone_number':'13800000000'},'ack':{'mode':'required'},
                        'session_id':'upstream-session','turn_id':'turn','payload':{'inputs':[{'type':'text','text':'hello'}]}}
                await ws.send_json(event('external-1'))
                await asyncio.wait_for(inbound_ack.get(),10)
                delivery = await service.store.claim(service.owner)
                task = asyncio.create_task(service.deliver(delivery))
                async def finished():
                    async with entry.database.acquire() as db:
                        return await db.fetchval("SELECT state='completed' FROM messaging_inbox WHERE delivery_id=$1",delivery['delivery_id'])
                await wait_for(finished)
                await service.send_pending()
                assert downlinks[0]['payload']['text'] == 'answer: hello'
                await ws.send_json(event('external-1'))
                await asyncio.wait_for(inbound_ack.get(),10)
                assert not await service.store.claim(service.owner)
                assert executions == [(delivery['delivery_id'],'uniagentgate','13800000000')]
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
                # A fresh adapter sees the persisted result, never executes that delivery again.
                receipt = Ledger(tmp_path).get(delivery['delivery_id'])
                assert receipt['result'] == 'answer: hello'
                drop_ack = True
                monkeypatch.setattr(service.stream,'ACK_WAIT_SECONDS',.1)
                await ws.send_json(event('external-2'))
                await asyncio.wait_for(inbound_ack.get(),10)
                second = await service.store.claim(service.owner)
                async with service.database.acquire() as db:
                    await db.execute("UPDATE messaging_inbox SET state='accepted',instance_epoch=$2 WHERE delivery_id=$1",second['delivery_id'],epoch)
                await service.store.complete(second['delivery_id'],service.owner,epoch,{'content':'exact second result'})
                await service.send_pending()
                await service.send_pending()
                async with service.database.acquire() as db:
                    row = await db.fetchrow('SELECT state,attempts FROM messaging_outbox WHERE delivery_id=$1',second['delivery_id'])
                    assert dict(row) == {'state':'unknown','attempts':1}
                assert len(downlinks) == 2
                # Entry restarts before dispatch are retryable without another agent turn.
                await ws.send_json(event('external-3'))
                await asyncio.wait_for(inbound_ack.get(),10)
                third = await service.store.claim(service.owner)
                unavailable = web.Application()
                async def restarting(request): raise web.HTTPServiceUnavailable()
                unavailable.router.add_post('/hermes/__entry/messaging/wake',restarting)
                async with TestServer(unavailable) as restarting_entry:
                    service.config['entry_url'] = str(restarting_entry.make_url('')).rstrip('/')
                    await service.deliver(third)
                async with service.database.acquire() as db:
                    retry = await db.fetchrow('SELECT state,lease_owner FROM messaging_inbox WHERE delivery_id=$1',third['delivery_id'])
                    assert dict(retry) == {'state':'queued','lease_owner':None}
                assert len(executions) == 1
                bad = make_upgrade_token(f'alice.{epoch}.{binding["revision"]+1}',instance_secret(settings.channels_key,'alice',epoch,binding['revision']+1))
                assert verify_upgrade(bad,settings.channels_key)[0] == 'alice'
                async with http.get(relay_server.make_url('/relay'),headers={'Authorization':'Bearer '+bad}) as response:
                    assert response.status == 403
    finally:
        if adapter: await adapter.disconnect()
        await asyncio.gather(*(client.stop() for _,client in service.clients.values()))
        await service.database.close()
        await entry.drive_routes.worker.close()
        await entry.database.close()
