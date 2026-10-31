"""Cookie-authenticated management and private lease-bound instance wakeup."""
import asyncio
import hmac
from datetime import datetime, timezone

import aiohttp
from aiohttp import web

from .messaging_relay import InstanceRelays
from .messaging_credentials import cloud_binding
from .messaging_store import MessagingStore
from .weixin_qr_routes import WeixinQr

PLATFORMS = {'uniagentgate':'5G 消息','dingtalk':'钉钉','weixin':'微信','wecom':'企业微信','feishu':'飞书'}
CREDENTIALS = {'dingtalk':('DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET'), 'wecom':('WECOM_BOT_ID','WECOM_SECRET'), 'feishu':('FEISHU_APP_ID','FEISHU_APP_SECRET')}


class MessagingRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.store = MessagingStore(entry.database, entry.store.cipher)
        self.weixin_qr = WeixinQr(self)
        self.relays = InstanceRelays(entry)

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
        if operation == 'targets':
            async with self.entry.database.acquire() as db:
                rows = await db.fetch('''SELECT DISTINCT i.platform,i.external_chat_id FROM messaging_inbox i
                    JOIN messaging_bindings b ON b.id=i.binding_id WHERE b.user_id=$1 AND b.enabled
                    AND b.deleted_at IS NULL AND b.revision=i.binding_revision LIMIT 100''', session.user_id)
            return web.json_response({'targets':[{'id':row['platform']+':'+row['external_chat_id'],
                'name':PLATFORMS[row['platform']]+' · '+row['external_chat_id'], 'home_target_set':True,'home_env_var':None}
                for row in rows]}, headers={'Cache-Control':'no-store'})
        data=await request.json()
        if not isinstance(data,dict) or data.get('profile','default') not in (None,'default'):
            raise web.HTTPBadRequest(text='云端消息平台只支持默认实例。')
        platform=data.get('platform','uniagentgate')
        if platform not in PLATFORMS: raise web.HTTPBadRequest(text='该平台尚未接通。')
        if operation in {'save','retry','reconnect','enable','disable','disconnect','weixin-start','weixin-status','weixin-unbind','group-policy'}:
            if not self.entry.s.channels_key or not self.entry.s.pg_lock or self.entry.s.backend!='cube':
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
            outbound=await db.fetchrow("SELECT o.state,o.error_code FROM messaging_outbox o JOIN messaging_inbox i USING(delivery_id) WHERE i.binding_id=$1 AND o.binding_revision=$2 AND o.state IN('unknown','failed') ORDER BY o.updated_at DESC LIMIT 1",binding['id'],binding['revision']) if binding else None
        outbound_state=outbound['state'] if outbound else ''
        outbound_code=outbound['error_code'] if outbound else ''
        outbound_messages={
            'media_entry_unconfigured':'附件发送失败：旧媒体下载入口未配置。更新消息服务后可使用 OSS 公网链接发送。',
            'media_oss_upload_failed':'附件上传 OSS 失败，请检查当前用户套餐、元景 MCP 和 OSS 网络连接。',
            'media_preparation_failed':'附件处理失败：请检查文件格式、大小及音频转换服务。',
            'gateway_rejected':'消息网关拒绝投递，请核对文件格式、大小及网关返回结果。',
        }
        outbound_message=outbound_messages.get(outbound_code,'有消息或附件投递失败，请先核对原会话再决定是否重发。')
        if outbound_state=='unknown': outbound_message='发送结果未确认，请先核对手机和原会话，避免重复发送。'
        return {'id':platform,'name':PLATFORMS[platform],'configured':bool(binding),
            'enabled':enabled,'gateway_running':connected or (enabled and fresh and state=='failed'),
            'state':'connected' if connected else 'fatal' if enabled and state=='failed' else 'connecting' if enabled else 'disconnected',
            'description':'集中常驻接入，实例按消息唤醒。','docs_url':'','env_vars':fields,
            'error_code':'execution_uncertain' if attention else 'outbound_unconfirmed' if outbound_state=='unknown' else (outbound_code or 'outbound_failed') if outbound else '',
            'error_message':'有执行结果未确认，已暂停后续任务；请先核对原任务。' if attention else outbound_message if outbound else '连接失败，请核对应用凭据与机器人配置。' if state=='failed' else None}

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
                WHERE delivery_id=$1 AND lease_owner=$2 AND lease_until>now() AND state IN('dispatching','accepted','running','uncertain') ''',data['delivery_id'],data['owner'])
        if not row or not row['enabled'] or row['deleted_at'] or row['binding_revision'] != row['revision']:
            raise web.HTTPConflict(text='消息租约已失效。')
        tenant = await self.entry.tenants.ensure_running(row['user_id'],touch=False)
        runtime = await self.entry.store.get_runtime(row['user_id'])
        epoch = runtime.state_epoch
        async with self.entry.database.acquire() as db:
            updated = await db.fetchval("UPDATE messaging_inbox SET instance_epoch=CASE WHEN state='dispatching' THEN $3 ELSE instance_epoch END WHERE delivery_id=$1 AND lease_owner=$2 AND state IN('dispatching','accepted','running','uncertain') AND lease_until>now() RETURNING delivery_id",row['delivery_id'],data['owner'],epoch)
        if not updated: raise web.HTTPConflict(text='消息租约已失效。')
        try:
            worker = await self.relays.ensure(row,tenant,epoch)
        except (RuntimeError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as error:
            raise web.HTTPBadGateway(text='消息执行通道未就绪，请检查入口、channels 和实例模板是否配套。') from error
        return web.json_response({'epoch':epoch,'worker_id':worker})
