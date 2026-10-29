"""DingTalk SDK callback ACK crosses the real PG durability boundary."""
import asyncio
import json
import time
from types import SimpleNamespace

import pytest
from aiohttp import web
from cryptography.fernet import Fernet

from entry.channel_dingtalk import DingTalk, ReplyRejected, normalize
from entry.crypto import CredentialCipher
from entry.db import Database
from entry.messaging_store import MessagingStore
from entry.store import Store


@pytest.mark.asyncio
async def test_durable_callback_and_platform_binding_fence(postgres_database_url):
    sdk=pytest.importorskip('dingtalk_stream')
    database=Database(postgres_database_url)
    await database.connect()
    cipher=CredentialCipher(Fernet.generate_key().decode())
    store=MessagingStore(database,cipher)
    try:
        users=Store(database,cipher)
        for user in ('alice','bob'):
            await users.finish_login(user_id=user,phone='',api_key='',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
        five=await store.configure('alice','https://gateway.invalid','same-id','five-secret')
        binding=await store.configure('alice','','same-id','ding-secret',platform='dingtalk')
        assert five['id']!=binding['id']
        with pytest.raises(web.HTTPConflict):
            await store.configure('bob','','same-id','other',platform='dingtalk')
        await store.set_enabled('alice',True)
        await store.set_enabled('alice',True,platform='dingtalk')
        binding=await store.binding('alice','dingtalk')
        client=DingTalk(binding['bot_key'],'ding-secret',store,dict(binding),None)
        event={'msgtype':'text','msgId':'message-1','conversationId':'chat-1','senderId':'sender-1',
            'conversationType':'2','isInAtList':True,'text':{'content':'hello'},
            'sessionWebhook':'https://oapi.dingtalk.com/robot/sendBySession?session=secret-token',
            'sessionWebhookExpiredTime':int(time.time()*1000)+60000}
        frame={'specVersion':'1.0','type':'CALLBACK','headers':{'topic':sdk.ChatbotMessage.TOPIC,'messageId':'frame-1','contentType':'application/json'},'data':json.dumps(event)}
        acks=[]
        class Wire:
            async def send(self,data):
                ack=json.loads(data)
                if ack['code']==200:
                    async with database.acquire() as db:
                        assert await db.fetchval('SELECT 1 FROM messaging_inbox WHERE external_message_id=$1',event['msgId'])
                acks.append(ack)
        # Exercise the pinned SDK dispatch, not a fake receiver calling our handler directly.
        client.sdk.websocket=Wire()
        await client.sdk.route_message(frame)
        client.sdk.websocket=Wire()
        await client.sdk.route_message(frame)
        assert len(acks)==2 and all(ack['code']==200 for ack in acks)
        async with database.acquire() as db:
            rows=await db.fetch('SELECT * FROM messaging_inbox')
            assert len(rows)==1
            payload=json.loads(rows[0]['payload'])
            assert 'secret-token' not in rows[0]['payload']
            assert payload['event']['source']['chat_type']=='group'
        await store.set_enabled('alice',False,platform='dingtalk')
        assert (await store.binding('alice'))['enabled']
        # A late event from the previous binding must NOT get a success ACK.
        client.sdk.websocket=Wire()
        await client.sdk.route_message(frame)
        assert acks[-1]['code']!=200
        assert normalize({**event,'isInAtList':False}) is None
    finally:
        await database.close()


@pytest.mark.asyncio
async def test_reply_expiry_no_cross_conversation_fallback():
    sdk=pytest.importorskip('dingtalk_stream')
    cipher=CredentialCipher(Fernet.generate_key().decode())
    class HTTP:
        def __init__(self): self.calls=[]
        def post(self,url,**kwargs):
            self.calls.append((url,kwargs))
            class Response:
                status=200
                async def __aenter__(self): return self
                async def __aexit__(self,*args): pass
                async def json(self): return {'errcode':0}
            return Response()
    http=HTTP()
    client=DingTalk('id','secret',SimpleNamespace(cipher=cipher),{},http)
    context={'url':'https://oapi.dingtalk.com/robot/sendBySession?session=one','expires':int(time.time()*1000)+60000}
    payload={'reply_enc':cipher.encrypt(json.dumps(context)).decode()}
    assert await client.send(payload,'exact final')=={'ok':True}
    assert http.calls[0][0]==context['url']
    assert http.calls[0][1]['json']['text']['content']=='exact final'
    assert http.calls[0][1]['allow_redirects'] is False
    context['expires']=1
    payload['reply_enc']=cipher.encrypt(json.dumps(context)).decode()
    with pytest.raises(ReplyRejected): await client.send(payload,'do not resend')
    assert len(http.calls)==1
