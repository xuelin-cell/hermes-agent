"""Fixed account notification/speech operations; login and plan credentials stay in Entry."""
import asyncio
import base64
import binascii
from pathlib import Path

import aiohttp
from aiohttp import web

from .drive_worker import DriveWorker

ACTIONS = {'notify-start', 'notify-poll', 'notify-stop', 'notify-refresh', 'asr-start', 'asr-audio', 'asr-poll', 'asr-stop', 'asr-cancel'}


class AccountRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.worker = DriveWorker(Path(__file__).parent / 'static/cloud-account-worker.mjs')

    async def handle(self, request):
        identity = await self.entry._require_maas(request)
        action = request.match_info['operation']
        if action not in ACTIONS:
            raise web.HTTPNotFound()
        data = await request.json()
        if not isinstance(data, dict) or set(data) - {'session', 'language', 'pcm', 'cursor'}:
            raise web.HTTPBadRequest(text='账号服务参数无效。')
        if action == 'notify-refresh':
            await self.entry.share_routes.authorize(identity)
            plan = await self.entry.maas.my_plan(identity.token)
            await self.entry.share_routes.authorize(identity)
            if plan is None:
                # The existing MaaS client also returns None on upstream failure; retain known-good config.
                return web.json_response({'status':'failed'}, headers={'Cache-Control':'no-store'})
            async with self.entry.database.acquire() as db, db.transaction():
                await self.entry.messaging_routes.store._save_plan(db, identity.user_id, plan)
            tenant = await self.entry.tenants.ensure_running(identity.user_id)
            spec = self.entry.tenants._config_patch_spec(plan.endpoint(), plan.catalog(), plan.limits(), api_key=plan.api_key)
            origin = tenant.origin or f'{tenant.ip}:{self.entry.s.forward_port}'
            headers = {'X-MT-Token':tenant.token,'Host':tenant.host_header or f'127.0.0.1:{self.entry.s.hermes_port}'}
            if tenant.traffic_token: headers['cube-traffic-access-token']=tenant.traffic_token
            async with self.entry.http.post(f'http://{origin}/__mt/refresh-plan', json={'spec':spec}, headers=headers,
                    allow_redirects=False, timeout=aiohttp.ClientTimeout(total=15)) as response:
                if response.status != 200: raise web.HTTPBadGateway(text='实例尚未同步套餐配置，请更新模板后重试。')
            return web.json_response({'status': 'ok'}, headers={'Cache-Control': 'no-store'})
        values = {}
        if action == 'notify-poll':
            cursor = data.get('cursor', 0)
            if not isinstance(cursor, int) or isinstance(cursor, bool) or not 0 <= cursor <= 2**53:
                raise web.HTTPBadRequest(text='通知游标无效。')
            values['cursor'] = cursor
        if action == 'asr-start':
            if data.get('language') not in {'zh', 'en'}:
                raise web.HTTPBadRequest(text='识别语言无效。')
            context = await self.entry.store.get_tenant_context(identity.user_id)
            if not context.api_key:
                raise web.HTTPForbidden(text='请先开通有效套餐。')
            values.update(apiKey=context.api_key, language=data['language'])
        elif action.startswith('asr-'):
            session = data.get('session')
            if not isinstance(session, str) or len(session) > 64:
                raise web.HTTPBadRequest(text='语音会话无效。')
            values['session'] = session
            if action == 'asr-audio':
                pcm = data.get('pcm')
                try:
                    if not isinstance(pcm, str) or len(pcm) > 44_000: raise ValueError()
                    raw = base64.b64decode(pcm, validate=True)
                    if not 0 < len(raw) <= 32768 or len(raw) % 2: raise ValueError()
                except (ValueError, binascii.Error):
                    raise web.HTTPBadRequest(text='音频帧无效。') from None
                values['pcm'] = pcm
        await self.entry.share_routes.authorize(identity)
        result = await asyncio.wait_for(self.worker.call(action, identity=identity, **values), 20)
        await self.entry.share_routes.authorize(identity)
        if isinstance(result, dict) and result.get('error'):
            raise web.HTTPBadGateway(text=result['error'])
        return web.json_response(result, headers={'Cache-Control': 'no-store'})

    async def close(self):
        await self.worker.close()
