"""Only fixed V3 locale records. The personal entry reads them with the current browser login and the shared
desktop validation; the enterprise entry, whose accounts hold no MaaS token, reads the same record without one."""
import asyncio
import json
import time

import aiohttp
from aiohttp import web

LOCALES = {'zh-CN', 'en'}
# 和桌面版 electron/uniwork-welcome/client.ts 取的是同一个地址（个人版经账号 worker 也是它），不跟 MT_MAAS_APP 走：
# 有的部署为关掉入口自己的 MaaS 登录改了 MT_MAAS_APP，首页模板不该跟着没了
SYSTEM_CONFIG_URL = 'https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config'
# 企业版取到的首页模板缓存多久（秒）；取不到时沿用上一份
CACHE_S = 300
MAX_CONFIG = 2_000_000


class WelcomeRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.url = SYSTEM_CONFIG_URL
        self.cache: dict[str, tuple[float, dict]] = {}

    async def handle(self, request):
        if self.entry.s.enterprise:
            await self.entry._require(request)
            locale = request.match_info['locale']
            if locale not in LOCALES:
                raise web.HTTPBadRequest(text='办公模板语言无效。')
            return web.json_response(await self.system_config(locale), headers={'Cache-Control': 'no-store'})
        identity = await self.entry._require_maas(request)
        locale = request.match_info['locale']
        if locale not in LOCALES:
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

    async def system_config(self, locale: str) -> dict:
        """企业版的首页模板：和个人版是同一份系统配置，内容人人一样，网关不要求令牌。
        返回 ``{modules, version}``，和桌面的 electron/uniwork-welcome/client.ts 一样；缓存 CACHE_S 秒，取不到时用上一份。"""
        cached = self.cache.get(locale)
        if cached and time.monotonic() - cached[0] < CACHE_S:
            return cached[1]
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
                async with http.get(self.url, params={'key': f'welcome_config_v3_{locale}'},
                                    headers={'Accept': 'application/json'}, allow_redirects=False) as response:
                    if response.status != 200:
                        raise ValueError(f'HTTP {response.status}')
                    envelope = await response.json(content_type=None)
            config = envelope.get('configValue') if isinstance(envelope, dict) else None
            if not isinstance(config, str) or len(config) > MAX_CONFIG:
                raise ValueError('configValue')
            modules = (json.loads(config) or {}).get('modules')
            if not isinstance(modules, list) or not modules:
                raise ValueError('modules')
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, AttributeError):
            if cached:
                return cached[1]
            raise web.HTTPServiceUnavailable(text='办公模板更新失败，请稍后重试。') from None
        version = envelope.get('version')
        result = {'modules': modules, **({'version': version.strip()} if isinstance(version, str) and version.strip() else {})}
        self.cache[locale] = (time.monotonic(), result)
        return result
