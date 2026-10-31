"""Real PG/Entry/forwarder/relay: reconnects reconcile receipts, never repeat a turn."""
import asyncio
import base64
import importlib.util
import json
import os
import sys
import tempfile
import sqlite3
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from entry.channels_service import Channels
from entry.messaging_relay import InstanceRelays
from gateway.config import PlatformConfig
from plugins.cloud_messaging.adapter import CloudMessagingAdapter
from plugins.cloud_messaging.media import unpack
from tests.hermes_mt.test_messaging_media import context
from tests.hermes_mt.test_messaging import wait_for

SEED = Path(__file__).resolve().parents[2] / 'deploy/hermes-mt/seed'


class Environment:
    async def start(self, tmp_path, monkeypatch, dsn, *, live=False,user='alice',channel='dingtalk',mcp_servers=None,completion_handler=None,tool_search=False):
        import plugins.cloud_messaging.transport as transport
        monkeypatch.setattr(transport, 'PORT', 0)
        self.settings, self.app, self.entry, self.binding, self.epoch, self.delivery = await context(dsn,channel,user)
        self.service = Channels(self.settings, {})
        self.service.database = self.entry.database
        self.service.store = self.entry.messaging_routes.store
        self.home = tmp_path / 'home'
        self.home.mkdir(parents=True)
        monkeypatch.setenv('HERMES_HOME',str(self.home))
        monkeypatch.setenv('HERMES_RUNTIME_DIR',str(tmp_path/'runtime'))
        spec = importlib.util.spec_from_file_location('messaging_test_forward',SEED/'forward.py')
        self.forward = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.forward)
        self.forward._hermes_token = 'instance-token'
        self.forward._bootstrapped = True
        self.adapter = None
        self.executions = []
        self.started, self.release = asyncio.Event(), asyncio.Event()
        self.task = None
        self.live = live
        self.model = None
        self.runtime = None

        async def start(settings, env):
            # Replace only process creation: real adapter listener, readiness probe,
            # raw TCP forwarder, auth, Entry bridge and channels use production code.
            if not self.adapter or settings != self.adapter.settings:
                if self.adapter: await self.adapter.disconnect()
                self.adapter = CloudMessagingAdapter(PlatformConfig(enabled=True),settings,self.home)
                async def turn(event):
                    self.executions.append((event.message_id,event.source.platform.value))
                    self.adapter.ledger.running(event.message_id)
                    self.started.set()
                    await self.release.wait()
                    await self.adapter.send(event.source.chat_id,'one frozen result')
                self.adapter.set_message_handler(turn)
                await self.adapter.connect()
                self.adapter._transport.open_admission()
                site = next(iter(self.adapter._transport.runner.sites))
                self.forward._messaging_gateway.port = site._server.sockets[0].getsockname()[1]
            gateway = self.forward._messaging_gateway
            gateway.process = SimpleNamespace(returncode=None)
            gateway.settings = settings
            return await gateway.ready(settings)
        if live:
            import yaml
            async def completion(request):
                body = await request.json()
                if completion_handler: return await completion_handler(body)
                self.executions.append((self.delivery,'dingtalk'))
                self.started.set()
                await self.release.wait()
                if body.get('stream'):
                    chunk={'id':'fixture-completion','object':'chat.completion.chunk','created':1,'model':body['model'],
                        'choices':[{'index':0,'delta':{'role':'assistant','content':'one frozen result'},'finish_reason':None}]}
                    end={**chunk,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],
                        'usage':{'prompt_tokens':20,'completion_tokens':4,'total_tokens':24}}
                    return web.Response(text='data: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(end)+'\n\ndata: [DONE]\n\n',content_type='text/event-stream')
                return web.json_response({'id':'fixture-completion','object':'chat.completion','created':1,
                    'model':body['model'],'choices':[{'index':0,'message':{'role':'assistant','content':'one frozen result'},'finish_reason':'stop'}],
                    'usage':{'prompt_tokens':20,'completion_tokens':4,'total_tokens':24}})
            model_app = web.Application()
            model_app.router.add_post('/v1/chat/completions',completion)
            self.model = TestServer(model_app)
            await self.model.start_server()
            endpoint = str(self.model.make_url('/v1')).rstrip('/')
            (self.home/'config.yaml').write_text(yaml.safe_dump({'model':{
                'default':'fixture','provider':'custom','base_url':endpoint,'context_length':131072},
                'streaming':{'enabled':True},'toolsets':[],'plugins':{'enabled':['cloud-messaging']},
                'tools':{'tool_search':tool_search},'mcp_servers':mcp_servers or {}}))
            (self.home/'.env').write_text('OPENAI_API_KEY=fixture\nOPENAI_BASE_URL='+endpoint+'\n')
            self.runtime = tempfile.TemporaryDirectory(prefix='hm-im-',dir='/tmp')
            self.forward.HERMES_PYTHON = sys.executable
            self.forward._messaging_gateway.python = sys.executable
            self.forward._hermes_env = {'HERMES_RUNTIME_DIR':self.runtime.name,
                'PYTHONPATH':str(SEED.parents[2])}
        else:
            self.forward._messaging_gateway.start = start
        self.tcp = await asyncio.start_server(self.forward._handle,'127.0.0.1',0)
        origin = '127.0.0.1:'+str(self.tcp.sockets[0].getsockname()[1])
        async def ensure(requested_user, touch=False):
            assert requested_user==user and not touch
            return SimpleNamespace(origin=origin,token='instance-token',host_header='',traffic_token='')
        self.entry.tenants = SimpleNamespace(ensure_running=ensure)
        self.http = aiohttp.ClientSession()
        self.entry.http = self.service.http = self.http
        relay = web.Application()
        relay.router.add_get('/relay',self.service.relay)
        self.relay = TestServer(relay)
        await self.relay.start_server()
        self.entry.s = replace(self.settings,channels_url=str(self.relay.make_url('')).rstrip('/'))
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.service.config['entry_url'] = str(self.client.make_url('')).rstrip('/')
        self.service.owner = 'lease-owner'
        async with self.entry.database.acquire() as db:
            await db.execute("UPDATE messaging_inbox SET state='dispatching',payload=$2::jsonb WHERE delivery_id=$1",
                self.delivery,json.dumps({'event':{'text':'execute once','source':{'platform':'dingtalk','chat_id':'chat','user_id':'peer','chat_type':'dm'}}}))
        if channel=='uniagentgate':
            payload={'type':'agent.request','agent_id':self.binding['bot_key'],'message_id':'external',
                'channel':{'phone_number':'13800000000'},'session_id':'5g-session','turn_id':'5g-turn',
                'payload':{'inputs':[{'type':'text','text':'请调用 MCP 工具画一张小猫图片'}]}}
            async with self.entry.database.acquire() as db:
                await db.execute("UPDATE messaging_inbox SET external_chat_id='13800000000',payload=$2::jsonb WHERE delivery_id=$1",
                    self.delivery,json.dumps(payload))
        return self

    async def close(self):
        self.release.set()
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)
        await self.entry.messaging_routes.relays.close()
        if self.live: await self.forward._messaging_gateway.stop()
        if self.adapter: await self.adapter.disconnect()
        if self.model: await self.model.close()
        if self.runtime: self.runtime.cleanup()
        self.tcp.close()
        await self.tcp.wait_closed()
        await self.client.close()
        await self.relay.close()
        await self.http.close()
        await self.entry.database.close()

    async def row(self):
        async with self.entry.database.acquire() as db:
            return await db.fetchrow('SELECT * FROM messaging_inbox WHERE delivery_id=$1',self.delivery)

    async def dispatch(self):
        self.task = asyncio.create_task(self.service.deliver(dict(await self.row())))
        try:
            await asyncio.wait_for(self.started.wait(),45)
        except TimeoutError:
            logs = self.home/'logs'
            details = '\n'.join(path.name+'\n'+path.read_text(errors='replace')[-18000:] for path in logs.glob('*.log'))
            raise AssertionError(details) from None

    async def restart_entry(self):
        self.task.cancel()
        await asyncio.gather(self.task,return_exceptions=True)
        await self.entry.messaging_routes.relays.close()
        self.entry.messaging_routes.relays = InstanceRelays(self.entry)
        self.service.owner = 'restarted-owner'
        async with self.entry.database.acquire() as db:
            await db.execute('UPDATE messaging_inbox SET next_at=now() WHERE delivery_id=$1',self.delivery)
        recovery = await self.service.store.claim_recovery(self.service.owner)
        if not recovery:
            async with self.entry.database.acquire() as db:
                outputs = await db.fetch('SELECT payload FROM messaging_outbox WHERE delivery_id=$1',self.delivery)
            raise AssertionError((dict(await self.row()),[dict(row) for row in outputs]))
        assert recovery['delivery_id']==self.delivery
        self.task = asyncio.create_task(self.service.deliver(recovery))


