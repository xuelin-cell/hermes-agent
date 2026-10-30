"""Private relay handshake and frame handlers; platform sending lives in channels_service."""
import asyncio
import json

import aiohttp
from aiohttp import web
from plugins.cloud_messaging.media import MAX_WIRE_BYTES
from .channels_auth import verify_upgrade

async def execution_status(service,ws,frame,context):
    future = ws.probes.get(frame.get('delivery_id'))
    if future and not future.done() and frame.get('workerId')==ws.worker_id:
        future.set_result(frame.get('state'))


async def inbound_ack(service,ws,frame,context):
    user,epoch,revision,binding = context
    async with service.database.acquire() as db:
        await db.execute("UPDATE messaging_inbox SET state='running' WHERE delivery_id=$1 AND user_id=$2 AND binding_id=$3 AND binding_revision=$4 AND instance_epoch=$5 AND execution_ref=$6 AND state='accepted' AND lease_until>now()",
            frame.get('bufferId',''),user,binding['id'],revision,epoch,ws.worker_id)


async def outbound(service,ws,frame,context):
    user,epoch,revision,binding = context
    action = frame.get('action') or {}
    meta = action.get('metadata') or {}
    if action.get('op') not in {'send','send_media'} or (action.get('op')=='send' and not isinstance(action.get('content'), str)):
        result = {'success':False,'error':'Unsupported text operation'}
    else:
        async with service.database.acquire() as db:
            row = await db.fetchrow('SELECT * FROM messaging_inbox WHERE delivery_id=$1 AND user_id=$2',meta.get('delivery_id',''),user)
            generation = await db.fetchval('SELECT state_epoch FROM tenant_runtime WHERE user_id=$1',user)
        if not row or row['binding_id'] != binding['id'] or generation != epoch or row['execution_ref'] != ws.worker_id or meta.get('binding_id') != binding['id'] or meta.get('binding_revision') != revision or action.get('chat_id') != row['external_chat_id']:
            await service.send_frame(ws,{'type':'outbound_result','requestId':frame['requestId'],'result':{'success':False,'error':'Execution ownership not confirmed'}})
            return
        if action['op']=='send_media':
            try: outbound_id=await service.store.record_media(row['delivery_id'],row['lease_owner'],epoch,action.get('media'))
            except ValueError:
                await service.send_frame(ws,{'type':'outbound_result','requestId':frame['requestId'],'result':{'success':False,'error':'Attachment is invalid or exceeds the media limit'}})
                return
        else:
            outbound_id = await service.store.complete(row['delivery_id'], row['lease_owner'], epoch, {'content':action['content']})
        result = {'success':True,'message_id':outbound_id}
    await service.send_frame(ws,{'type':'outbound_result','requestId':frame['requestId'],'result':result})


async def going_idle(service,ws,frame,context):
    await service.send_frame(ws,{'type':'going_idle_ack'})


FRAME_HANDLERS = {
    'execution_status': execution_status,
    'inbound_ack': inbound_ack,
    'outbound': outbound,
    'going_idle': going_idle,
}


async def relay(service, request):
    auth = request.headers.get('Authorization', '').removeprefix('Bearer ')
    identity = verify_upgrade(auth, service.s.channels_key)
    if not identity or len(identity)!=4: raise web.HTTPUnauthorized()
    user, epoch, revision, binding_id = identity
    async with service.database.acquire() as db:
        current = await db.fetchval('SELECT state_epoch FROM tenant_runtime WHERE user_id=$1',user)
        binding = await db.fetchrow("SELECT b.* FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id WHERE b.user_id=$1 AND u.status='active' AND b.enabled AND b.deleted_at IS NULL AND b.id=$2",user,binding_id)
    if current != epoch or not binding or binding['revision'] != revision: raise web.HTTPForbidden()
    ws = web.WebSocketResponse(timeout=2,heartbeat=30,max_msg_size=MAX_WIRE_BYTES)
    ws.binding_id=binding['id']
    await ws.prepare(request)
    ws.probes = {}
    try:
        async with asyncio.timeout(15):
            hello = await ws.receive_json()
            if (hello.get('type'), hello.get('capability'), hello.get('platform'), hello.get('botId')) != (
                    'hello', 'entry-forward-relay-v1', binding['platform'], binding['bot_key']) or not isinstance(hello.get('workerId'),str) or len(hello['workerId'])!=32:
                await ws.close(code=4401)
                return ws
        ws.worker_id = hello['workerId']
        old = service.sockets.get(user)
        if old: await old[1].close()
        service.sockets[user] = (epoch, ws, revision)
        descriptor = {'contract_version':1,'platform':binding['platform'],'label':binding['platform'],'max_message_length':20000,'supports_draft_streaming':False,'supports_edit':False,'supports_threads':False,'markdown_dialect':'plain','len_unit':'chars','supported_ops':['send','send_media'],'pii_safe':True}
        await service.send_frame(ws,{'type':'descriptor','descriptor':descriptor})
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT: continue
            frame = json.loads(msg.data)
            handler = FRAME_HANDLERS.get(frame.get('type'))
            if handler: await handler(service,ws,frame,(user,epoch,revision,binding))
    finally:
        for future in ws.probes.values():
            if not future.done(): future.set_exception(RuntimeError('Relay disconnected during probe'))
        if service.sockets.get(user) == (epoch, ws, revision): service.sockets.pop(user,None)
    return ws
