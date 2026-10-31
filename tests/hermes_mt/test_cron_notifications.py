"""Real scoped plugin sender -> instance outbox -> Entry/PG -> Feishu HTTP -> durable receipt."""
import asyncio
import json
import time
from types import SimpleNamespace

import aiohttp
import httpx
from fastapi import FastAPI
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.fernet import Fernet
from gateway.config import Platform, PlatformConfig
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_cli.plugins import discover_plugins
from entry.app import build_app
from entry.config import Settings
from entry.channels_service import Channels
from entry.channel_feishu import Feishu
from entry import channel_feishu
from plugins.cloud_messaging.notifications import Notifications
from tools.send_message_tool import _send_to_platform


@pytest.mark.asyncio
async def test_standalone_cron_sender_uses_durable_central_delivery_and_never_crosses_accounts(tmp_path, postgres_database_url, monkeypatch):
    app=build_app(Settings(database_url=postgres_database_url,credential_key=Fernet.generate_key().decode()))
    entry=next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__=='login')
    await entry.database.connect()
    async def warm(_): pass
    entry._warm=warm
    received=[]
    upstream=web.Application()
    async def token(request):
        return web.json_response({'code':0,'tenant_access_token':'fixture-access','expire':7200})
    async def reply(request):
        assert request.headers['Authorization']=='Bearer fixture-access'
        received.append(await request.json())
        return web.json_response({'code':0,'data':{'message_id':'sent-'+str(len(received))}})
    upstream.router.add_post('/open-apis/auth/v3/tenant_access_token/internal',token)
    upstream.router.add_post('/open-apis/im/v1/messages/previous/reply',reply)
    try:
        async with TestServer(upstream) as server, aiohttp.ClientSession() as http:
            monkeypatch.setattr(channel_feishu,'API',str(server.make_url('')).rstrip('/'))
            entry.http=http
            await entry._finish_login('a','',None)
            await entry._finish_login('b','',None)
            binding=await entry.messaging_routes.store.configure('a','','app-a','secret',platform='feishu',enable=True)
            payload={'event':{'text':'Hi'},'reply_enc':entry.store.cipher.encrypt(json.dumps({'message_id':'previous','uuid':'old'})).decode()}
            await entry.messaging_routes.store.ingest(binding['id'],binding['revision'],'chat-a','old-message',payload)
            channels=Channels(entry.s,{})
            channels.database=entry.database
            channels.store=entry.messaging_routes.store
            channels.http=http
            client=Feishu('app-a','secret',channels.store,binding,http)
            client.state='running'
            channels.clients[binding['id']]=(binding['revision'],client)
            home=tmp_path/'a';home.mkdir()
            (home/'config.yaml').write_text('cloud_messaging_delivery: {enabled: true}\n')
            scope=set_hermes_home_override(home)
            try:
                discover_plugins(force=True)
                # Discover and mount exactly as the production dashboard does; a router without
                # its manifest is invisible in the real instance even if direct imports pass.
                from hermes_cli import web_server, web_server_dashboard
                manifests = [row for row in web_server_dashboard._discover_dashboard_plugins() if row['name']=='cloud-messaging']
                assert len(manifests)==1
                instance_app = FastAPI()
                monkeypatch.setattr(web_server, 'app', instance_app)
                monkeypatch.setattr(web_server, '_get_dashboard_plugins', lambda: manifests)
                monkeypatch.setenv('HERMES_DASHBOARD_SESSION_TOKEN', 'entry-instance-token')
                web_server_dashboard._mount_plugin_api_routes()
                instance_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=instance_app), base_url='http://instance')
                path='/api/plugins/cloud-messaging/notifications'
                assert (await instance_http.post(path,json={'operation':'list'})).status_code==403
                assert (await instance_http.post(path,json={'operation':'list'},headers={'X-Hermes-Session-Token':'entry-instance-token'})).status_code==403
                async def forward(request):
                    response=await instance_http.post(path,content=await request.read(),headers=dict(request.headers))
                    return web.Response(body=response.content,status=response.status_code,content_type='application/json')
                forward_app=web.Application()
                forward_app.router.add_post(path,forward)
                forward_server=TestServer(forward_app)
                await forward_server.start_server()
                async def ensure(user, **kwargs):
                    assert user=='a' and kwargs=={'touch':False}
                    return SimpleNamespace(origin=str(forward_server.make_url('')).removeprefix('http://').rstrip('/'),
                        token='entry-instance-token',host_header='',traffic_token='')
                entry.tenants=SimpleNamespace(ensure_running=ensure)
                task=asyncio.create_task(_send_to_platform(Platform.FEISHU,PlatformConfig(enabled=True),'chat-a','Scheduled result'))
                queue=Notifications(home)
                async with asyncio.timeout(10):
                    while not queue.pending(): await asyncio.sleep(.02)
                    item=queue.pending()[0]
                    assert await entry.notifications.admit('b',item)=='failed'
                    assert await entry.notifications.admit('a',item)=='queued'
                    assert await entry.notifications.admit('a',item)=='queued'
                    await channels.send_pending()
                    assert await entry.notifications.admit('a',item)=='sent'
                    await entry.notifications.flush('a')
                    assert queue.status(item['id'])=='sent'
                    result=await task
                assert result['success'] and len(received)==1
                assert received[0]['uuid']!='old'
                assert json.loads(received[0]['content'])['text']=='Scheduled result'
                await channels.send_pending()
                assert len(received)==1
                changed={**item,'content':'Changed'}
                with pytest.raises(ValueError): await entry.notifications.admit('a',changed)
                # Unknown is terminal locally: re-reading cannot enqueue another physical send.
                unknown=queue.enqueue('feishu','chat-a','uncertain',[])
                queue.acknowledge(unknown,'unknown')
                assert queue.status(unknown)=='unknown' and not queue.pending()
            finally:
                if 'forward_server' in locals(): await forward_server.close()
                if 'instance_http' in locals(): await instance_http.aclose()
                reset_hermes_home_override(scope)
    finally:
        await entry.account_routes.close()
        await entry.drive_routes.close()
        await entry.database.close()
