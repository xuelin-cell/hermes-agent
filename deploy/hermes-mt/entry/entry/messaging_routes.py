"""Cookie-authenticated management and private lease-bound instance wakeup."""
import asyncio
import hmac
from datetime import datetime, timezone

import aiohttp
from aiohttp import web

from .channels_auth import instance_secret
from .messaging_credentials import cloud_binding
from .messaging_store import MessagingStore
from .weixin_qr_routes import WeixinQr
from plugins.cloud_messaging.media import MAX_WIRE_BYTES

PLATFORMS = {'uniagentgate':'5G 消息','dingtalk':'钉钉','weixin':'微信','wecom':'企业微信','feishu':'飞书'}
CREDENTIALS = {'dingtalk':('DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET'), 'wecom':('WECOM_BOT_ID','WECOM_SECRET'), 'feishu':('FEISHU_APP_ID','FEISHU_APP_SECRET')}


class MessagingRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.store = MessagingStore(entry.database, entry.store.cipher)
        self.weixin_qr = WeixinQr(self)

    async def apply_login(self, user, plan):
        origins = {value.strip().rstrip('/') for value in self.entry.s.channels_gateway_origins.split(',') if value.strip()}
        status, binding = cloud_binding(plan,origins)
        if status == 'available':
            await self.store.configure(user,**binding,enable=True)
        elif status == 'clear' and await self.store.binding(user):
            await self.store.set_enabled(user,False,remove=True)
        elif status == 'invalid':
            await self.entry.store.write_audit(user,'messaging.credentials.invalid')

    async def handle(self, request):
        session=await self.entry._require(request)
        operation=request.match_info['operation']
        data=await request.json()
        if not isinstance(data,dict) or data.get('profile','default') not in (None,'default'):
            raise web.HTTPBadRequest(text='云端消息平台只支持默认实例。')
        platform=data.get('platform','uniagentgate')
        if platform not in PLATFORMS: raise web.HTTPBadRequest(text='该平台尚未接通。')
        if operation in {'save','retry','reconnect','enable','disable','disconnect','weixin-start','weixin-status','weixin-unbind','group-policy'}:
            if not self.entry.s.channels_key or not self.entry.s.channels_relay_url or not self.entry.s.pg_lock or self.entry.s.backend!='cube':
                raise web.HTTPServiceUnavailable(text='集中消息接入尚未部署。')
            if operation=='group-policy':
                return web.json_response(await self.store.groups(session.user_id,data.get('enabled'),data.get('group_ids')),headers={'Cache-Control':'no-store'})
            if operation in {'weixin-start','weixin-status','weixin-unbind'}:
                return web.json_response(await self.weixin_qr.handle(session.user_id,operation,data),headers={'Cache-Control':'no-store'})
            if operation=='disconnect' and platform=='weixin':
                return web.json_response(await self.weixin_qr.handle(session.user_id,'weixin-unbind',data))
            if operation=='save':
                if platform not in CREDENTIALS: raise web.HTTPBadRequest(text='5G 凭据由短信登录提供。')
                id_key,secret_key=CREDENTIALS[platform]
                env=data.get('env',{})
                if not isinstance(env,dict) or set(env)-set(CREDENTIALS[platform]):
                    raise web.HTTPBadRequest(text='不支持的配置字段。')
                old=await self.store.binding(session.user_id,platform)
                app_id=env.get(id_key) or (old['bot_key'] if old else '')
                if old and app_id!=old['bot_key'] and not env.get(secret_key): raise web.HTTPBadRequest(text='更换机器人 ID 时请同时填写新 Secret。')
                secret=env.get(secret_key) or (self.store.cipher.decrypt(old['secret_enc']) if old else '')
                if not all(isinstance(value,str) and 0<len(value)<=4096 and value.isascii() and not any(c.isspace() for c in value) for value in (app_id,secret)):
                    raise web.HTTPBadRequest(text='请填写有效的 Client ID 和 Secret。')
                await self.store.configure(session.user_id,'',app_id,secret,platform=platform)
            if platform=='weixin':
                async with self.weixin_qr.locks.setdefault(session.user_id,asyncio.Lock()):
                    self.weixin_qr.sessions.pop(session.user_id,None)
                    await self.store.set_enabled(session.user_id,operation!='disable',platform=platform)
            else:
                await self.store.set_enabled(session.user_id,operation not in {'disable','disconnect'},remove=operation=='disconnect',platform=platform)
        elif operation not in {'platforms','status','watch'}:
            raise web.HTTPBadRequest(text='不支持的操作。')
        if operation=='platforms':
            rows=[await self.view(session.user_id,name) for name in PLATFORMS]
            return web.json_response({'platforms':rows},headers={'Cache-Control':'no-store'})
        binding=await self.store.binding(session.user_id,platform)
        view=await self.view(session.user_id,platform)
        if operation=='reconnect': return web.json_response({'status':'connecting' if binding else 'unbound'})
        if operation in {'save','retry','enable','disable','disconnect'}:
            return web.json_response({'accepted':True,'saved':True,'changed':True})
        return web.json_response({'revision':binding['revision'] if binding else 0,
            **({'platform':platform} if platform!='uniagentgate' else {}),'profile':'default',
            'phase':'completed' if view['state']=='connected' else 'failed' if view['state']=='fatal' else 'checking' if view['enabled'] else 'idle',
            'saved':bool(binding)},headers={'Cache-Control':'no-store'})

    async def view(self,user,platform):
        binding=await self.store.binding(user,platform)
        enabled=bool(binding and binding['enabled'])
        state=binding['connection_state'] if binding else 'stopped'
        fresh=bool(binding and (datetime.now(timezone.utc)-binding['updated_at']).total_seconds()<15)
        connected=bool(enabled and fresh and state=='running' and self.entry.s.channels_key)
        fields=[] if platform not in CREDENTIALS else [{'key':key,'is_set':bool(binding),'is_password':key.endswith('SECRET'),'redacted_value':'configured' if binding else None,'advanced':False,'description':'','prompt':key,'required':True,'url':None} for key in CREDENTIALS[platform]]
        async with self.entry.database.acquire() as db:
            attention=bool(binding and await db.fetchval("SELECT 1 FROM messaging_inbox WHERE binding_id=$1 AND binding_revision=$2 AND state='uncertain' LIMIT 1",binding['id'],binding['revision']))
            outbound=await db.fetchval("SELECT o.state FROM messaging_outbox o JOIN messaging_inbox i USING(delivery_id) WHERE i.binding_id=$1 AND o.binding_revision=$2 AND o.state IN('unknown','failed') ORDER BY o.updated_at DESC LIMIT 1",binding['id'],binding['revision']) if binding else None
        return {'id':platform,'name':PLATFORMS[platform],'configured':bool(binding),
            'enabled':enabled,'gateway_running':connected or (enabled and fresh and state=='failed'),
            'state':'connected' if connected else 'fatal' if enabled and state=='failed' else 'connecting' if enabled else 'disconnected',
            'description':'集中常驻接入，实例按消息唤醒。','docs_url':'','env_vars':fields,
            'error_code':'execution_uncertain' if attention else 'outbound_unconfirmed' if outbound=='unknown' else 'outbound_failed' if outbound else '',
            'error_message':'有执行结果未确认，已暂停后续任务；请先核对原任务。' if attention else '有消息或附件投递失败或结果未确认，请先核对原会话再决定是否重发。' if outbound else '连接失败，请核对应用凭据与机器人配置。' if state=='failed' else None}

    async def media(self,request):
        from .messaging_media_routes import handle
        return await handle(self.entry,request)

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
        settings = {'relay_url':self.entry.s.channels_relay_url,'gateway_id':f"{row['user_id']}.{epoch}.{row['revision']}.{row['binding_id']}",
                    'upgrade_secret':instance_secret(self.entry.s.channels_key,row['user_id'],epoch,row['revision'],row['binding_id']),
                    'bot_id':row['bot_key'],'revision':row['revision'],'platform':row['platform'],'binding_id':row['binding_id']}
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
        async with self.entry.http.ws_connect(self.entry.s.channels_url+'/relay',headers={'Authorization':authorization},heartbeat=30,max_msg_size=MAX_WIRE_BYTES) as upstream:
            browser = web.WebSocketResponse(heartbeat=30,max_msg_size=MAX_WIRE_BYTES)
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
