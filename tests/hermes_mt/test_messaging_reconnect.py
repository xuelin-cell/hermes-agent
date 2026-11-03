"""Reconnecting a platform preserves durable work and its existing instance relay."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from entry.channels_service import Channels
from tests.hermes_mt.test_messaging_media import context


@pytest.mark.asyncio
async def test_retry_and_reconnect_restart_upstream_without_cancelling_work(postgres_database_url):
    settings, app, entry, binding, epoch, delivery = await context(postgres_database_url, 'uniagentgate')
    store = entry.messaging_routes.store
    outbound = await store.complete(delivery, 'lease-owner', epoch, {'content': 'ready to send'})
    queued = await store.ingest(binding['id'], binding['revision'], 'chat', 'queued', {'text': 'next'})
    running = await store.ingest(binding['id'], binding['revision'], 'chat', 'running', {'text': 'active'})
    async with entry.database.acquire() as db:
        await db.execute("UPDATE messaging_inbox SET state='running',lease_owner='executor',lease_until=now()+interval '90 seconds' WHERE delivery_id=$1", running)
    other = await store.configure('alice', '', 'other-bot', 'other-secret', platform='wecom')
    auth = await entry.store.finish_login(user_id='alice', phone='', api_key='', endpoint=None, catalog=None,
                                        ttl_s=3600, upstream_expires_at_ms=None, login_method='sms')
    service = Channels(settings, {})
    service.database, service.store = entry.database, store
    relay = SimpleNamespace(close=AsyncMock(), binding_id=binding['id'])
    service.sockets['alice'] = (epoch, relay, binding['revision'])
    connected = asyncio.Queue()
    async def register(request):
        return web.json_response({'agent_id': 'bot', 'session_token': 'session', 'ttl_sec': 600})
    async def upstream(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({'type': 'connection.accepted', 'connection_id': 'test', 'agent_id': 'bot', 'payload': {'heartbeat_interval_sec': 60}})
        connected.put_nowait(True)
        async for message in ws: pass
        return ws
    gateway = web.Application()
    async def stop_clients(app):
        await asyncio.gather(*(client.stop() for _, client in service.clients.values()))
    gateway.on_shutdown.append(stop_clients)
    gateway.router.add_post('/v1/agent-runtimes/register', register)
    gateway.router.add_get('/v1/agent-runtimes/connect', upstream)
    try:
        async with TestServer(gateway) as server, TestClient(TestServer(app)) as client, aiohttp.ClientSession() as http:
            service.http = http
            async with entry.database.acquire() as db:
                await db.execute("UPDATE messaging_bindings SET config=jsonb_set(config,'{gateway_url}',$2::jsonb) WHERE id=$1",
                                 binding['id'], json.dumps(str(server.make_url('')).rstrip('/')))
            await service.reconcile()
            await asyncio.wait_for(connected.get(), 10)
            for operation in ('retry', 'reconnect'):
                before = service.clients[binding['id']][1]
                response = await client.post('/hermes/__entry/messaging/' + operation,
                    headers={'Cookie': settings.cookie_name + '=' + auth.session.sid}, json={'platform': 'uniagentgate'})
                assert response.status == 200
                await service.reconcile()
                await asyncio.wait_for(connected.get(), 10)
                assert service.clients[binding['id']][1] is not before
                assert (await store.binding('alice'))['revision'] == binding['revision']
                assert (await store.binding('alice', 'wecom'))['revision'] == other['revision']
                async with entry.database.acquire() as db:
                    assert await db.fetchval('SELECT state FROM messaging_inbox WHERE delivery_id=$1', queued) == 'queued'
                    active = await db.fetchrow('SELECT state,lease_owner FROM messaging_inbox WHERE delivery_id=$1', running)
                    assert dict(active) == {'state': 'running', 'lease_owner': 'executor'}
                    assert await db.fetchval('SELECT state FROM messaging_outbox WHERE outbound_id=$1', outbound) == 'pending'
                relay.close.assert_not_called()
    finally:
        await asyncio.gather(*(client.stop() for _, client in service.clients.values()))
        await entry.database.close()
