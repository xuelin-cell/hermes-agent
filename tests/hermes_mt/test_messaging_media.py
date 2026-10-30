"""Media crosses real PG and instance WebSocket boundaries without extra PG tables."""
import asyncio
import importlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient,TestServer
from cryptography.fernet import Fernet
import pytest

from entry.app import build_app
from entry.channels_auth import instance_secret
from entry.channels_service import Channels
from entry.config import Settings
from entry.messaging_media_routes import media_link
from gateway.config import PlatformConfig,Platform
from gateway.platform_registry import PlatformEntry,platform_registry
from plugins.cloud_messaging.adapter import CloudMessagingAdapter
from plugins.cloud_messaging.media import pack,unpack,add_inbound


async def context(dsn,channel,user='alice'):
    settings=Settings(database_url=dsn,credential_key=Fernet.generate_key().decode(),backend='cube',channels_key='media-master',channels_relay_url='ws://placeholder')
    app=build_app(settings)
    entry=next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__=='login')
    app.on_startup.clear(); app.on_cleanup.clear()
    await entry.database.connect()
    await entry.store.finish_login(user_id=user,phone='',api_key='sk-fixture',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    await entry.messaging_routes.store.configure(user,'https://gateway.test','bot' if user=='alice' else 'bot-'+user,'secret',platform=channel,enable=True)
    binding=await entry.messaging_routes.store.binding(user,channel)
    await entry.store.ensure_tenant_token(user)
    epoch=await entry.store.next_epoch(user)
    delivery=await entry.messaging_routes.store.ingest(binding['id'],binding['revision'],'chat','external',{})
    await entry.messaging_routes.store.claim('lease-owner')
    async with entry.database.acquire() as db:
        await db.execute("UPDATE messaging_inbox SET state='accepted',instance_epoch=$2 WHERE delivery_id=$1",delivery,epoch)
    return settings,app,entry,binding,epoch,delivery


@pytest.mark.asyncio
@pytest.mark.parametrize('channel',['uniagentgate','dingtalk','feishu','weixin','wecom'])
async def test_large_media_roundtrip_is_durable_and_replay_safe(tmp_path,monkeypatch,postgres_database_url,channel):
    settings,app,entry,binding,epoch,delivery=await context(postgres_database_url,channel)
    import plugins.cloud_messaging.transport as passive
    monkeypatch.setattr(passive,'PORT',0)
    home=tmp_path/'home'; home.mkdir()
    monkeypatch.setenv('HERMES_HOME',str(home))
    monkeypatch.setenv('HERMES_RUNTIME_DIR',str(tmp_path/'runtime'))
    service=Channels(settings,{})
    service.database=entry.database; service.store=entry.messaging_routes.store
    platform_registry.register(PlatformEntry(name=channel,label=channel,adapter_factory=lambda config:None,check_fn=lambda:True))
    relay=web.Application(); relay.router.add_get('/relay',service.relay)
    accepted=asyncio.Event()
    errors=[]
    data=b'bounded-media-'+b'x'*(2*1024*1024)
    output=home/'output.txt'; output.write_bytes(data)
    adapter=None
    async def stop_adapter(app):
        if adapter: await asyncio.wait_for(adapter.disconnect(),5)
    relay.on_shutdown.append(stop_adapter)
    try:
        async with TestServer(relay) as server:
            adapter=CloudMessagingAdapter(PlatformConfig(enabled=True),{
                'platform':channel,'relay_url':str(server.make_url('/relay')).replace('http:','ws:'),
                'gateway_id':f'alice.{epoch}.{binding["revision"]}.{binding["id"]}',
                'upgrade_secret':instance_secret(settings.channels_key,'alice',epoch,binding['revision'],binding['id']),
                'bot_id':'bot','revision':binding['revision'],'binding_id':binding['id'],'user_id':'alice','instance_epoch':epoch},home)
            async def receive(event):
                try:
                    assert event.media_types==['text/plain']
                    assert Path(event.media_urls[0]).read_bytes()==data
                    assert Path(event.media_urls[0]).is_relative_to(home)
                    assert (await adapter.send_document('chat',str(output))).success
                    assert (await adapter.send_document('chat',str(output))).success
                    assert (await adapter.send('chat','final text')).success
                except Exception as error:
                    errors.append(error)
                finally: accepted.set()
            adapter.set_message_handler(receive)
            assert await adapter.connect()
            adapter._transport.open_admission()
            # Entry opens BOTH sockets; the adapter never calls a remote connect.
            class Tenant:
                token='instance-token'; traffic_token=''; host_header=''
                origin=''
            async def start(request):
                return web.json_response({'capability':passive.CAPABILITY})
            async def relay_instance(request):
                assert request.headers['X-MT-Token']=='instance-token'
                return await adapter._transport.accept(request)
            forward=web.Application()
            forward.router.add_post('/__mt/messaging/start',start)
            forward.router.add_get('/__mt/messaging/relay',relay_instance)
            forward_server=TestServer(forward)
            await forward_server.start_server()
            http=aiohttp.ClientSession()
            entry.http=http
            entry.s=replace(settings,channels_url=str(server.make_url('')).rstrip('/'))
            tenant=Tenant(); tenant.origin=str(forward_server.make_url('')).removeprefix('http://').rstrip('/')
            row=dict(binding, binding_id=binding['id'])
            worker=await entry.messaging_routes.relays.ensure(row,tenant,epoch)
            async with entry.database.acquire() as db:
                await db.execute('UPDATE messaging_inbox SET execution_ref=$2 WHERE delivery_id=$1',delivery,worker)
            event=add_inbound({'text':'read file','message_id':delivery,'source':{'platform':channel,'chat_id':'chat','user_id':'peer','scope_id':'alice','chat_type':'dm'}},[pack(data,'input.txt')])
            await service.send_frame(service.sockets['alice'][1],{'type':'inbound','bufferId':delivery,'event':event})
            await asyncio.wait_for(accepted.wait(),15)
            assert not errors,errors
            async with entry.database.acquire() as db:
                rows=await db.fetch('SELECT * FROM messaging_outbox ORDER BY part_index')
            assert len(rows)==2
            assert json.loads(rows[0]['payload'])=={'content':'final text'}
            media=json.loads(rows[1]['payload'])['media']
            assert unpack(media)==data
            # Replaying the final/attachment receipts cannot create another side effect.
            assert await entry.messaging_routes.store.record_media(delivery,'lease-owner',epoch,media)==rows[1]['outbound_id']
            assert not adapter.ledger.media_pending(binding['revision'],binding['id'])
            await asyncio.wait_for(adapter.disconnect(),5)
            adapter=None
    finally:
        await entry.messaging_routes.relays.close()
        if 'http' in locals(): await http.close()
        if 'forward_server' in locals(): await forward_server.close()
        if adapter:
            await asyncio.wait_for(adapter.disconnect(),5)
        await entry.database.close()


@pytest.mark.asyncio
async def test_5g_file_link_is_single_attachment_expiring_and_revocable(postgres_database_url):
    settings,app,entry,binding,epoch,delivery=await context(postgres_database_url,'uniagentgate')
    service=Channels(settings,{})
    service.database=entry.database; service.store=entry.messaging_routes.store
    item=pack(b'private-file','report.txt')
    outbound=await service.store.record_media(delivery,'lease-owner',epoch,item)
    async with entry.database.acquire() as db:
        await db.execute("UPDATE messaging_outbox SET state='sending' WHERE outbound_id=$1",outbound)
    channels=web.Application(); channels.router.add_get('/media/{id}',service.media)
    try:
        async with TestServer(channels) as server, aiohttp.ClientSession() as http, TestClient(TestServer(app)) as client:
            entry.http=http
            entry.s=replace(settings,channels_url=str(server.make_url('')).rstrip('/'),channels_relay_url=str(client.make_url('/hermes/__entry/messaging/relay')).replace('http:','ws:'))
            url=media_link(entry.s,outbound)
            async with http.get(url) as response:
                assert response.status==200 and await response.read()==b'private-file'
                assert response.headers['Content-Disposition'].startswith('attachment;')
            assert (await http.get(url.replace('s=','s=x'))).status==401
            assert (await http.get(str(server.make_url('/media/'+outbound)))).status==401
            await service.store.set_enabled('alice',False,remove=True)
            assert (await http.get(url)).status==404
    finally:
        await entry.database.close()
