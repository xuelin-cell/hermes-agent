"""Cookie-authenticated management and private lease-bound instance wakeup."""
import asyncio
import hmac
from datetime import datetime, timezone

import aiohttp
from aiohttp import web

from .channels_auth import instance_secret
from .messaging_credentials import cloud_binding
from .messaging_store import MessagingStore


class MessagingRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.store = MessagingStore(entry.database, entry.store.cipher)

    async def apply_login(self, user, plan):
        origins = {value.strip().rstrip('/') for value in self.entry.s.channels_gateway_origins.split(',') if value.strip()}
        status, binding = cloud_binding(plan,origins)
        if status == 'available':
            await self.store.configure(user,**binding)
        elif status == 'clear' and await self.store.binding(user):
            await self.store.set_enabled(user,False,remove=True)
        elif status == 'invalid':
            await self.entry.store.write_audit(user,'messaging.credentials.invalid')

    async def handle(self, request):
        session = await self.entry._require(request)
        operation = request.match_info['operation']
        data = await request.json()
        if not isinstance(data,dict) or data.get('profile','default') not in (None,'default'):
            raise web.HTTPBadRequest(text='云端消息平台只支持默认实例。')
        binding = await self.store.binding(session.user_id)
        configured = bool(binding)
        if operation in {'reconnect','enable','disable','disconnect'}:
            if not self.entry.s.channels_key or not self.entry.s.channels_relay_url or not self.entry.s.pg_lock or self.entry.s.backend != 'cube':
                raise web.HTTPServiceUnavailable(text='集中消息接入尚未部署。')
            await self.store.set_enabled(session.user_id, operation in {'reconnect','enable'}, remove=operation=='disconnect')
            binding = await self.store.binding(session.user_id)
        elif operation not in {'platforms','status','watch'}:
            raise web.HTTPBadRequest(text='首期只支持 5G 文本消息；其他平台尚未接通。')
        attention = False
        if binding:
            async with self.entry.database.acquire() as db:
                attention = bool(await db.fetchval("SELECT 1 FROM messaging_inbox WHERE binding_id=$1 AND binding_revision=$2 AND state='uncertain' LIMIT 1",binding['id'],binding['revision']))
        state = binding['connection_state'] if binding else 'stopped'
        enabled = bool(binding and binding['enabled'])
        connected = bool(state == 'running' and enabled and self.entry.s.channels_key and binding and (datetime.now(timezone.utc)-binding['updated_at']).total_seconds()<15)
        if operation == 'platforms':
            return web.json_response({'platforms':[{'id':'uniagentgate','name':'5G 消息','configured':configured,
                'enabled':enabled,'gateway_running':connected,'state':'connected' if connected else 'connecting' if enabled else 'disconnected',
                'description':'集中常驻接入，实例按消息唤醒。','docs_url':'','env_vars':[],
                'error_code':'execution_uncertain' if attention else binding['error_code'] if binding else None,
                'error_message':'有任务执行结果尚未确认，已暂停后续自动执行。请先核对原任务，再停用或重新连接。' if attention else '5G 连接失败，请核对登录绑定或重新连接。' if state=='failed' else None}]},headers={'Cache-Control':'no-store'})
        if operation == 'reconnect':
            return web.json_response({'status':'connecting' if binding else 'unbound'})
        if operation in {'enable','disable','disconnect'}:
            return web.json_response({'accepted':True,'saved':True,'changed':True})
        revision = binding['revision'] if binding else 0
        return web.json_response({'revision':revision,'phase':'completed' if connected else 'checking' if enabled else 'idle','saved':configured},headers={'Cache-Control':'no-store'})

    def internal(self, request):
        token = request.headers.get('Authorization','').removeprefix('Bearer ')
        if not self.entry.s.channels_key or not hmac.compare_digest(token,self.entry.s.channels_key):
            raise web.HTTPUnauthorized()

    async def wake(self, request):
        self.internal(request)
        data = await request.json()
        async with self.entry.database.acquire() as db:
            row = await db.fetchrow('''SELECT i.*,b.user_id,b.bot_key,b.enabled,b.revision,b.deleted_at FROM messaging_inbox i JOIN messaging_bindings b ON b.id=i.binding_id
                WHERE delivery_id=$1 AND lease_owner=$2 AND lease_until>now() AND state='dispatching' ''',data['delivery_id'],data['owner'])
        if not row or not row['enabled'] or row['deleted_at'] or row['binding_revision'] != row['revision']:
            raise web.HTTPConflict(text='消息租约已失效。')
        tenant = await self.entry.tenants.ensure_running(row['user_id'],touch=False)
        runtime = await self.entry.store.get_runtime(row['user_id'])
        epoch = runtime.state_epoch
        async with self.entry.database.acquire() as db:
            updated = await db.fetchval("UPDATE messaging_inbox SET instance_epoch=$3 WHERE delivery_id=$1 AND lease_owner=$2 AND state='dispatching' AND lease_until>now() RETURNING delivery_id",row['delivery_id'],data['owner'],epoch)
        if not updated: raise web.HTTPConflict(text='消息租约已失效。')
        settings = {'relay_url':self.entry.s.channels_relay_url,'gateway_id':f"{row['user_id']}.{epoch}.{row['revision']}",
                    'upgrade_secret':instance_secret(self.entry.s.channels_key,row['user_id'],epoch,row['revision']),
                    'bot_id':row['bot_key'],'revision':row['revision']}
        headers = {'X-MT-Token':tenant.token,'Host':tenant.host_header or f'127.0.0.1:{self.entry.s.hermes_port}'}
        if tenant.traffic_token: headers['cube-traffic-access-token'] = tenant.traffic_token
        origin = tenant.origin or f'{tenant.ip}:{self.entry.s.forward_port}'
        async with self.entry.http.post(f'http://{origin}/__mt/messaging/start',json=settings,headers=headers,
                timeout=aiohttp.ClientTimeout(total=90),allow_redirects=False) as response:
            if response.status != 200: raise web.HTTPBadGateway(text='实例 relay gateway 未能启动，请检查模板。')
        return web.json_response({'epoch':epoch})

    async def relay(self, request):
        # The connector validates the per-instance HMAC. Browser cookies grant no access here.
        authorization = request.headers.get('Authorization','')
        if not self.entry.s.channels_key or not authorization.startswith('Bearer '): raise web.HTTPUnauthorized()
        async with self.entry.http.ws_connect(self.entry.s.channels_url+'/relay',headers={'Authorization':authorization},heartbeat=30) as upstream:
            browser = web.WebSocketResponse(heartbeat=30)
            await browser.prepare(request)
            async def forward(source,target):
                async for item in source:
                    if item.type == aiohttp.WSMsgType.TEXT: await target.send_str(item.data)
                    elif item.type == aiohttp.WSMsgType.BINARY: await target.send_bytes(item.data)
                    else: break
            tasks = [asyncio.create_task(forward(browser,upstream)),asyncio.create_task(forward(upstream,browser))]
            try: await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
                await browser.close()
        return browser
