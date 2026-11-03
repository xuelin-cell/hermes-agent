"""Pull instance notifications into the existing PG inbox/outbox; no new tables or callbacks."""
import asyncio
import hashlib
import json
import logging
import re

import aiohttp
import asyncpg
from aiohttp import web

from plugins.cloud_messaging.media import outbound_bytes, message_limit

log = logging.getLogger(__name__)


class MessagingNotifications:
    def __init__(self, entry):
        self.entry = entry

    async def instance(self, tenant, body):
        origin = tenant.origin or f'{tenant.ip}:{self.entry.s.forward_port}'
        headers = {'X-Hermes-Session-Token': tenant.token, 'X-Hermes-Entry-Token': tenant.token,
                   'Host': tenant.host_header or f'127.0.0.1:{self.entry.s.hermes_port}'}
        if tenant.traffic_token: headers['cube-traffic-access-token'] = tenant.traffic_token
        async with self.entry.http.post(f'http://{origin}/api/plugins/cloud-messaging/notifications',
                headers=headers, json=body, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10)) as response:
            if response.status != 200: raise RuntimeError('Notification endpoint unavailable')
            return await response.json()

    async def admit(self, user, item):
        identifier, platform, chat = item.get('id'), item.get('platform'), item.get('chat')
        content, media = item.get('content'), item.get('media')
        if (not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier)
                or platform not in {'uniagentgate','dingtalk','weixin','wecom','feishu'}
                or not isinstance(chat, str) or not 0 < len(chat) <= 512
                or not isinstance(content, str) or len(content)>20000
                or not isinstance(media, list) or len(media)>20):
            raise ValueError('Invalid notification')
        if sum(len(outbound_bytes(platform,value)) for value in media)>message_limit(platform): raise ValueError('Notification media too large')
        async with self.entry.database.acquire() as db, db.transaction():
            binding = await db.fetchrow('''SELECT b.* FROM messaging_bindings b JOIN users u USING(user_id)
                WHERE b.user_id=$1 AND b.platform=$2 AND b.enabled AND b.deleted_at IS NULL AND u.status='active' FOR SHARE OF b''', user, platform)
            if not binding: return 'failed'
            previous = await db.fetchrow('SELECT * FROM messaging_inbox WHERE delivery_id=$1', identifier)
            if previous:
                if (previous['user_id'],previous['binding_id'],previous['external_chat_id']) != (user,binding['id'],chat):
                    raise ValueError('Notification owner changed')
                payload = json.loads(previous['payload'])
                if payload.get('_cloud_notification') != item: raise ValueError('Notification content changed')
            else:
                source = await db.fetchval('''SELECT payload FROM messaging_inbox WHERE binding_id=$1
                    AND binding_revision=$2 AND external_chat_id=$3 AND NOT payload ? '_cloud_notification'
                    ORDER BY created_at DESC LIMIT 1''', binding['id'], binding['revision'], chat)
                if source is None: return 'failed'
                payload = json.loads(source)
                payload['_cloud_notification'] = item
                await db.execute('''INSERT INTO messaging_inbox(delivery_id,binding_id,user_id,binding_revision,platform,
                    bot_key,external_chat_id,external_message_id,payload,state,execution_ref)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'completed','cron')''', identifier,binding['id'],user,
                    binding['revision'],platform,binding['bot_key'],chat,'cron:'+identifier,json.dumps(payload))
                parts = [{'content':content}, *({'media':value} for value in media)]
                for index, part in enumerate(parts):
                    outbound = hashlib.sha256(f'{identifier}:{index}'.encode()).hexdigest()[:32]
                    await db.execute('''INSERT INTO messaging_outbox(outbound_id,delivery_id,part_index,binding_revision,payload)
                        VALUES($1,$2,$3,$4,$5::jsonb)''',outbound,identifier,index,binding['revision'],json.dumps(part))
            states = await db.fetch('SELECT state FROM messaging_outbox WHERE delivery_id=$1',identifier)
            values = {row['state'] for row in states}
            if values == {'sent'}: return 'sent'
            for terminal in ('unknown','failed','cancelled'):
                if terminal in values: return terminal
            return 'queued'

    async def flush(self, user):
        tenant = await self.entry.tenants.ensure_running(user, touch=False)
        items = (await self.instance(tenant, {'operation':'list'})).get('items', [])
        if not isinstance(items,list) or len(items)>4: raise ValueError('Invalid notification queue')
        for item in items:
            state = await self.admit(user, item)
            await self.instance(tenant, {'operation':'ack','id':item['id'],'state':state})

    async def loop(self):
        semaphore = asyncio.Semaphore(4)
        async def drain(user):
            async with semaphore:
                try: await self.flush(user)
                except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError, ValueError, web.HTTPException):
                    log.debug('Notification drain deferred')
        while True:
            try:
                async with self.entry.database.acquire() as db:
                    rows = await db.fetch("""SELECT DISTINCT r.user_id FROM tenant_runtime r JOIN messaging_bindings b USING(user_id)
                        JOIN users u USING(user_id) WHERE r.state='running' AND b.enabled AND b.deleted_at IS NULL AND u.status='active' """)
                await asyncio.gather(*(drain(row['user_id']) for row in rows))
            except (asyncpg.PostgresError, OSError, asyncio.TimeoutError):
                log.warning('Notification polling deferred: database unavailable')
            await asyncio.sleep(3)
