"""Private, fixed share endpoints; the browser never chooses an upstream URL or tenant."""
import asyncio
import json
import time

import aiohttp
from aiohttp import web


class ShareRoutes:
    def __init__(self, entry):
        self.entry = entry

    async def handle(self, request):
        identity = await self.entry._require_maas(request)
        if self.entry.shares is None:
            raise web.HTTPServiceUnavailable(text='分享服务尚未就绪。')
        try:
            data = await request.json()
            result = await self.entry.shares.dispatch(identity, request.match_info['kind'], request.match_info['operation'], data)
            return web.json_response(result, headers={'Cache-Control': 'no-store'})
        except web.HTTPException as error:
            return web.json_response({'error': error.text}, status=error.status, headers={'Cache-Control': 'no-store'})
        except (ValueError, TypeError, KeyError):
            return web.json_response({'error': '分享参数或实例响应无效。'}, status=400)

    async def authorize(self, identity):
        session = await self.entry.store.get_session(identity.session_sid)
        if session is None or session.user_id != identity.user_id or identity.expires_at <= time.time() * 1000:
            raise web.HTTPUnauthorized(text='登录已失效，请重新登录。')

    async def instance(self, identity, path, body):
        entry = self.entry
        if entry.tenants is None or entry.http is None:
            raise web.HTTPServiceUnavailable(text='用户实例尚未就绪。')
        await entry._touch(identity.user_id)
        tenant = await entry.tenants.ensure_running(identity.user_id)
        headers = {'Host': tenant.host_header or f'127.0.0.1:{entry.s.hermes_port}',
                   'X-Hermes-Session-Token': tenant.token}
        if tenant.traffic_token:
            headers['cube-traffic-access-token'] = tenant.traffic_token
        origin = tenant.origin or f'{tenant.ip}:{entry.s.forward_port}'
        kwargs = {'params': body} if path == '/api/fs/read-data-url' else {'json': body}
        method = 'GET' if path == '/api/fs/read-data-url' else 'POST'
        try:
            async with entry.http.request(method, f'http://{origin}{path}', headers=headers,
                    **kwargs, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=60)) as response:
                if response.status != 200:
                    if response.status == 404:
                        raise web.HTTPConflict(text='实例缺少分享能力，请更新实例模板后重试。')
                    raise web.HTTPConflict(text='实例无法确认分享内容，请检查会话或产物后重试。')
                chunks = []
                size = 0
                async for chunk in response.content.iter_chunked(65536):
                    size += len(chunk)
                    if size > 12 * 1024 * 1024:
                        raise web.HTTPConflict(text='分享内容超过大小限制。')
                    chunks.append(chunk)
                payload = b''.join(chunks)
                result = json.loads(payload)
                if not isinstance(result, dict):
                    raise web.HTTPBadGateway(text='实例未返回有效的分享内容。')
                return result
        except (aiohttp.ClientError, asyncio.TimeoutError):
            raise web.HTTPBadGateway(text='读取实例分享内容失败，请重试。') from None
