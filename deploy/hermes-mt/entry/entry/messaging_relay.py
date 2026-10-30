"""Entry-owned, lease-bound pair of private WebSockets; no instance callback URL."""
import asyncio
import json
from contextlib import AsyncExitStack

import aiohttp
from aiohttp import web
from .channels_auth import instance_secret, upgrade_token
from plugins.cloud_messaging.media import MAX_WIRE_BYTES

CAPABILITY = "entry-forward-relay-v1"


class InstanceRelays:
    def __init__(self, entry):
        self.entry = entry
        self.sessions = {}
        self.locks = {}
        self.closing = False

    async def close(self):
        self.closing = True
        tasks = [value[1] for value in self.sessions.values()]
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.sessions.clear()

    async def ensure(self, row, tenant, epoch):
        user = row['user_id']
        context = (user, row['binding_id'], row['revision'], epoch)
        async with self.locks.setdefault(user, asyncio.Lock()):
            if self.closing: raise web.HTTPServiceUnavailable()
            old = self.sessions.get(user)
            if old and old[0] == context and not old[1].done():
                return await asyncio.shield(old[2])
            if old:
                old[1].cancel()
                await asyncio.gather(old[1], return_exceptions=True)
            ready = asyncio.get_running_loop().create_future()
            task = asyncio.create_task(self.bridge(row, tenant, epoch, context, ready), name='messaging-forward-relay')
            self.sessions[user] = (context, task, ready)
            try:
                return await asyncio.shield(ready)
            except BaseException:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise

    async def valid(self, context):
        user, binding, revision, epoch = context
        async with self.entry.database.acquire() as db:
            return bool(await db.fetchval('''SELECT 1 FROM messaging_bindings b
                JOIN users u ON u.user_id=b.user_id JOIN tenant_runtime r ON r.user_id=b.user_id
                WHERE b.id=$1 AND b.user_id=$2 AND b.revision=$3 AND b.enabled AND b.deleted_at IS NULL
                AND u.status='active' AND r.state_epoch=$4 AND EXISTS(
                    SELECT 1 FROM messaging_inbox i WHERE i.binding_id=b.id AND i.binding_revision=b.revision
                    AND i.lease_until>now() AND i.state IN('dispatching','accepted','running','uncertain'))''',
                binding, user, revision, epoch))

    async def guard(self, context):
        while await self.valid(context):
            await asyncio.sleep(1)

    async def bridge(self, row, tenant, epoch, context, ready):
        tasks = []
        try:
            settings = {'transport': CAPABILITY, 'user_id': row['user_id'], 'instance_epoch': epoch,
                        'platform': row['platform'], 'binding_id': row['binding_id'], 'revision': row['revision'],
                        'bot_id': row['bot_key'], 'upgrade_secret': instance_secret(
                            self.entry.s.channels_key, row['user_id'], epoch, row['revision'], row['binding_id'])}
            origin = tenant.origin or f'{tenant.ip}:{self.entry.s.forward_port}'
            headers = {'X-MT-Token': tenant.token, 'Host': tenant.host_header or f'127.0.0.1:{self.entry.s.hermes_port}'}
            if tenant.traffic_token: headers['cube-traffic-access-token'] = tenant.traffic_token
            async with self.entry.http.post(f'http://{origin}/__mt/messaging/start', json=settings, headers=headers,
                    allow_redirects=False, timeout=aiohttp.ClientTimeout(total=195)) as response:
                if response.status != 200 or (await response.json()).get('capability') != CAPABILITY:
                    raise RuntimeError('实例模板不支持入口主动消息通道，请配套更新模板。')
            headers['Authorization'] = 'Bearer '+settings['upgrade_secret']
            async with AsyncExitStack() as stack:
                async with asyncio.timeout(30):
                    instance = await stack.enter_async_context(self.entry.http.ws_connect(
                        f'http://{origin}/__mt/messaging/relay', headers=headers, heartbeat=30, max_msg_size=MAX_WIRE_BYTES,
                        timeout=aiohttp.ClientWSTimeout(ws_close=2)))
                    hello = await instance.receive_json()
                    if (hello.get('type'), hello.get('capability'), hello.get('platform'), hello.get('botId')) != (
                            'hello', CAPABILITY, row['platform'], row['bot_key']):
                        raise RuntimeError('Instance relay identity mismatch')
                    channels = await stack.enter_async_context(self.entry.http.ws_connect(
                        self.entry.s.channels_url+'/relay', headers={'Authorization': 'Bearer '+upgrade_token(
                            self.entry.s.channels_key, *context)}, heartbeat=30, max_msg_size=MAX_WIRE_BYTES,
                        timeout=aiohttp.ClientWSTimeout(ws_close=2)))
                    await channels.send_str(json.dumps(hello)+'\n')
                    descriptor = await channels.receive_json()
                    if descriptor.get('type') != 'descriptor': raise RuntimeError('Relay handshake failed')
                    await instance.send_str(json.dumps(descriptor)+'\n')
                    ack = await instance.receive_json()
                    if ack != {'type': 'relay_ready', 'workerId': hello['workerId']}:
                        raise RuntimeError('Worker relay not ready')
                if not await self.valid(context): raise RuntimeError('Relay ownership changed')
                ready.set_result(hello['workerId'])
                tasks = [asyncio.create_task(self.forward(instance,channels)),
                         asyncio.create_task(self.forward(channels,instance)),
                         asyncio.create_task(self.guard(context))]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in tasks:
                    if task.done(): task.result()
        except asyncio.CancelledError:
            if not ready.done(): ready.cancel()
            raise
        except Exception as error:
            if not ready.done(): ready.set_exception(error)
            else:
                import logging
                logging.getLogger(__name__).warning('Message relay closed: %s', type(error).__name__)
        finally:
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            current = self.sessions.get(context[0])
            if current and current[1] is asyncio.current_task(): self.sessions.pop(context[0],None)

    @staticmethod
    async def forward(source, target):
        async for item in source:
            if item.type == aiohttp.WSMsgType.TEXT: await target.send_str(item.data)
            elif item.type == aiohttp.WSMsgType.BINARY: await target.send_bytes(item.data)
            else: break