@pytest.mark.asyncio
@pytest.mark.parametrize('frozen',[False,True,'live','ack-loss'])
async def test_entry_restart_reuses_original_execution_and_frozen_result(tmp_path,monkeypatch,postgres_database_url,frozen):
    env = await Environment().start(tmp_path,monkeypatch,postgres_database_url,live=frozen=='live')
    try:
        if frozen=='ack-loss':
            send_frame = env.service.send_frame
            async def lose_ack(ws,frame):
                if frame.get('type')=='outbound_result' and frame.get('result',{}).get('success'):
                    await ws.close()
                else: await send_frame(ws,frame)
            env.service.send_frame = lose_ack
        await env.dispatch()
        # Browser-style session token cannot access the protected forwarder WS.
        port = env.tcp.sockets[0].getsockname()[1]
        response = await env.http.get(f'http://127.0.0.1:{port}/__mt/messaging/relay',headers={
            'Upgrade':'websocket','X-Hermes-Session-Token':'instance-token'})
        assert response.status==403
        if frozen is True:
            # Tool/turn already finished, but its result has not reached PG yet.
            env.adapter.ledger.complete(env.delivery,'one frozen result')
        if frozen=='ack-loss':
            env.release.set()
            async def saved(): return (await env.row())['state']=='completed'
            await wait_for(saved)
            env.service.send_frame = send_frame
            await env.entry.messaging_routes.relays.close()
            env.entry.messaging_routes.relays = InstanceRelays(env.entry)
            # A later wake replays the frozen receipt, never the original turn.
            following = await env.service.store.ingest(env.binding['id'],env.binding['revision'],'chat','following',{})
            await env.service.store.claim(env.service.owner)
            tenant = await env.entry.tenants.ensure_running('alice',touch=False)
            await env.entry.messaging_routes.relays.ensure(dict(env.binding,binding_id=env.binding['id']),tenant,env.epoch)
            assert (await env.adapter._publish(env.delivery,'chat','one frozen result')).success
            assert env.executions==[(env.delivery,'dingtalk')]
            async with env.entry.database.acquire() as db:
                assert await db.fetchval('SELECT count(*) FROM messaging_outbox WHERE delivery_id=$1',env.delivery)==1
            return
        await env.restart_entry()
        async def recovered():
            row = await env.row()
            return row['lease_owner']=='restarted-owner' and row['state'] in {'accepted','running','completed'}
        await wait_for(recovered)
        env.release.set()
        async def completed(): return (await env.row())['state']=='completed'
        try:
            await wait_for(completed)
        except TimeoutError:
            details = '\n'.join(path.name+'\n'+path.read_text(errors='replace')[-24000:] for path in (env.home/'logs').glob('*.log'))
            raise AssertionError((dict(await env.row()),details)) from None
        if env.live:
            # Titling/other auxiliary model requests aren't additional user turns.
            # Assert the real engine's durable transcript and frozen output instead.
            with sqlite3.connect(env.home/'state.db') as state:
                assert state.execute("SELECT count(*) FROM sessions WHERE source='dingtalk'").fetchone()[0]==1
                assert state.execute("SELECT count(*) FROM messages WHERE role='user'").fetchone()[0]==1
                assert state.execute("SELECT count(*) FROM messages WHERE role='assistant' AND content LIKE '%one frozen result%'").fetchone()[0]==1
        else:
            assert env.executions==[(env.delivery,'dingtalk')]
        async with env.entry.database.acquire() as db:
            assert await db.fetchval('SELECT count(*) FROM messaging_outbox WHERE delivery_id=$1',env.delivery)==1
        # The handshake and idle heartbeat alone must not hold the instance awake.
        async def closed(): return not env.entry.messaging_routes.relays.sessions
        await wait_for(closed)
    finally:
        await env.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('changed',['worker','epoch','binding','A-B-A','old-template'])
