"""One real gateway WebSocket frame covers the final text and media outbox parts."""
import asyncio
import json

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from entry.channels_service import Channels
from entry.messaging_oss import OssUploadFailed
from plugins.cloud_messaging.media import pack
from tests.hermes_mt.test_messaging_media import context


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['accept', 'drop', 'reject', 'partial', 'partial-drop', 'all-failed', 'media-only', 'unbind'])
async def test_final_bundle_waits_for_completion_and_preserves_receipts_on_reconnect(postgres_database_url, monkeypatch, mode):
    settings, app, entry, binding, epoch, delivery = await context(postgres_database_url, 'uniagentgate')
    service = Channels(settings, {})
    service.database, service.store = entry.database, entry.messaging_routes.store
    monkeypatch.setattr(service.stream, 'ACK_WAIT_SECONDS', 2)
    frames = []
    unbound = False
    async def register(request):
        return web.json_response({'agent_id': 'bot', 'session_token': 'session', 'ttl_sec': 600})
    async def gateway(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({'type': 'connection.accepted', 'connection_id': 'test', 'agent_id': 'bot',
                            'payload': {'heartbeat_interval_sec': 60}})
        async for message in ws:
            frame = json.loads(message.data)
            if frame.get('type') != 'channel.message.send': continue
            frames.append(frame)
            if mode not in {'drop', 'partial-drop'}:
                await ws.send_json({'type': 'ack', 'in_reply_to': frame['message_id'],
                                    'payload': {'ok': mode != 'reject', 'downlink_msg_ids': ['provider-message']}})
        return ws
    upstream = web.Application()
    upstream.router.add_post('/v1/agent-runtimes/register', register)
    upstream.router.add_get('/v1/agent-runtimes/connect', gateway)
    async def stop_clients(app):
        await asyncio.gather(*(client.stop() for _, client in service.clients.values()))
    upstream.on_shutdown.append(stop_clients)
    async def public_url(user, item):
        nonlocal unbound
        assert user == 'alice'
        if mode == 'all-failed' or (mode in {'partial', 'partial-drop'} and item['kind'] == 'video'):
            raise OssUploadFailed('fixture upload rejected')
        if mode == 'unbind' and not unbound:
            await service.store.set_enabled('alice', False, remove=True)
            unbound = True
        return 'https://obs-nmhhht6.cucloud.cn/app-agent-prod/test/' + item['name']
    monkeypatch.setattr(service.oss, 'public_url', public_url)
    image = pack(b'\x89PNG\r\n\x1a\nimage', 'cat.png', 'image')
    video = pack(b'video fixture', 'cat.mp4', 'video')
    try:
        async with TestServer(upstream) as server, aiohttp.ClientSession() as http:
            service.http = http
            async with entry.database.acquire() as db:
                await db.execute("UPDATE messaging_bindings SET config=jsonb_set(config,'{gateway_url}',$2::jsonb) WHERE id=$1",
                                 binding['id'], json.dumps(str(server.make_url('')).rstrip('/')))
                payload = {'type': 'agent.request', 'agent_id': 'bot', 'message_id': 'upstream-request',
                           'channel': {'phone_number': '13800000000'}, 'session_id': 'original-session', 'turn_id': 'original-turn',
                           'payload': {'inputs': [{'type': 'text', 'text': 'draw a cat'}]}}
                await db.execute('UPDATE messaging_inbox SET payload=$2::jsonb WHERE delivery_id=$1', delivery, json.dumps(payload))
            await service.reconcile()
            await asyncio.wait_for(service.clients[binding['id']][1].ready.wait(), 10)
            for item in (image, video):
                await service.store.record_media(delivery, 'lease-owner', epoch, item)
            await service.send_pending()
            assert frames == []  # Media must not race ahead of the final response.
            text = '' if mode == 'media-only' else 'Final response.'
            await service.store.complete(delivery, 'lease-owner', epoch, {'content': text})
            await asyncio.gather(service.send_pending(), service.send_pending())
            async with entry.database.acquire() as db:
                rows = await db.fetch('SELECT state,error_code,platform_message_id,platform_ack FROM messaging_outbox ORDER BY part_index')
            if mode == 'unbind':
                assert frames == [] and all(row['state'] == 'unknown' for row in rows)
                return
            assert len(frames) == 1
            frame = frames[0]
            assert frame['session_id'] == 'original-session' and frame['turn_id'] == 'original-turn'
            assert frame['channel']['phone_number'] == '13800000000'
            assert frame['payload']['text'] and text in frame['payload']['text']
            expected_media = 0 if mode == 'all-failed' else 1 if mode in {'partial', 'partial-drop'} else 2
            media = frame['payload'].get('media', [])
            assert len(media) == expected_media
            if media:
                assert media[0]['kind'] == 'image' and media[0]['file_name'] == 'cat.png'
            if len(media) == 2:
                assert media[1]['kind'] == 'video' and media[1]['mime_type'] == 'video/mp4'
            assert len({row['platform_message_id'] for row in rows}) == 1
            if mode in {'partial', 'partial-drop', 'all-failed'}:
                assert rows[0]['state'] == ('unknown' if mode == 'partial-drop' else 'sent')
                assert '附件未能发送' in frame['payload']['text']
                if mode == 'partial-drop':
                    assert (await entry.messaging_routes.view('alice', 'uniagentgate'))['error_code'] == 'outbound_unconfirmed'
                assert rows[-1]['state'] == 'failed' and rows[-1]['error_code'] == 'media_oss_upload_failed'
            else:
                expected_state = {'drop': 'unknown', 'reject': 'failed'}.get(mode, 'sent')
                assert all(row['state'] == expected_state for row in rows)
            # Startup reconciliation and a manual reconnect must never split/replay a bundle.
            await service.store.recover(startup=True)
            await service.store.reconnect('alice')
            await service.reconcile()
            await asyncio.wait_for(service.clients[binding['id']][1].ready.wait(), 10)
            await service.send_pending()
            assert len(frames) == 1
    finally:
        await asyncio.gather(*(client.stop() for _, client in service.clients.values()))
        await entry.database.close()
