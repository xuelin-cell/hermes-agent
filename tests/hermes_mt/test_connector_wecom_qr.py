"""Cloud WeCom connectors bind by QR scan, as on desktop, instead of a typed Bot ID/secret."""
import json
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from entry import connector_wecom_qr
from entry.connector_routes import ConnectorRoutes

SPECS = {'wecom_bot': {'auth': 'custom_credential', 'fields': ['botId', 'secret']},
         'amap': {'auth': 'api_key', 'fields': ['apiKey']}}


@pytest.mark.asyncio
async def test_scan_saves_the_bot_through_connect_and_keeps_its_secret_off_the_browser(monkeypatch):
    statuses = ['scanned', 'success']

    async def generate(request):
        return web.json_response({'data': {'scode': 'scode-1',
                                           'auth_url': 'https://work.weixin.qq.com/ai/qc/auth?scode=scode-1'}})

    async def query(request):
        assert request.query['scode'] == 'scode-1'
        status = statuses.pop(0)
        bot = {'botid': 'bot-id', 'secret': 'bot-secret-value'} if status == 'success' else None
        return web.json_response({'data': {'status': status, 'bot_info': bot}})

    upstream = web.Application()
    upstream.router.add_get('/generate', generate)
    upstream.router.add_get('/query_result', query)
    async with TestServer(upstream) as server, aiohttp.ClientSession() as http:
        monkeypatch.setattr(connector_wecom_qr, 'GENERATE_URL', str(server.make_url('/generate')))
        monkeypatch.setattr(connector_wecom_qr, 'QUERY_URL', str(server.make_url('/query_result')) + '?scode=')
        routes = ConnectorRoutes(SimpleNamespace(http=http))
        saved = []

        async def execute(session, data):  # the instance connect + persistence path
            saved.append(data)
            return {'connectors': [{'id': key, 'connected': key == 'wecom_bot', 'configured': key == 'wecom_bot',
                                    'enabled': True, 'token': 'never-forwarded'} for key in SPECS]}
        routes.execute = execute
        alice, bob = SimpleNamespace(user_id='alice'), SimpleNamespace(user_id='bob')
        call = lambda user, operation, session_id=None: routes.wecom_qr_operation(
            user, operation, 'default', session_id, SPECS)

        started = json.loads((await call(alice, 'qr.start')).text)
        assert started['qrState'] == 'pending' and started['authUrl'].startswith('https://work.weixin.qq.com/')
        session_id = started['sessionId']
        assert (await call(bob, 'qr.poll', session_id)).status == 502
        assert json.loads((await call(alice, 'qr.poll', session_id)).text)['qrState'] == 'scanned'
        assert saved == []  # polling never touches the instance or its state archive

        confirmed = await call(alice, 'qr.poll', session_id)
        body = json.loads(confirmed.text)
        assert body['qrState'] == 'confirmed'
        assert saved == [{'operation': 'connect', 'profile': 'default', 'id': 'wecom_bot',
                          'values': {'botId': 'bot-id', 'secret': 'bot-secret-value'}}]
        assert 'bot-secret-value' not in confirmed.text and 'never-forwarded' not in confirmed.text
        assert next(row for row in body['connectors'] if row['id'] == 'wecom_bot')['connected'] is True
        assert (await call(alice, 'qr.poll', session_id)).status == 502  # a finished scan cannot be replayed
