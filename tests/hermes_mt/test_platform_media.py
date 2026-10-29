"""Weixin/DingTalk HTTP media and WeCom chunk upload reuse the platform contracts."""
import asyncio
import base64
import json
import time
from types import SimpleNamespace

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
import pytest

from entry.channel_weixin import Weixin
from entry.channel_wecom import WeCom
from entry.channel_dingtalk import DingTalk
from entry.crypto import CredentialCipher
from entry.db import Database
from entry.messaging_store import MessagingStore
from entry.store import Store
from plugins.cloud_messaging.media import pack,unpack


async def setup(dsn,platform):
    db=Database(dsn); await db.connect()
    cipher=CredentialCipher(Fernet.generate_key().decode()); store=MessagingStore(db,cipher)
    await Store(db,cipher).finish_login(user_id='alice',phone='',api_key='sk-test',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    await store.configure('alice','https://ilinkai.weixin.qq.com' if platform=='weixin' else '', 'bot','secret',platform=platform,enable=True)
    return db,store,dict(await store.binding('alice',platform))


@pytest.mark.asyncio
@pytest.mark.parametrize('platform',['weixin','dingtalk'])
async def test_platform_download_upload_preserves_bytes_and_recipient(postgres_database_url,platform):
    if platform=='dingtalk': pytest.importorskip('dingtalk_stream')
    db,store,binding=await setup(postgres_database_url,platform)
    raw=b'\x89PNG\r\n\x1a\n'+b'private-image'
    key=b'a'*16
    padding=16-len(raw)%16
    encryptor=Cipher(algorithms.AES(key),modes.ECB()).encryptor()
    encrypted=encryptor.update(raw+bytes([padding])*padding)+encryptor.finalize()
    uploaded=[]; delivered=[]; keys=[]
    async def upstream(request):
        if request.path.endswith('/getuploadurl'):
            body=await request.json(); keys.append(bytes.fromhex(body['aeskey']))
            assert body['to_user_id']=='peer'
            return web.json_response({'upload_full_url':'https://novac2c.cdn.weixin.qq.com/upload'})
        if request.path=='/upload':
            incoming=await request.read(); decryptor=Cipher(algorithms.AES(keys[-1]),modes.ECB()).decryptor()
            output=decryptor.update(incoming)+decryptor.finalize(); uploaded.append(output[:-output[-1]])
            return web.Response(headers={'x-encrypted-param':'uploaded'})
        if request.path.endswith('/sendmessage'):
            body=await request.json(); assert body['msg']['to_user_id']=='peer'
            detail=body['msg']['item_list'][0]['image_item']
            assert bytes.fromhex(base64.b64decode(detail['media']['aes_key']).decode())==keys[-1]
            delivered.append(body); return web.json_response({'ret':0})
        if request.path.endswith('/download') and platform=='weixin': return web.Response(body=encrypted,content_type='application/octet-stream')
        if request.path.endswith('/accessToken'): return web.json_response({'accessToken':'access','expireIn':7200})
        if request.path.endswith('/messageFiles/download'):
            assert request.headers['x-acs-dingtalk-access-token']=='access'
            return web.json_response({'downloadUrl':'https://test.aliyuncs.com/blob'})
        if request.path=='/blob': return web.Response(body=raw,content_type='image/png')
        if request.path.endswith('/media/upload'):
            reader=await request.multipart(); part=await reader.next(); uploaded.append(bytes(await part.read()))
            return web.json_response({'errcode':0,'media_id':'media'})
        if request.path.endswith('/batchSend'):
            body=await request.json(); assert body['userIds']==['staff-id'] and body['msgKey']=='sampleImageMsg'
            delivered.append(body); return web.json_response({'processQueryKey':'receipt'})
        raise web.HTTPNotFound()
    app=web.Application(); app.router.add_route('*','/{path:.*}',upstream)
    try:
        async with TestServer(app) as server,aiohttp.ClientSession() as http:
            class Wire:
                def request(self,method,url,**kwargs):
                    from urllib.parse import urlsplit
                    parsed=urlsplit(url)
                    return http.request(method,str(server.make_url(parsed.path+('?' + parsed.query if parsed.query else ''))),**kwargs)
                def get(self,url,**kwargs): return self.request('GET',url,**kwargs)
                def post(self,url,**kwargs): return self.request('POST',url,**kwargs)
            client=Weixin('bot','secret',store,binding,Wire()) if platform=='weixin' else DingTalk('bot','secret',store,binding,Wire())
            if platform=='weixin':
                await client.receive_batch({'msgs':[{'from_user_id':'peer','message_id':'message','context_token':'context','item_list':[{'type':2,'image_item':{'media':{'encrypt_query_param':'query','aes_key':base64.b64encode(key).decode()}}}]}],'get_updates_buf':'cursor'})
            else:
                await client.receive({'msgtype':'picture','content':{'downloadCode':'download'},'conversationId':'peer','conversationType':'1','senderId':'peer','senderStaffId':'staff-id','msgId':'message',
                    'sessionWebhook':'https://oapi.dingtalk.com/robot/sendBySession?secret=not-for-model','sessionWebhookExpiredTime':int(time.time()*1000)+60000})
            async with db.acquire() as connection: row=await connection.fetchrow('SELECT * FROM messaging_inbox')
            payload=json.loads(row['payload'])
            assert base64.b64decode(payload['event']['media_urls'][0].split(';base64,')[1])==raw
            assert payload['event']['message_type']=='photo'
            assert 'not-for-model' not in json.dumps(payload['event'])
            assert (await client.send_media(payload,pack(raw,'picture.png','image','image/png')))['ok']
            assert uploaded==[raw] and len(delivered)==1
    finally: await db.close()


@pytest.mark.asyncio
async def test_wecom_encrypted_attachment_and_websocket_chunk_upload(postgres_database_url):
    db,store,binding=await setup(postgres_database_url,'wecom')
    raw=b'\x89PNG\r\n\x1a\n'+b'wecom-image'
    key=b'k'*32; padding=16-len(raw)%16
    encryptor=Cipher(algorithms.AES(key),modes.CBC(key[:16])).encryptor()
    encrypted=encryptor.update(raw+bytes([padding])*padding)+encryptor.finalize()
    received=asyncio.Event(); uploaded=bytearray(); frames=[]
    async def blob(request): return web.Response(body=encrypted,content_type='application/octet-stream')
    async def ws_handler(request):
        ws=web.WebSocketResponse(); await ws.prepare(request)
        subscribe=await ws.receive_json(); await ws.send_json({'headers':subscribe['headers'],'errcode':0})
        await ws.send_json({'cmd':'aibot_msg_callback','headers':{'req_id':'callback'},'body':{'msgid':'message','from':{'userid':'peer'},'chatid':'group','chattype':'group','msgtype':'image',
            'image':{'url':'https://weixin.qq.com/blob','aeskey':base64.b64encode(key).decode()}}})
        async for message in ws:
            frame=json.loads(message.data); cmd=frame['cmd']; frames.append(frame)
            if cmd=='ping': continue
            body={}
            if cmd=='aibot_upload_media_init': body={'upload_id':'upload'}
            if cmd=='aibot_upload_media_chunk': uploaded.extend(base64.b64decode(frame['body']['base64_data']))
            if cmd=='aibot_upload_media_finish': body={'media_id':'media'}
            if cmd=='aibot_respond_msg':
                assert frame['headers']['req_id']=='callback'
                assert frame['body']=={'msgtype':'image','image':{'media_id':'media'}}
                received.set()
            await ws.send_json({'headers':frame['headers'],'errcode':0,'body':body})
        return ws
    app=web.Application(); app.router.add_get('/blob',blob); app.router.add_get('/stream',ws_handler)
    try:
        async with TestServer(app) as server,aiohttp.ClientSession() as http:
            class Wire:
                def get(self,url,**kwargs): return http.get(str(server.make_url('/blob')),**kwargs)
                def ws_connect(self,url,**kwargs): return http.ws_connect(str(server.make_url('/stream')),**kwargs)
            client=WeCom('bot','secret',store,binding,Wire())
            try:
                await client.start()
                async with asyncio.timeout(10):
                    while True:
                        async with db.acquire() as connection: row=await connection.fetchrow('SELECT * FROM messaging_inbox')
                        if row: break
                        await asyncio.sleep(.01)
                payload=json.loads(row['payload'])
                assert base64.b64decode(payload['event']['media_urls'][0].split(';base64,')[1])==raw
                assert (await client.send_media(payload,pack(raw,'picture.png','image','image/png')))['ok']
                await asyncio.wait_for(received.wait(),5)
                assert bytes(uploaded)==raw
                assert [frame['cmd'] for frame in frames if frame['cmd']!='ping']==['aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_finish','aibot_respond_msg']
            finally: await client.stop()
    finally: await db.close()
