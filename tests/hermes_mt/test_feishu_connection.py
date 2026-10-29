"""Pinned Feishu protobuf protocol over local HTTPS/WebSocket and real PG."""
import asyncio
import base64
from datetime import datetime,timedelta,timezone
import ipaddress
import json
import ssl
from types import SimpleNamespace

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.fernet import Fernet
import pytest

from entry.channel_feishu import Feishu
from entry.crypto import CredentialCipher
from entry.db import Database
from entry.messaging_store import MessagingStore
from entry.store import Store
from plugins.cloud_messaging.media import pack,unpack


def tls(tmp_path):
    key=ec.generate_private_key(ec.SECP256R1())
    name=x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME,'localhost')])
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1)).not_valid_after(datetime.now(timezone.utc)+timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256()))
    certfile,keyfile=tmp_path/'cert.pem',tmp_path/'key.pem'
    certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    server=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); server.load_cert_chain(certfile,keyfile)
    return server,ssl.create_default_context(cafile=str(certfile))


@pytest.mark.asyncio
async def test_feishu_sdk_frames_persist_media_before_ack(tmp_path,postgres_database_url):
    pytest.importorskip('lark_oapi')
    from lark_oapi.ws.pb.pbbp2_pb2 import Frame
    database=Database(postgres_database_url); await database.connect()
    cipher=CredentialCipher(Fernet.generate_key().decode())
    store=MessagingStore(database,cipher)
    await Store(database,cipher).finish_login(user_id='alice',phone='',api_key='sk-test',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    await store.configure('alice','','app','secret',platform='feishu',enable=True)
    binding=dict(await store.binding('alice','feishu'))
    accepted=asyncio.Event(); closed=asyncio.Event()
    acks=[]; replies=[]; uploads=[]
    raw=b'\x89PNG\r\n\x1a\n'+b'bounded-image'
    async def api(request):
        if request.path=='/callback/ws/endpoint':
            assert await request.json()=={'AppID':'app','AppSecret':'secret'}
            return web.json_response({'code':0,'data':{'URL':str(server.make_url('/stream?service_id=7')).replace('https:','wss:'),'ClientConfig':{'PingInterval':30}}})
        if request.path.endswith('/tenant_access_token/internal'):
            assert (await request.json())['app_secret']=='secret'
            return web.json_response({'code':0,'tenant_access_token':'tenant-token','expire':7200})
        assert request.headers['Authorization']=='Bearer tenant-token'
        if request.path.endswith('/bot/v3/info'): return web.json_response({'code':0,'bot':{'open_id':'bot-open-id'}})
        if '/resources/' in request.path: return web.Response(body=raw,content_type='image/png')
        if request.path.endswith('/images'):
            reader=await request.multipart(); image=None
            while (part:=await reader.next()) is not None:
                if part.name=='image': image=bytes(await part.read())
            uploads.append(image)
            return web.json_response({'code':0,'data':{'image_key':'uploaded-image'}})
        if request.path.endswith('/reply'):
            replies.append(await request.json())
            return web.json_response({'code':0,'data':{'message_id':'reply'}})
        raise web.HTTPNotFound()
    async def stream(request):
        ws=web.WebSocketResponse(); await ws.prepare(request)
        event={'header':{'event_type':'im.message.receive_v1'},'event':{'sender':{'sender_type':'user','sender_id':{'open_id':'peer'}},
            'message':{'message_id':'msg-1','chat_id':'group','chat_type':'group','message_type':'image','mentions':[{'id':{'open_id':'bot-open-id'}}],
                'content':json.dumps({'image_key':'image-key'})}}}
        payload=json.dumps(event).encode()
        for index,data in enumerate((payload[:len(payload)//2],payload[len(payload)//2:])):
            frame=Frame(service=7,method=1,SeqID=index,LogID=0,payload=data)
            for key,value in {'type':'event','message_id':'fragmented','sum':'2','seq':str(index)}.items():
                header=frame.headers.add(); header.key=key; header.value=value
            await ws.send_bytes(frame.SerializeToString())
        try:
            async for message in ws:
                frame=Frame(); frame.ParseFromString(message.data)
                if frame.method!=1: continue
                async with database.acquire() as db:
                    row=await db.fetchrow('SELECT * FROM messaging_inbox')
                assert row is not None
                data=json.loads(row['payload'])
                encoded=data['event']['media_urls'][0].split(';base64,')[1]
                assert base64.b64decode(encoded)==raw
                assert data['event']['source']['chat_type']=='group'
                acks.append(json.loads(frame.payload)); accepted.set()
        finally: closed.set()
        return ws
    app=web.Application(); app.router.add_route('*','/stream',stream); app.router.add_route('*','/{path:.*}',api)
    server_tls,client_tls=tls(tmp_path)
    server=TestServer(app,scheme='https'); await server.start_server(ssl=server_tls)
    try:
        async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=client_tls)) as http:
            class Wire:
                def translate(self,url):
                    from urllib.parse import urlsplit
                    parsed=urlsplit(url)
                    return str(server.make_url(parsed.path+('?' + parsed.query if parsed.query else ''))) if parsed.hostname=='open.feishu.cn' else url
                def request(self,method,url,**kwargs): return http.request(method,self.translate(url),**kwargs)
                def post(self,url,**kwargs): return self.request('POST',url,**kwargs)
                def get(self,url,**kwargs): return self.request('GET',url,**kwargs)
                def ws_connect(self,url,**kwargs): return http.ws_connect(url,**kwargs)
            client=Feishu('app','secret',store,binding,Wire())
            try:
                await client.start(); await asyncio.wait_for(accepted.wait(),10)
                assert acks==[{'code':200}]
                async with database.acquire() as db: row=await db.fetchrow('SELECT * FROM messaging_inbox')
                payload=json.loads(row['payload'])
                await client.send(payload,'answer')
                await client.send_media(payload,pack(raw,'image.png','image','image/png'))
                assert uploads==[raw]
                assert [item['msg_type'] for item in replies]==['text','image']
                assert json.loads(replies[-1]['content'])=={'image_key':'uploaded-image'}
                await client.stop(); await asyncio.wait_for(closed.wait(),3)
                assert client.task.cancelled()
            finally: await client.stop()
    finally:
        await server.close(); await database.close()


@pytest.mark.asyncio
async def test_feishu_ignores_unmentioned_group_and_rejects_old_binding(postgres_database_url):
    database=Database(postgres_database_url); await database.connect()
    cipher=CredentialCipher(Fernet.generate_key().decode()); store=MessagingStore(database,cipher)
    await Store(database,cipher).finish_login(user_id='alice',phone='',api_key='sk-test',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    await store.configure('alice','','app','secret',platform='feishu',enable=True)
    binding=dict(await store.binding('alice','feishu'))
    client=Feishu('app','secret',store,binding,None); client.bot_id='own-bot'
    event={'header':{'event_type':'im.message.receive_v1'},'event':{'sender':{'sender_type':'user','sender_id':{'open_id':'peer'}},'message':{
        'chat_id':'group','message_id':'message','message_type':'text','chat_type':'group','content':json.dumps({'text':'hello'}),'mentions':[]}}}
    try:
        await client.receive(event)
        async with database.acquire() as db: assert await db.fetchval('SELECT count(*) FROM messaging_inbox')==0
        event['event']['message']['mentions']=[{'id':{'open_id':'own-bot'}}]
        await client.receive(event); await client.receive(event)
        async with database.acquire() as db: assert await db.fetchval('SELECT count(*) FROM messaging_inbox')==1
        await store.set_enabled('alice',False,platform='feishu')
        with pytest.raises(web.HTTPConflict): await client.receive(event)
    finally: await database.close()
