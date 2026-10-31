"""Real Entry/PG and Node desktop protocols against local SSE and speech WebSocket services."""
import asyncio
import base64
import json
import time
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.config import Settings
from entry.drive_worker import DriveWorker
from hermes_platform.resolver import locate_command

REPO=Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_notification_and_speech_reuse_protocols_without_exposing_credentials_or_crossing_users(tmp_path, postgres_database_url):
    connections=[]
    audio=[]
    upstream=web.Application()
    async def token(request):
        auth=request.headers['Authorization']
        assert auth.startswith('Bearer login-')
        owner=auth.removeprefix('Bearer login-')
        return web.json_response({'code':0,'data':{'token':'subscription-'+owner,'expires':int(time.time())+600}})
    async def events(request):
        owner=request.headers['Authorization'].removeprefix('Bearer subscription-')
        response=web.StreamResponse(headers={'Content-Type':'text/event-stream'})
        await response.prepare(request)
        await response.write(('data: '+json.dumps({'event':'message','id':'notice-'+owner,'message':'Hello '+owner,'time':time.time(),'tags':[]})+'\n\n').encode())
        try:
            while request.transport and not request.transport.is_closing():
                await asyncio.sleep(.05)
        except asyncio.CancelledError: raise
        return response
    async def speech(request):
        key=request.headers['Authorization']
        assert key in {'Bearer plan-a','Bearer plan-b'}
        ws=web.WebSocketResponse()
        await ws.prepare(request)
        connections.append(ws)
        async for message in ws:
            if message.type==aiohttp.WSMsgType.BINARY:
                audio.append((key,message.data))
                await ws.send_json({'text':'Transcript '+key[-1],'is_final':True})
            elif message.type==aiohttp.WSMsgType.TEXT:
                value=json.loads(message.data)
                if value.get('eof'):
                    await ws.close()
                else: assert value['config']['samp_freq']==16000
        return ws
    upstream.router.add_get('/app/gateway/uniwork/ntfy-token',token)
    upstream.router.add_get('/app/ntfy/{tail}/sse',events)
    upstream.router.add_get('/speech',speech)
    app=build_app(Settings(database_url=postgres_database_url,credential_key=Fernet.generate_key().decode(),backend='docker'))
    entry=next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__=='login')
    app.on_startup.clear();app.on_cleanup.clear()
    async def stop_account(_): await entry.account_routes.close()
    app.on_shutdown.append(stop_account)
    async def warm(_): pass
    entry._warm=warm
    await entry.database.connect()
    node=locate_command('node').command[0]
    try:
        async with TestServer(upstream, shutdown_timeout=.1) as external:
            script=tmp_path/'worker.mjs'
            origin=str(external.make_url('')).rstrip('/')
            websocket=str(external.make_url('/speech')).replace('http:','ws:')
            builder='''import {build} from 'esbuild';
const root=process.argv[1], out=process.argv[2], origin=process.argv[3], websocket=process.argv[4];
await build({entryPoints:[root+'/apps/desktop/electron/login/cloud-account-worker.ts'],bundle:true,platform:'node',format:'esm',outfile:out,logLevel:'silent',
 banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},
 plugins:[{name:'fixtures',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));
  b.onLoad({filter:/electron/,namespace:'fixture'},()=>({contents:'export const net={fetch:(url,opts)=>{const value=new URL(url);return fetch('+JSON.stringify(origin)+'+value.pathname+value.search,opts)}}'}));
  b.onResolve({filter:/^ws$/},()=>({path:'ws',namespace:'fixture'}));
  b.onLoad({filter:/^ws$/,namespace:'fixture'},()=>({resolveDir:root,contents:'import WS from '+JSON.stringify(root+'/node_modules/ws/wrapper.mjs')+';export default class extends WS {constructor(url,opts){super('+JSON.stringify(websocket)+',opts)}}'}));
 }}]});'''
            process=await asyncio.create_subprocess_exec(node,'--input-type=module','-e',builder,str(REPO),str(script),origin,websocket,cwd=REPO)
            assert await process.wait()==0
            await entry.account_routes.close()
            entry.account_routes.worker=DriveWorker(script,node=node)
            async with aiohttp.ClientSession() as http, TestClient(TestServer(app),cookie_jar=aiohttp.DummyCookieJar()) as client:
                entry.http=http
                identities={}
                for owner,phone in [('a','13800001111'),('b','13800002222')]:
                    login=await entry._finish_login(owner,'plan-'+owner,int((time.time()+3600)*1000),phone=phone,maas_token='login-'+owner)
                    identities[owner]={'cookies':{name:value.value for name,value in login.cookies.items()},'headers':{'Authorization':'Bearer login-'+owner}}
                async def call(owner,action,data=None,status=200):
                    response=await client.post('/hermes/__entry/account/'+action,json=data or {},**identities[owner])
                    body=await response.text()
                    assert response.status==status,body
                    return json.loads(body) if status==200 else body
                for owner in ('a','b','a'):
                    await call(owner,'notify-start')
                    async with asyncio.timeout(5):
                        while True:
                            batch=await call(owner,'notify-poll',{'cursor':0})
                            notices=[event for event in batch['events'] if event['kind']=='announcement']
                            if notices: break
                            await asyncio.sleep(.02)
                    assert [item['announcement']['text'] for item in notices]==['Hello '+owner]
                    assert 'subscription-' not in json.dumps(batch) and 'login-' not in json.dumps(batch)
                    assert not (await call(owner,'notify-poll',{'cursor':batch['cursor']}))['events']
                session=await call('a','asr-start',{'language':'zh'})
                await call('b','asr-poll',{'session':session},502)
                raw=b'\x01\x00'*256
                await call('a','asr-audio',{'session':session,'pcm':base64.b64encode(raw).decode()})
                async with asyncio.timeout(5):
                    while True:
                        result=await call('a','asr-poll',{'session':session})
                        if result['transcripts']: break
                        await asyncio.sleep(.02)
                assert result['transcripts']==[{'text':'Transcript a','final':True}]
                assert audio==[('Bearer plan-a',raw)]
                assert 'plan-a' not in json.dumps(result)
                assert (await call('a','asr-stop',{'session':session}))['closed']
                await call('a','asr-audio',{'session':session,'pcm':'AQ=='},400)
                await call('a','asr-start',{'language':'zh','url':'http://forged','apiKey':'forged'},400)
                await client.post('/hermes/__entry/logout',**identities['a'])
                await call('a','notify-poll',status=401)
                assert (await call('b','notify-poll',{'cursor':0}))['events']
    finally:
        await entry.account_routes.close()
        await entry.drive_routes.close()
        await entry.database.close()
        for ws in connections: await ws.close()
