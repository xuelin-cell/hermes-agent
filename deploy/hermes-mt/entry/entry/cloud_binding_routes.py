"""Central provisioning using the UniClaw cloud-binding contract."""
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from aiohttp import web

from .maas import Plan
from .messaging_credentials import cloud_binding


def parse_plan(raw):
    if not isinstance(raw,dict) or not isinstance(raw.get('apiKey'),str) or not raw['apiKey'].strip().startswith('sk-'):
        raise ValueError('my_plan.apiKey 缺失或无效。')
    models_raw=raw.get('models')
    if not isinstance(models_raw,str): raise ValueError('my_plan.models 必须为 JSON 字符串。')
    parsed=json.loads(models_raw)
    models=parsed.get('models') if isinstance(parsed,dict) else None
    if not isinstance(models,list) or not 0<len(models)<=100: raise ValueError('my_plan.models 必须包含有效模型。')
    ids=set()
    for model in models:
        if not isinstance(model,dict) or not isinstance(model.get('id'),str) or not model['id'].strip() or model['id'] in ids:
            raise ValueError('模型 ID 缺失或重复。')
        ids.add(model['id'])
        url=urlsplit(str(model.get('base_url') or ''))
        if url.scheme not in {'http','https'} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('模型服务地址无效。')
        if not isinstance(model.get('model',model['id']),str): raise ValueError('模型名称无效。')
    for field in ('main_model_id','fast_model_id'):
        if parsed.get(field) and parsed[field] not in ids: raise ValueError('默认模型不存在。')
    return Plan(raw['apiKey'].strip(),models,str(parsed.get('main_model_id') or ''))


class CloudBindingRoutes:
    def __init__(self,entry):
        self.entry=entry
        self.store=entry.messaging_routes.store

    async def handle(self,request):
        # As in UniClaw, deployment networking controls access to this service API.
        user=request.match_info['user_id']
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',user):
            return self.error(422,'invalid_user_id','用户 ID 无效。')
        try:
            return await {'PUT':self.put,'GET':self.get,'DELETE':self.delete}[request.method](request,user)
        except web.HTTPException as error:
            code={404:'user_config_not_found',409:'binding_conflict',503:'channels_unavailable'}.get(error.status,'invalid_request')
            return self.error(error.status,code,error.text)
        except (ValueError,TypeError,KeyError):
            # JSON decoder / URL parser errors may embed credential-bearing input.
            return self.error(422,'invalid_request','绑定凭据或 my_plan 格式无效。')

    @staticmethod
    def error(status,code,message):
        return web.json_response({'error':{'code':code,'message':message}},status=status,headers={'Cache-Control':'no-store'})

    async def put(self,request,user):
        settings=self.entry.s
        if not settings.channels_key or not settings.pg_lock or settings.backend!='cube':
            raise web.HTTPServiceUnavailable(text='集中消息接入尚未部署。')
        raw=await request.json()
        if not isinstance(raw,dict): raise ValueError('Invalid body')
        credentials=raw.get('uniagentgate')
        if not isinstance(credentials,dict): raise ValueError('Missing credentials')
        origins={value.strip().rstrip('/') for value in settings.channels_gateway_origins.split(',') if value.strip()}
        status,binding=cloud_binding({'ipUrl':credentials.get('gateway_url'),'agentIdCloud':credentials.get('agent_id'),
            'agentKeyCloud':credentials.get('agent_sk')},origins)
        if status!='available' or len(binding['agent_id'])>128 or len(binding['gateway'])>2048:
            raise ValueError('Invalid credentials')
        plan=parse_plan(raw.get('my_plan'))
        # Credentials, enablement and models commit together. Idempotent retries
        # preserve the connection revision and any in-flight execution receipt.
        await self.store.configure(user,**binding,enable=True,plan=plan)
        return web.json_response({'ok':True},headers={'Cache-Control':'no-store'})

    async def get(self,request,user):
        async with self.entry.database.acquire() as db:
            exists=await db.fetchval("SELECT 1 FROM users WHERE user_id=$1 AND status='active'",user)
        if not exists: raise web.HTTPNotFound(text='用户配置不存在或用户已停用。')
        row=await self.store.binding(user)
        fresh=row and (datetime.now(timezone.utc)-row['updated_at']).total_seconds()<15
        state=row['connection_state'] if row and row['enabled'] else 'stopped'
        if row and row['enabled'] and not fresh: state='stopped'
        return web.json_response({'bound':bool(row),'state':state,'last_error':row['error_code'] if row else '',
            'updated_at':row['updated_at'].isoformat() if row else None},headers={'Cache-Control':'no-store'})

    async def delete(self,request,user):
        await self.store.set_enabled(user,False,remove=True,missing_ok=True)
        return web.json_response({'ok':True},headers={'Cache-Control':'no-store'})
