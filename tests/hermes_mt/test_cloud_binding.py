"""Central service provisioning crosses real HTTP, PG and encrypted tenant config."""
import asyncio
import json
from dataclasses import replace

import pytest
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.config import Settings
from entry.messaging_credentials import cloud_binding


BODY={'uniagentgate':{'gateway_url':'https://gateway.test','agent_id':'cloud-bot','agent_sk':'never-print-agent-secret'},
      'my_plan':{'apiKey':'sk-never-print-model-secret','models':json.dumps({'models':[{'id':'main','model':'model-name',
          'provider':'yuanjing','base_url':'https://model.test/plan/endpoint','context_window':64000}],'main_model_id':'main'})}}
PATH='/agents/api/channels/uniagentgate/cloud-binding/'


async def setup(dsn,**overrides):
    settings=Settings(database_url=dsn,credential_key=Fernet.generate_key().decode(),backend='cube',
        channels_key='relay-secret',channels_relay_url='ws://entry.test/agents/api/__entry/messaging/relay',**overrides)
    app=build_app(settings)
    entry=next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__=='login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    await entry.database.connect()
    for user in ('alice','bob'):
        await entry.store.finish_login(user_id=user,phone='',api_key='sk-original',endpoint=None,catalog=None,ttl_s=3600,upstream_expires_at_ms=None,login_method='sms')
    return app,entry


@pytest.mark.asyncio
async def test_provision_idempotence_rotation_models_and_delete(postgres_database_url):
    app,entry=await setup(postgres_database_url)
    try:
        async with TestClient(TestServer(app)) as client:
            # The central service uses the UniClaw contract without a new auth header.
            response=await client.get(PATH+'alice')
            assert response.status==200 and not (await response.json())['bound']
            response=await client.put(PATH+'alice',json=BODY)
            assert response.status==200 and await response.json()=={'ok':True}
            binding=await entry.messaging_routes.store.binding('alice')
            assert binding['enabled'] and binding['source']=='service-provision'
            assert bytes(binding['secret_enc'])!=BODY['uniagentgate']['agent_sk'].encode()
            context=await entry.store.get_tenant_context('alice')
            assert context.api_key==BODY['my_plan']['apiKey']
            assert context.endpoint==('https://model.test/plan/endpoint/v1','model-name')
            assert context.limits=={'model-name':64000}
            delivery=await entry.messaging_routes.store.ingest(binding['id'],binding['revision'],'chat','msg',{'safe':True})
            changed={**BODY,'my_plan':{**BODY['my_plan'],'apiKey':'sk-new-model-key'}}
            assert (await client.put(PATH+'alice',json=changed)).status==200
            same=await entry.messaging_routes.store.binding('alice')
            assert same['revision']==binding['revision']
            assert (await entry.store.get_tenant_context('alice')).api_key=='sk-new-model-key'
            async with entry.database.acquire() as db:
                assert await db.fetchval('SELECT state FROM messaging_inbox WHERE delivery_id=$1',delivery)=='queued'
            state=await client.get(PATH+'alice')
            snapshot=await state.json()
            assert snapshot['bound'] and snapshot['state']=='stopped'
            assert 'secret' not in json.dumps(snapshot) and 'gateway.test' not in json.dumps(snapshot)
            # Cross-account ownership collision cannot partially overwrite model credentials.
            conflict=await client.put(PATH+'bob',json=BODY)
            assert conflict.status==409
            assert (await entry.store.get_tenant_context('bob')).api_key=='sk-original'
            rotated={**BODY,'uniagentgate':{**BODY['uniagentgate'],'agent_sk':'rotated-secret'}}
            assert (await client.put(PATH+'alice',json=rotated)).status==200
            newer=await entry.messaging_routes.store.binding('alice')
            assert newer['revision']>binding['revision']
            async with entry.database.acquire() as db:
                assert await db.fetchval('SELECT state FROM messaging_inbox WHERE delivery_id=$1',delivery)=='cancelled'
            await entry.messaging_routes.store.configure('alice','','wecom-bot','wecom-secret',platform='wecom',enable=True)
            for _ in range(2):
                assert (await client.delete(PATH+'alice')).status==200
            assert (await client.get(PATH+'alice')).status==200
            assert not (await (await client.get(PATH+'alice')).json())['bound']
            assert (await entry.messaging_routes.store.binding('alice','wecom'))['enabled']
            assert (await client.delete(PATH+'unknown')).status==200
            assert (await client.get(PATH+'unknown')).status==404
    finally:
        await entry.database.close()


