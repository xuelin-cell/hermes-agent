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
    outgoing=b'x'*(31*1024*1024) if channel=='uniagentgate' else data
    output=home/'output.txt'; output.write_bytes(outgoing)
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
            assert unpack(media)==outgoing
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


@pytest.mark.asyncio
@pytest.mark.parametrize('extension',['png','webp','pdf'])
async def test_5g_oss_public_links_use_owner_credentials_and_real_upload_before_downlink(postgres_database_url,extension):
    settings,app,entry,binding,epoch,delivery=await context(postgres_database_url,'uniagentgate')
    await entry.store.finish_login(user_id='bob',phone='',api_key='sk-bob',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    uploads=[]; confirms=[]; downlinks=[]; tools=[]
    public_host=["obs-nmhhht6.cucloud.cn"]
    upstream=web.Application(client_max_size=65*1024*1024)
    async def mcp(request):
        body=await request.json()
        if body['method'].startswith('notifications/'):
            return web.Response(status=202)
        if body['method']=='initialize':
            result={'protocolVersion':body['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'oss','version':'1'}}
        elif body['method']=='tools/list':
            result={'tools':[{'name':name,'inputSchema':{'type':'object'}} for name in ('get_oss_upload_url','confirm_oss_upload')]}
        else:
            params=body['params']; tools.append((request.query['key'],params))
            if params['name']=='get_oss_upload_url' and request.query['key']=='sk-bob':
                result={'content':[], 'structuredContent':{'uploadUrl':'http://obs-nmhhht6-internal.cucloud.cn/app-agent-prod/test/object','ossPath':'app-agent-prod/test/object','headers':{'Content-Type':'image/png'}}}
            elif params['name']=='get_oss_upload_url':
                result={'content':[{'type':'text','text':'上传地址：https://obs-nmhhht6.cucloud.cn/app-agent-prod/test/object\nossPath（确认上传时需传入）：app-agent-prod/test/object\n下载链接：https://obs-nmhhht6-internal.cucloud.cn/app-agent-prod/test/object'}]}
            else:
                assert params['name']=='confirm_oss_upload' and params['arguments']['usePublic'] is True
                confirms.append(request.query['key'])
                result={'content':[{'type':'text','text':'下载链接：https://'+public_host[0]+'/app-agent-prod/test/object?X-Amz-Expires=604800'}]}
        return web.json_response({'jsonrpc':'2.0','id':body['id'],'result':result})
    async def put(request):
        uploads.append(await request.read())
        assert 'Authorization' not in request.headers
        return web.Response(status=200)
    async def gateway(request):
        downlinks.append(await request.json())
        return web.json_response({'ok':True})
    upstream.router.add_post('/mcp',mcp)
    upstream.router.add_put('/upload',put)
    upstream.router.add_post('/gateway',gateway)
    filename='cat.'+extension
    raw=b'large-report-' + b'x'*(31*1024*1024) if extension=='pdf' else b'private-image'
    item=pack(raw,filename,'file' if extension=='pdf' else 'image')
    await entry.messaging_routes.store.complete(delivery,'lease-owner',epoch,{'content':'Cat ready'})
    async with entry.database.acquire() as db:
        await db.execute('UPDATE messaging_inbox SET payload=$2::jsonb WHERE delivery_id=$1',delivery,json.dumps({'type':'agent.request','agent_id':'bot','message_id':'external','channel':{'phone_number':'13800000000'},'session_id':'session','turn_id':'turn','payload':{'inputs':[{'type':'text','text':'draw a cat'}]}}))
    outbound=await entry.messaging_routes.store.record_media(delivery,'lease-owner',epoch,item)
    try:
        async with TestServer(upstream) as server, aiohttp.ClientSession() as http:
            service=Channels(replace(settings,yuanjing_mcp_url=str(server.make_url('/mcp')),channels_relay_url='',channels_media_base_url=''),{})
            service.database=entry.database; service.store=entry.messaging_routes.store
            class Wire:
                def put(self,url,**kwargs):
                    assert url.startswith(('https://obs-nmhhht6.cucloud.cn/','http://obs-nmhhht6-internal.cucloud.cn/'))
                    return http.put(str(server.make_url('/upload')),**kwargs)
            service.http=Wire()
            class Gateway:
                health=SimpleNamespace(state='running')
                async def send_channel_message(self, **kwargs):
                    async with http.post(server.make_url('/gateway'),json=kwargs) as response: assert response.status==200
                    return None, SimpleNamespace(downlink_msg_ids=['receipt'])
            service.clients[binding['id']]=(binding['revision'],Gateway())
            for _ in range(2): await service.send_pending()
            async with entry.database.acquire() as db:
                rows=await db.fetch('SELECT state,error_code FROM messaging_outbox ORDER BY part_index')
            assert [row['state'] for row in rows]==['sent','sent']
            assert len(downlinks)==2 and downlinks[0]['text']=='Cat ready'
            if extension=='png':
                assert downlinks[1]['media'][0]['url'].endswith('X-Amz-Expires=604800')
            else:
                assert downlinks[1]['media']==[] and '下载链接' in downlinks[1]['text']
            assert uploads==[raw] and confirms==['sk-fixture']
            for user in ('bob','alice'):
                assert 'internal' not in await service.oss.public_url(user,item)
            assert len(uploads)==2 and confirms==['sk-fixture','sk-bob','sk-fixture']
            assert all(params['arguments']['fileName']==filename for _,params in tools if params['name']=='get_oss_upload_url')
            # Failure before downlink is definite, never falsely acknowledged as sent/unknown.
            public_host[0]='obs-nmhhht6-internal.cucloud.cn'
            async with entry.database.acquire() as db:
                await db.execute("UPDATE messaging_outbox SET state='pending' WHERE outbound_id=$1",outbound)
            await service.send_pending()
            async with entry.database.acquire() as db:
                row=await db.fetchrow('SELECT state,error_code FROM messaging_outbox WHERE outbound_id=$1',outbound)
            assert dict(row)=={'state':'failed','error_code':'media_oss_upload_failed'}
            assert len(downlinks)==2
            view=await entry.messaging_routes.view('alice','uniagentgate')
            assert view['error_code']=='media_oss_upload_failed' and 'OSS' in view['error_message']
    finally:
        await entry.database.close()


@pytest.mark.asyncio
async def test_rcs_format_policy_transcodes_real_wav_and_preserves_other_channel_limits():
    import io
    import wave
    from entry.messaging_rcs import prepare
    from plugins.cloud_messaging.media import outbound_bytes
    buffer=io.BytesIO()
    with wave.open(buffer,'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
        audio.writeframes(b'\0\0'*1600)
    converted,native=await prepare(pack(buffer.getvalue(),'voice.wav','audio','audio/wav'))
    assert native and converted['name']=='voice.mp3' and converted['mime']=='audio/mpeg'
    assert unpack(converted)!=buffer.getvalue() and len(unpack(converted))>0
    for name,kind in [('cat.webp','image'),('cat.gif','image'),('file.pdf','file')]:
        item=pack(b'fixture',name,kind)
        result,native=await prepare(item)
        assert not native and result==item
    large=pack(b'x'*(21*1024*1024),'report.pdf','file')
    assert len(outbound_bytes('uniagentgate',large))>20*1024*1024
    for channel in ('weixin','dingtalk','wecom','feishu'):
        with pytest.raises(ValueError): outbound_bytes(channel,large)
    with pytest.raises(ValueError): pack(b'x'*(64*1024*1024+1),'large.pdf','file')
