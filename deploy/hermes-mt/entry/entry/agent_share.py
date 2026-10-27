"""Relay an explicitly authorized turn to the existing share service."""
import asyncio
import secrets
import time

import aiohttp
from aiohttp import web

INSTANCE = '/api/plugins/conversation-share/internal/'


class AgentSharing:
    def __init__(self, routes):
        self.routes = routes
        self.grants = {}

    async def instance(self, identity, operation, body):
        return await self.routes.instance(identity, INSTANCE + operation, body)

    async def grant(self, identity, data):
        await self.routes.authorize(identity)
        if len(self.grants) >= 128 or sum(owner.session_sid == identity.session_sid for owner, _ in self.grants.values()) >= 8:
            raise web.HTTPTooManyRequests(text='分享任务过多，请稍后重试。')
        session = data.get('sessionId')
        if not isinstance(session, str) or not session or len(session) > 160:
            raise web.HTTPBadRequest(text='缺少当前会话。')
        key = secrets.token_hex(24)
        expires = min(time.time() + 900, identity.expires_at / 1000)
        await self.instance(identity, 'grant', {'grant': key, 'sessionId': session, 'expires': expires})
        task = asyncio.create_task(self.relay(identity, key, expires))
        self.grants[key] = (identity, task)
        return {'cloud_share': key}

    async def relay(self, identity, key, expires):
        async def check(request_id):
            await self.routes.authorize(identity)
            await self.instance(identity, 'check', {'grant': key, 'requestId': request_id})

        try:
            while time.time() < expires:
                await self.routes.authorize(identity)
                request = await self.instance(identity, 'poll', {'grant': key})
                if request.get('waiting'):
                    await asyncio.sleep(.4)
                    continue
                await check(request['requestId'])
                payload = request['payload']
                if payload.get('source', {}).get('sessionId') != request['sessionId']:
                    raise web.HTTPForbidden(text='分享会话不匹配。')
                action = asyncio.create_task(self.routes.entry.shares.dispatch(identity, 'artifact', 'publish', payload))
                try:
                    while not action.done():
                        await asyncio.sleep(.3)
                        await check(request['requestId'])
                    result = await action
                except asyncio.CancelledError:
                    action.cancel()
                    await asyncio.gather(action, return_exceptions=True)
                    raise
                except (web.HTTPException, aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError, TypeError):
                    action.cancel()
                    await asyncio.gather(action, return_exceptions=True)
                    result = {'error': '分享未能确认成功，请先在产物分享面板确认结果，再重试；不要改用其他上传通道。'}
                await self.instance(identity, 'result', {'grant': key, 'requestId': request['requestId'], 'result': result})
        except (web.HTTPException, aiohttp.ClientError, asyncio.TimeoutError):
            return
        finally:
            self.grants.pop(key, None)
            try:
                await self.instance(identity, 'revoke', {'grant': key})
            except (web.HTTPException, aiohttp.ClientError, asyncio.TimeoutError):
                pass  # The instance may have stopped; its expiring capability cannot be reused.

    async def logout(self, sid):
        tasks = [task for identity, task in self.grants.values() if identity.session_sid == sid]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self):
        tasks = [task for _, task in self.grants.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