async def test_changed_generation_cannot_reexecute_or_accept_stale_results(tmp_path,monkeypatch,postgres_database_url,changed):
    env = await Environment().start(tmp_path,monkeypatch,postgres_database_url)
    try:
        if changed=='old-template':
            async def legacy(settings, environment): return {'ok':True,'pid':1}
            env.forward._messaging_gateway.start = legacy
            response = await env.client.post('/hermes/__entry/messaging/wake',json={
                'delivery_id':env.delivery,'owner':env.service.owner},headers={'Authorization':'Bearer '+env.settings.channels_key})
            assert response.status==502 and '模板' in await response.text()
            assert (await env.row())['state']=='dispatching'
            assert not env.executions
            return
        await env.dispatch()
        if changed=='A-B-A':
            other = await Environment().start(tmp_path/'bob',monkeypatch,postgres_database_url,user='bob')
            try:
                await other.dispatch()
                other.release.set()
                async def other_done(): return (await other.row())['state']=='completed'
                await wait_for(other_done)
                assert other.executions==[(other.delivery,'dingtalk')]
            finally:
                await other.close()
            await env.restart_entry()
            env.release.set()
            async def first_done(): return (await env.row())['state']=='completed'
            await wait_for(first_done)
            assert env.executions==[(env.delivery,'dingtalk')]
            return
        if changed=='worker':
            # A new worker with the same instance epoch and a missing restored ledger
            # must NOT treat missing as proof of non-delivery.
            env.adapter._transport.worker_id = 'f'*32
            with env.adapter.ledger.open() as db: db.execute('DELETE FROM executions')
        elif changed=='epoch':
            await env.entry.store.next_epoch('alice')
            with env.adapter.ledger.open() as db: db.execute('DELETE FROM executions')
        else:
            await env.service.store.set_enabled('alice',False,platform='dingtalk')
        if changed=='binding':
            async def closed(): return not env.entry.messaging_routes.relays.sessions
            await wait_for(closed)
            env.release.set()
            assert not (await env.adapter.send('chat','stale')).success
        else:
            await env.restart_entry()
            async def uncertain():
                row = await env.row()
                return row['state']=='uncertain' and row['error_code']=='execution_unverifiable' and row['lease_until'] is None
            await wait_for(uncertain)
            assert not await env.service.store.claim_recovery('third-owner')
        assert len(env.executions)==1
        async with env.entry.database.acquire() as db:
            assert not await db.fetchval('SELECT 1 FROM messaging_outbox WHERE delivery_id=$1',env.delivery)
    finally:
        await env.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('deferred',[False,True])
