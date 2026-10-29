"""The real SDK runs over local HTTPS/WebSocket; stop must end reconnection."""
import asyncio
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import ssl
from types import SimpleNamespace

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.fernet import Fernet
import pytest

from entry.channel_dingtalk import DingTalk
from entry.crypto import CredentialCipher


@pytest.mark.asyncio
async def test_stream_socket_durable_ack_and_cancellable_shutdown(tmp_path):
    pytest.importorskip('dingtalk_stream')
    key=ec.generate_private_key(ec.SECP256R1())
    name=x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME,'localhost')])
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1))
        .not_valid_after(datetime.now(timezone.utc)+timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
        .sign(key,hashes.SHA256()))
    certfile,keyfile=tmp_path/'cert.pem',tmp_path/'key.pem'
    certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    server_tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_tls.load_cert_chain(certfile,keyfile)
    client_tls=ssl.create_default_context(cafile=str(certfile))
    accepted,closed=asyncio.Event(),asyncio.Event()
    durable=[]
    class Store:
        cipher=CredentialCipher(Fernet.generate_key().decode())
        async def seen(self,*args): return False
        async def ingest(self,binding,revision,chat,message,payload):
            durable.append((binding,revision,chat,message,payload))
    app=web.Application()
    opens=[]
    async def opening(request):
        data=await request.json()
        assert data['clientId']=='app' and data['clientSecret']=='secret'
        opens.append(data)
        return web.json_response({'endpoint':str(server.make_url('/stream')).replace('https:','wss:'),'ticket':'ticket'})
    async def stream(request):
        assert request.query['ticket']=='ticket'
        ws=web.WebSocketResponse()
        await ws.prepare(request)
        payload={'msgId':'msg','conversationId':'chat','senderId':'sender','conversationType':'1','msgtype':'text',
            'text':{'content':'hello'},'sessionWebhook':'https://oapi.dingtalk.com/robot/sendBySession?session=private',
            'sessionWebhookExpiredTime':9999999999999}
        await ws.send_json({'type':'CALLBACK','headers':{'topic':'/v1.0/im/bot/messages/get','messageId':'frame','contentType':'application/json'},'data':json.dumps(payload)})
        try:
            async for message in ws:
                assert durable
                assert json.loads(message.data)['code']==200
                accepted.set()
        finally: closed.set()
        return ws
    app.router.add_post('/open',opening)
    app.router.add_get('/stream',stream)
    server=TestServer(app,scheme='https')
    await server.start_server(ssl=server_tls)
    try:
        async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=client_tls)) as http:
            client=DingTalk('app','secret',Store(),{'id':'binding','revision':1},http)
            client.sdk.OPEN_CONNECTION_API=str(server.make_url('/open'))
            try:
                await client.start()
                await asyncio.wait_for(accepted.wait(),10)
                assert client.health.state=='running'
                assert 'private' not in json.dumps(durable)
                await asyncio.wait_for(client.stop(),3)
                await asyncio.wait_for(closed.wait(),3)
                assert client.task.cancelled() and len(opens)==1
            finally:
                await client.stop()
    finally:
        await server.close()
