"""Group intake is explicit, scoped to allowed rooms and independent of live DM work."""
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient,TestServer
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.channel_weixin import Weixin
from entry.config import Settings


async def setup(dsn):
    app=build_app(Settings(database_url=dsn,credential_key=Fernet.generate_key().decode(),backend='cube',channels_key='master',channels_relay_url='ws://entry/relay'))
    entry=next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__=='login')
    app.on_startup.clear(); app.on_cleanup.clear()
    await entry.database.connect()
    sessions={}
    for user in ('alice','bob'):
        state=await entry.store.finish_login(user_id=user,phone='',api_key='sk-test',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
        sessions[user]={ 'Cookie':entry.s.cookie_name+'='+state.session.sid }
        await entry.messaging_routes.store.configure(user,'https://ilinkai.weixin.qq.com','bot-'+user,'secret',platform='weixin',enable=True)
    return app,entry,sessions


def group_message():
    return {'msgs':[{'from_user_id':'peer','room_id':'allowed-room','message_id':'group-message','context_token':'secret-context',
        'item_list':[{'type':1,'text_item':{'text':'group hello'}}]}],'get_updates_buf':'cursor'}


@pytest.mark.asyncio
async def test_group_policy_is_user_scoped_and_does_not_cancel_running_dm(postgres_database_url):
    app,entry,sessions=await setup(postgres_database_url)
    store=entry.messaging_routes.store
    binding=dict(await store.binding('alice','weixin'))
    client=Weixin('bot-alice','secret',store,binding,None)
    path='/hermes/__entry/messaging/group-policy'
    try:
        async with TestClient(TestServer(app)) as api:
            assert (await api.post(path,json={})).status==401
            await client.receive_batch(group_message())
            async with entry.database.acquire() as db: assert await db.fetchval('SELECT count(*) FROM messaging_inbox')==0
            delivery=await store.ingest(binding['id'],binding['revision'],'peer','dm',{'event':{'text':'dm'}})
            await store.claim('owner')
            response=await api.post(path,headers=sessions['alice'],json={'enabled':True,'group_ids':['allowed-room']})
            assert response.status==200
            current=await store.binding('alice','weixin')
            assert current['revision']==binding['revision']
            async with entry.database.acquire() as db:
                assert await db.fetchval('SELECT state FROM messaging_inbox WHERE delivery_id=$1',delivery)=='dispatching'
            assert not (await (await api.post(path,headers=sessions['bob'],json={})).json())['enabled']
            await client.receive_batch(group_message())
            async with entry.database.acquire() as db:
                row=await db.fetchrow("SELECT * FROM messaging_inbox WHERE external_message_id='group-message'")
            payload=json.loads(row['payload'])
            assert payload['event']['source']['chat_type']=='group'
            assert payload['event']['source']['chat_id']=='allowed-room'
            assert payload['event']['source']['user_id']=='peer'
            assert 'secret-context' not in json.dumps(payload['event'])
            await api.post(path,headers=sessions['alice'],json={'enabled':False,'group_ids':[]})
            batch=group_message(); batch['msgs'][0]['message_id']='after-disable'
            await client.receive_batch(batch)
            async with entry.database.acquire() as db:
                assert not await db.fetchval("SELECT 1 FROM messaging_inbox WHERE external_message_id='after-disable'")
    finally: await entry.database.close()


@pytest.mark.asyncio
async def test_group_reply_routes_to_room_and_unlisted_rooms_are_ignored(postgres_database_url):
    app,entry,sessions=await setup(postgres_database_url)
    store=entry.messaging_routes.store
    await store.groups('alice',True,['allowed-room'])
    binding=dict(await store.binding('alice','weixin'))
    calls=[]
    class HTTP:
        def request(self,method,url,**kwargs):
            calls.append(kwargs['json'])
            class Response:
                status=200
                async def __aenter__(self): return self
                async def __aexit__(self,*args): pass
                async def json(self): return {'ret':0}
            return Response()
    client=Weixin('bot-alice','secret',store,binding,HTTP())
    try:
        with pytest.raises(web.HTTPBadRequest): await store.groups('alice',True,[])
        wrong=group_message(); wrong['msgs'][0]['room_id']='other-room'
        await client.receive_batch(wrong)
        async with entry.database.acquire() as db: assert await db.fetchval('SELECT count(*) FROM messaging_inbox')==0
        await client.receive_batch(group_message())
        async with entry.database.acquire() as db: row=await db.fetchrow('SELECT * FROM messaging_inbox')
        await client.send(json.loads(row['payload']),'group answer')
        assert calls[0]['msg']['to_user_id']=='allowed-room'
        assert calls[0]['msg']['context_token']=='secret-context'
    finally: await entry.database.close()