@pytest.mark.asyncio
async def test_validation_allowlist_and_concurrent_binding_ownership(postgres_database_url):
    app,entry=await setup(postgres_database_url)
    try:
        async with TestClient(TestServer(app)) as client:
            invalid={**BODY,'my_plan':{**BODY['my_plan'],'models':'{agent-secret-invalid-json'}}
            response=await client.put(PATH+'alice',json=invalid)
            assert response.status==422 and 'agent-secret-invalid-json' not in await response.text()
            assert await entry.messaging_routes.store.binding('alice') is None
            entry.s=replace(entry.s,channels_gateway_origins='https://other-gateway.test')
            assert (await client.put(PATH+'alice',json=BODY)).status==422
            entry.s=replace(entry.s,channels_gateway_origins='')
            results=await asyncio.gather(*(client.put(PATH+user,json=BODY) for user in ('alice','bob')))
            assert sorted(response.status for response in results)==[200,409]
            assert cloud_binding({'ipUrl':'https://trusted-login.test','agentIdCloud':'bot','agentKeyCloud':'sk'},set())[0]=='available'
            # Login uses the same enable-on-bind policy; retrying it preserves the revision.
            await entry.messaging_routes.apply_login('alice',{'ipUrl':'https://login.test','agentIdCloud':'login-bot','agentKeyCloud':'login-secret'})
            first=await entry.messaging_routes.store.binding('alice')
            await entry.messaging_routes.apply_login('alice',{'ipUrl':'https://login.test','agentIdCloud':'login-bot','agentKeyCloud':'login-secret'})
            again=await entry.messaging_routes.store.binding('alice')
            assert first['enabled'] and again['revision']==first['revision']
    finally:
        await entry.database.close()


@pytest.mark.asyncio
async def test_provision_creates_an_unknown_user_but_never_revives_a_disabled_one(postgres_database_url):
    """The central service pushes 5G users who never opened the web app, and UniClaw serves them.
    The first push creates the user without a login session; it never re-enables an operator-disabled
    user, and a rejected push leaves no user behind."""
    app,entry=await setup(postgres_database_url)
    store=entry.messaging_routes.store
    try:
        async with TestClient(TestServer(app)) as client:
            assert (await client.get(PATH+'carol')).status==404
            assert (await client.put(PATH+'carol',json=BODY)).status==200
            binding=await store.binding('carol')
            assert binding['enabled'] and binding['source']=='service-provision'
            assert (await entry.store.get_tenant_context('carol')).api_key==BODY['my_plan']['apiKey']
            assert (await (await client.get(PATH+'carol')).json())['bound']
            async with entry.database.acquire() as db:
                assert await db.fetchval("SELECT count(*) FROM auth_sessions WHERE user_id='carol'")==0
                await db.execute("UPDATE users SET status='disabled' WHERE user_id='bob'")
            other={**BODY,'uniagentgate':{**BODY['uniagentgate'],'agent_id':'bob-bot'}}
            assert (await client.put(PATH+'bob',json=other)).status==404
            assert await store.binding('bob') is None
            # carol already owns cloud-bot, so pushing it for a new user conflicts and creates nobody.
            assert (await client.put(PATH+'dave',json=BODY)).status==409
            async with entry.database.acquire() as db:
                assert await db.fetchval("SELECT status FROM users WHERE user_id='bob'")=='disabled'
                assert await db.fetchval("SELECT count(*) FROM users WHERE user_id='dave'")==0
    finally:
        await entry.database.close()


@pytest.mark.asyncio
async def test_only_the_account_service_source_may_provision(postgres_database_url):
    """The contract has no credential yet creates users and writes model keys, so an unlisted source
    is refused before anything is read or written; nginx overwrites X-Real-IP with the TCP peer."""
    app,entry=await setup(postgres_database_url,channels_binding_allow='192.168.2.182')
    try:
        async with TestClient(TestServer(app)) as client:
            stranger={'X-Real-IP':'10.0.0.9'}
            assert (await client.put(PATH+'carol',json=BODY,headers=stranger)).status==403
            assert (await client.get(PATH+'alice',headers=stranger)).status==403
            assert (await client.put(PATH+'carol',json=BODY)).status==403
            async with entry.database.acquire() as db:
                assert await db.fetchval("SELECT count(*) FROM users WHERE user_id='carol'")==0
            assert (await client.put(PATH+'carol',json=BODY,headers={'X-Real-IP':'192.168.2.182'})).status==200
            assert (await entry.messaging_routes.store.binding('carol'))['enabled']
    finally:
        await entry.database.close()


@pytest.mark.asyncio
async def test_login_takes_back_a_replaced_cloud_agent_but_keeps_a_live_connection(postgres_database_url):
    """Another deployment holding the same agentIdCloud makes the gateway replace our client, which
    then stands down for good. Logging in again must reconnect it (as UniClaw does), never while this
    deployment is the live holder, and never by bumping the revision that keys in-flight receipts."""
    app,entry=await setup(postgres_database_url)
    plan={'ipUrl':'https://login.test','agentIdCloud':'login-bot','agentKeyCloud':'login-secret'}
    routes=entry.messaging_routes
    reconnect_id=lambda row: json.loads(row['config']).get('reconnect_id')
    try:
        await routes.apply_login('alice',plan)
        first=await routes.store.binding('alice')
        async with entry.database.acquire() as db:
            await db.execute("UPDATE messaging_bindings SET connection_state='stopped',updated_at=now() WHERE id=$1",first['id'])
        await routes.apply_login('alice',plan)
        retaken=await routes.store.binding('alice')
        assert reconnect_id(retaken) and reconnect_id(retaken)!=reconnect_id(first)
        assert retaken['revision']==first['revision']

        async with entry.database.acquire() as db:
            await db.execute("UPDATE messaging_bindings SET connection_state='running',updated_at=now() WHERE id=$1",first['id'])
        await routes.apply_login('alice',plan)
        live=await routes.store.binding('alice')
        assert reconnect_id(live)==reconnect_id(retaken) and live['connection_state']=='running'
    finally:
        await entry.database.close()