async def test_5g_draw_request_calls_authenticated_mcp_and_delivers_image(tmp_path,monkeypatch,postgres_database_url,deferred):
    calls=[]
    image=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1kAAAAASUVORK5CYII=')
    output=tmp_path/'home'/'workspace'/'cat.png'
    async def mcp(request):
        assert request.headers.get('X-Hermes-Session-Token')=='instance-token'
        if request.method=='GET': return web.Response(status=405)
        if request.method=='DELETE': return web.Response(status=200)
        if not request.can_read_body: return web.Response(status=405)
        body=await request.json()
        method=body['method']
        if method=='initialize':
            result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'drawing-fixture','version':'1'}}
        elif method=='tools/list':
            result={'tools':[{'name':'txt2img_generate','description':'Generate a cat image using the image generation service',
                'inputSchema':{'type':'object','properties':{'prompt':{'type':'string'}},'required':['prompt']}}]}
        elif method=='tools/call':
            assert body['params']['name']=='txt2img_generate'
            calls.append(body['params']['arguments'])
            output.parent.mkdir(parents=True,exist_ok=True)
            output.write_bytes(image)
            result={'content':[{'type':'text','text':f'Generated image: {output}'}]}
        else: return web.Response(status=202)
        return web.json_response({'jsonrpc':'2.0','id':body['id'],'result':result})

    async def completion(body):
        messages=body.get('messages',[])
        # Auxiliary title requests are separate from the main tool-using turn.
        if not body.get('tools'):
            message={'role':'assistant','content':'cat drawing'}
        elif any(item.get('role')=='tool' and 'Generated image:' in str(item.get('content')) for item in messages):
            message={'role':'assistant','content':f'小猫图片已生成。\nMEDIA:{output}'}
        else:
            names=[tool['function']['name'] for tool in body['tools']]
            target='mcp__yuanjing__txt2img_generate'
            replies={item.get('tool_call_id'):str(item.get('content')) for item in messages if item.get('role')=='tool'}
            if not deferred:
                assert target in names, names
                name,args,identity=target,{'prompt':'a small cat'},'draw-once'
            elif 'find-cat' not in replies:
                assert 'tool_search' in names and target not in names, names
                name,args,identity='tool_search',{'queries':['yuanjing image generation cat']},'find-cat'
            elif 'describe-cat' not in replies:
                assert target in replies['find-cat'], replies['find-cat']
                name,args,identity='tool_describe',{'names':[target]},'describe-cat'
            else:
                assert target in replies['describe-cat'], replies['describe-cat']
                name,args,identity='tool_call',{'name':target,'arguments':{'prompt':'a small cat'}},'draw-once'
            message={'role':'assistant','content':None,'tool_calls':[{'id':identity,'type':'function','function':{
                'name':name,'arguments':json.dumps(args)}}]}
        finish='tool_calls' if 'tool_calls' in message else 'stop'
        base={'id':'model-fixture','created':1,'model':body['model']}
        if body.get('stream'):
            delta=dict(message)
            if 'tool_calls' in delta: delta['tool_calls']=[dict(item,index=i) for i,item in enumerate(delta['tool_calls'])]
            chunk={**base,'object':'chat.completion.chunk','choices':[{'index':0,'delta':delta,'finish_reason':None}]}
            end={**base,'object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':finish}]}
            return web.Response(text='data: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(end)+'\n\ndata: [DONE]\n\n',content_type='text/event-stream')
        return web.json_response({**base,'object':'chat.completion','choices':[{'index':0,'message':message,'finish_reason':finish}]})

    app=web.Application()
    app.router.add_route('*','/mcp',mcp)
    async with TestServer(app) as server:
        env=await Environment().start(tmp_path,monkeypatch,postgres_database_url,live=True,channel='uniagentgate',
            completion_handler=completion,tool_search={'enabled':'on','threshold_pct':0} if deferred else False,mcp_servers={'yuanjing':{'url':str(server.make_url('/mcp')),
                'headers':{'X-Hermes-Session-Token':'${HERMES_DASHBOARD_SESSION_TOKEN}'}}})
        try:
            env.task=asyncio.create_task(env.service.deliver(dict(await env.row())))
            async def done(): return (await env.row())['state']=='completed'
            try: await wait_for(done,timeout=60)
            except TimeoutError:
                logs='\n'.join(p.read_text(errors='replace')[-14000:] for p in (env.home/'logs').glob('*.log'))
                raise AssertionError(logs) from None
            assert calls==[{'prompt':'a small cat'}]
            async def attachments():
                async with env.entry.database.acquire() as db:
                    return await db.fetchval('SELECT count(*) FROM messaging_outbox WHERE delivery_id=$1',env.delivery)==2
            try: await wait_for(attachments,timeout=15)
            except TimeoutError:
                logs='\n'.join(p.read_text(errors='replace')[-14000:] for p in (env.home/'logs').glob('*.log'))
                raise AssertionError(logs) from None
            async with env.entry.database.acquire() as db:
                rows=await db.fetch('SELECT payload FROM messaging_outbox WHERE delivery_id=$1 ORDER BY part_index',env.delivery)
            replies=[json.loads(row['payload']) for row in rows]
            assert len(replies)==2
            assert '小猫图片已生成' in replies[0]['content']
            assert replies[1]['media']['kind']=='image'
            assert unpack(replies[1]['media'])==image
        finally:
            await env.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('channel',['uniagentgate','weixin','wecom','feishu'])
async def test_all_channel_workers_start_through_entry_owned_forward_relay(tmp_path, monkeypatch, postgres_database_url, channel):
    # All real workers share this file to serialize their fixed instance-local relay port.
    env=await Environment().start(tmp_path, monkeypatch, postgres_database_url, live=True, channel=channel)
    try:
        from entry.channels_delivery import wake
        ready = await wake(env.service, dict(await env.row()))
        assert ready['worker_id']
        pid=env.forward._messaging_gateway.process.pid
        assert pid and env.forward._messaging_gateway.process.returncode is None
        import yaml
        assert yaml.safe_load((env.home/'config.yaml').read_text())['streaming']['enabled'] is True
    finally:
        await env.close()
