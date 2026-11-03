"""Browser-bound plan reads and one-time subscription tickets; never expose raw my-plan data."""
from __future__ import annotations

import asyncio

from aiohttp import web


class PlanRoutes:
    def __init__(self, entry):
        self.entry = entry

    async def handle(self, request):
        identity = await self.entry._require_maas(request)
        operation = request.match_info['operation']
        if operation not in {'usage', 'refresh', 'subscribe'}:
            raise web.HTTPNotFound()
        try:
            await self.entry.share_routes.authorize(identity)
            result = await asyncio.wait_for(
                self.entry.drive_routes.worker.call(
                    'plan-subscription' if operation == 'subscribe' else 'plan-usage',
                    identity=identity, force=operation == 'refresh'),
                timeout=20,
            )
            await self.entry.share_routes.authorize(identity)
            if result.get('reason') == 'auth':
                raise web.HTTPUnauthorized(text='登录已失效，请重新登录。')
            if result.get('status') == 'available':
                session = await self.entry.store.get_session(identity.session_sid)
                if session is None:
                    raise web.HTTPUnauthorized(text='登录已失效，请重新登录。')
                result['account'] = {
                    'maskedPhone': await self.entry.store.masked_phone(identity.user_id) or identity.user_id,
                    'expiresAt': session.expires_at * 1000,
                }
            return web.json_response(result, headers={'Cache-Control': 'no-store'})
        except (asyncio.TimeoutError, OSError, web.HTTPBadGateway, web.HTTPServiceUnavailable):
            return web.json_response(
                {'status': 'failed', **({'reason': 'upstream'} if operation == 'subscribe' else {})},
                headers={'Cache-Control': 'no-store'},
            )
