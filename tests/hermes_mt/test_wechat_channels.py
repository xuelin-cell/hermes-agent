"""Real PG and loopback protocol servers exercise cloud QR and WeCom delivery."""
import asyncio
import json
from types import SimpleNamespace

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.fernet import Fernet
import pytest

from entry.channel_dingtalk import ReplyRejected
from entry.channel_weixin import Weixin, trusted_origin
from entry.channel_wecom import WeCom
from entry.crypto import CredentialCipher
from entry.db import Database
from entry.messaging_store import MessagingStore
from entry.store import Store
from entry.weixin_qr_routes import WeixinQr


async def prepare(dsn):
    database=Database(dsn)
    await database.connect()
    cipher=CredentialCipher(Fernet.generate_key().decode())
    users=Store(database,cipher)
    for user in ('alice','bob'):
        await users.finish_login(user_id=user,phone='',api_key='',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    return database,MessagingStore(database,cipher)


@pytest.mark.asyncio
async def test_weixin_qr_ownership_cursor_replay_and_unbind_fence(postgres_database_url):
    database,store=await prepare(postgres_database_url)
    hold,release,polling_started=asyncio.Event(),asyncio.Event(),asyncio.Event()
    replies=[]
    async def upstream(request):
        if request.path.endswith('get_bot_qrcode'):
            return web.json_response({'qrcode':'qr-secret','qrcode_img_content':'https://weixin.qq.com/scan'})
        if request.path.endswith('get_qrcode_status'):
            if request.query.get('qrcode')=='qr-secret' and hold.is_set():
                polling_started.set()
                await release.wait()
            return web.json_response({'status':'confirmed','ilink_bot_id':'bot','bot_token':'bot-secret','baseurl':'https://ilinkai.weixin.qq.com'})
        assert request.headers['Authorization']=='Bearer bot-secret'
        data=await request.json()
        assert data['base_info']['channel_version']=='2.2.0'
        replies.append(data)
        return web.json_response({'ret':0})
    app=web.Application()
    app.router.add_route('*','/{path:.*}',upstream)
    server=TestServer(app)
    await server.start_server()
    try:
        async with aiohttp.ClientSession() as http:
            class Wire:
                def request(self,method,url,**kwargs):
                    from urllib.parse import urlsplit
                    parsed=urlsplit(url)
                    return http.request(method,str(server.make_url(parsed.path+('?' + parsed.query if parsed.query else ''))),**kwargs)
            wire=Wire()
            qr=WeixinQr(SimpleNamespace(store=store,entry=SimpleNamespace(http=wire)))
            started=await qr.handle('alice','weixin-start',{})
            with pytest.raises(web.HTTPNotFound):
                await qr.handle('bob','weixin-status',{'session_id':started['session_id']})
            confirmed=await qr.handle('alice','weixin-status',{'session_id':started['session_id']})
            assert confirmed['state']=='confirmed' and 'bot-secret' not in json.dumps(confirmed)
            binding=dict(await store.binding('alice','weixin'))
            with pytest.raises(web.HTTPConflict):
                await store.configure('bob','https://ilinkai.weixin.qq.com','bot','other',platform='weixin')
            client=Weixin('bot','bot-secret',store,binding,wire)
            batch={'msgs':[{'from_user_id':'peer','message_id':'m1','context_token':'context-secret',
                'item_list':[{'type':1,'text_item':{'text':'hello'}}]}],'get_updates_buf':'cursor-1'}
            await client.receive_batch(batch)
            restored=dict(await store.binding('alice','weixin'))
            assert json.loads(restored['config'])['sync_buf']=='cursor-1'
            await Weixin('bot','bot-secret',store,restored,wire).receive_batch(batch)
            async with database.acquire() as db:
                rows=await db.fetch('SELECT * FROM messaging_inbox')
            assert len(rows)==1 and 'context-secret' not in rows[0]['payload']
            await client.send(json.loads(rows[0]['payload']),'answer')
            assert replies[0]['msg']['to_user_id']=='peer'
            assert replies[0]['msg']['context_token']=='context-secret'
            started=await qr.handle('alice','weixin-start',{})
            hold.set()
            polling=asyncio.create_task(qr.handle('alice','weixin-status',{'session_id':started['session_id']}))
            # Wait for the request to reach the local server before invalidating it.
            await asyncio.wait_for(polling_started.wait(),5)
            await qr.handle('alice','weixin-unbind',{})
            release.set()
            with pytest.raises(web.HTTPConflict): await polling
            assert await store.binding('alice','weixin') is None
            with pytest.raises(web.HTTPConflict): await client.receive_batch(batch)
            for url in ('http://ilinkai.weixin.qq.com','https://weixin.qq.com.evil.test','https://user@weixin.qq.com'):
                with pytest.raises(ValueError): trusted_origin(url)
    finally:
        release.set()
        await server.close()
        await database.close()


@pytest.mark.asyncio
async def test_wecom_subscription_durable_inbound_ack_and_stale_connection(postgres_database_url,monkeypatch):
    database,store=await prepare(postgres_database_url)
    binding=await store.configure('alice','','wecom-bot','bot-secret',platform='wecom')
    await store.set_enabled('alice',True,platform='wecom')
    binding=dict(await store.binding('alice','wecom'))
    connected=asyncio.Event()
    callback={'cmd':'aibot_msg_callback','headers':{'req_id':'callback-1'},'body':{
        'msgid':'msg-1','chatid':'chat-1','chattype':'group','from':{'userid':'sender'},'msgtype':'text','text':{'content':'hello'}}}
    async def upstream(request):
        ws=web.WebSocketResponse()
        await ws.prepare(request)
        auth=await ws.receive_json()
        assert auth['cmd']=='aibot_subscribe' and auth['body']['secret']=='bot-secret'
        await ws.send_json({'headers':auth['headers'],'errcode':0})
        await ws.send_json(callback)
        await ws.send_json(callback)
        connected.set()
        async for message in ws:
            frame=json.loads(message.data)
            if frame['cmd']=='ping': continue
            assert frame['cmd']=='aibot_respond_msg' and frame['headers']['req_id']=='callback-1'
            async with database.acquire() as db:
                assert await db.fetchval('SELECT count(*) FROM messaging_inbox')==1
            assert frame['body']['stream']['finish'] is True
            await ws.send_json({'headers':frame['headers'],'errcode':0})
        return ws
    app=web.Application()
    app.router.add_get('/stream',upstream)
    server=TestServer(app)
    await server.start_server()
    monkeypatch.setattr('entry.channel_wecom.WS_URL',str(server.make_url('/stream')).replace('http:','ws:'))
    try:
        async with aiohttp.ClientSession() as http:
            client=WeCom('wecom-bot','bot-secret',store,binding,http)
            await client.start()
            try:
                await asyncio.wait_for(connected.wait(),5)
                async with asyncio.timeout(5):
                    while True:
                        async with database.acquire() as db:
                            row=await db.fetchrow('SELECT * FROM messaging_inbox')
                        if row: break
                        await asyncio.sleep(.01)
                payload=json.loads(row['payload'])
                assert payload['event']['source']['chat_type']=='group'
                assert 'callback-1' not in row['payload']
                assert await client.send(payload,'answer')=={'ok':True}
                client.generation='new-connection'
                with pytest.raises(ReplyRejected): await client.send(payload,'must not resend')
                await store.set_enabled('alice',False,platform='wecom')
                with pytest.raises(web.HTTPConflict): await client.receive(callback)
            finally:
                await asyncio.wait_for(client.stop(),3)
    finally:
        await server.close()
        await database.close()
