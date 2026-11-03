"""The same fixed MaaS gateway contract used by the desktop client."""
import asyncio

import aiohttp
from aiohttp import web

GATEWAY = 'https://maas.ai-yuanjing.com/app/gateway/uniclaw-shares'


class ShareGateway:
    def __init__(self, http, base=GATEWAY):
        self.http, self.base = http, base

    async def upload(self, token, share_id, payload):
        try:
            async with self.http.put(f'{self.base}/{share_id}.html', data=payload,
                    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'text/html'},
                    timeout=aiohttp.ClientTimeout(total=30), allow_redirects=False) as response:
                if response.status != 200:
                    raise web.HTTPBadGateway(text='分享上传未确认成功，请重试。')
                result = await response.json()
                if not isinstance(result, dict) or result.get('shareId') != share_id or not isinstance(result.get('url'), str) or not result['url'].startswith('https://'):
                    raise web.HTTPBadGateway(text='分享服务未返回有效链接，请重试。')
                return result['url']
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            raise web.HTTPBadGateway(text='分享上传结果待确认，请重试同一分享。') from None

    async def delete(self, token, share_id):
        try:
            async with self.http.delete(f'{self.base}/{share_id}.html', headers={'Authorization': f'Bearer {token}'},
                    timeout=aiohttp.ClientTimeout(total=30), allow_redirects=False) as response:
                if response.status != 204:
                    raise web.HTTPBadGateway(text='取消分享未确认成功，请重试。')
        except (aiohttp.ClientError, asyncio.TimeoutError):
            raise web.HTTPBadGateway(text='取消分享未确认成功，请重试。') from None
