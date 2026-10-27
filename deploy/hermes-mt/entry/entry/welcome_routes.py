"""Only fixed V3 locale records, using the shared desktop validation and current browser login."""
import asyncio

from aiohttp import web


class WelcomeRoutes:
    def __init__(self, entry):
        self.entry = entry

    async def handle(self, request):
        identity = await self.entry._require_maas(request)
        locale = request.match_info['locale']
        if locale not in {'zh-CN', 'en'}:
            raise web.HTTPBadRequest(text='办公模板语言无效。')
        await self.entry.share_routes.authorize(identity)
        try:
            result = await asyncio.wait_for(
                self.entry.drive_routes.worker.call('welcome', identity=identity, locale=locale), 12)
        except (asyncio.TimeoutError, OSError, web.HTTPBadGateway, web.HTTPServiceUnavailable):
            raise web.HTTPServiceUnavailable(text='办公模板更新失败，请稍后重试。') from None
        await self.entry.share_routes.authorize(identity)
        if not isinstance(result, dict) or not isinstance(result.get('modules'), list):
            raise web.HTTPServiceUnavailable(text='办公模板更新失败，请稍后重试。')
        return web.json_response(result, headers={'Cache-Control': 'no-store'})
