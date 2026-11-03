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
PATH='/hermes/api/channels/uniagentgate/cloud-binding/'


async def setup(dsn):
    settings=Settings(database_url=dsn,credential_key=Fernet.generate_key().decode(),backend='cube',
        channels_key='relay-secret',channels_relay_url='ws://entry.test/hermes/__entry/messaging/relay')
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
            assert (await client.put(PATH+'missing',json=BODY)).status==404
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
