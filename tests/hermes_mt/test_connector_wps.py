"""Cloud WPS binds through Kingsoft's authorization page (as UniClaw does), not a typed API key.

Real cloud connector runtime, real WPS provider, real mtconnectors; only Kingsoft's two hosts are
loopback fixtures: the token exchange (api.wps.cn) and the Skill Hub MCP (mcp-center.wps.cn).
"""
import asyncio
import sys
from urllib.parse import parse_qs, urlsplit

import aiohttp
import pytest
import yaml
from aiohttp import web
from aiohttp.test_utils import TestServer

from tests.hermes_mt.test_connectors import mcp_action, port, worker

import mtconnectors


class Kingsoft:
    def __init__(self):
        self.approved = False
        self.exchanged = []
        self.mcp_auth = []

    async def handle(self, request):
        host = request.headers.get('X-Fixture-Host')
        body = await request.json()
        if host == 'api.wps.cn' and request.path.endswith('/wps_auth/exchange'):
            self.exchanged.append(body['code'])
            if not self.approved:
                return web.json_response({'code': 202})
            return web.json_response({'code': 200, 'data': {'token': 'kingsoft-token-secret', 'expires_in': 3600}})
        if host == 'mcp-center.wps.cn' and request.path == '/skill_hub/mcp':
            self.mcp_auth.append((request.headers.get('Authorization'), request.headers.get('X-Client-Id')))
            if request.headers.get('Authorization') != 'Bearer kingsoft-token-secret':
                return web.Response(status=401)
            method = body.get('method')
            if method == 'initialize':
                value = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'skill-hub', 'version': '1'}}
            elif method == 'tools/list':
                value = {'tools': [{'name': 'search_files', 'description': 'Search WPS files',
                                    'inputSchema': {'type': 'object', 'properties': {'keyword': {'type': 'string'}}}}]}
            else:
                return web.Response(status=202)
            return web.json_response({'jsonrpc': '2.0', 'id': body['id'], 'result': value})
        return web.Response(status=404)


async def poll_until(manager, session_id, *, wanted, seconds=20):
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        result = await manager.request({'operation': 'authorize.poll', 'id': 'wps_mcp', 'sessionId': session_id})
        if result['status'] in wanted or asyncio.get_running_loop().time() > deadline:
            return result
        await asyncio.sleep(0.5)


@pytest.mark.asyncio
async def test_wps_connects_through_the_kingsoft_page_and_registers_only_once_authorized(tmp_path, monkeypatch):
    kingsoft = Kingsoft()
    provider = web.Application()
    provider.router.add_route('*', '/{tail:.*}', kingsoft.handle)
    async with TestServer(provider) as upstream, aiohttp.ClientSession() as http:
        script, node = await worker(tmp_path, str(upstream.make_url('')).rstrip('/'), actual_providers=True)
        home = tmp_path / 'home'
        home.mkdir()
        manager = mtconnectors.Connectors(home, sys.executable, worker=script, node=node, port=port())
        try:
            with pytest.raises(ValueError):  # the token only ever comes from Kingsoft's page
                await manager.request({'operation': 'connect', 'id': 'wps_mcp', 'values': {}})

            started = await manager.request({'operation': 'authorize', 'id': 'wps_mcp'})
            page = urlsplit(started['authorizationUrl'])
            assert (page.scheme, page.hostname, page.path) == ('https', 'mcp-center.wps.cn', '/kdocs-auth/auth-guide')
            assert started['status'] == 'pending' and started['sessionId']

            waiting = await poll_until(manager, started['sessionId'], wanted={'connected'}, seconds=2)
            assert waiting['status'] == 'pending'
            assert kingsoft.exchanged and set(kingsoft.exchanged) == set(parse_qs(page.query)['auth_code'])
            assert manager.saved('wps_mcp') is None  # nothing is registered before the user approves

            kingsoft.approved = True
            connected = await poll_until(manager, started['sessionId'], wanted={'connected', 'failed', 'expired'})
            assert connected['status'] == 'connected', connected
            row = next(row for row in connected['connectors'] if row['id'] == 'wps_mcp')
            assert row['configured'] and row['enabled'] and row['connected']
            assert 'kingsoft-token-secret' not in str(connected)
            assert yaml.safe_load((home / 'config.yaml').read_text())['mcp_servers']['connector_wps_mcp']['enabled'] is True

            # The saved token reaches Skill Hub through the registered connector MCP.
            tools = await mcp_action(http, manager, 'wps_mcp', 'wps_mcp.list_tools', {})
            assert 'search_files' in str(tools)
            assert all(token == 'Bearer kingsoft-token-secret' and client and len(client) == 16
                       for token, client in kingsoft.mcp_auth)
        finally:
            await manager.close()


@pytest.mark.asyncio
async def test_entry_persists_the_instance_only_when_the_poll_reports_the_connection(monkeypatch):
    """Starting and polling only read session state; archiving on each 2 s poll would cost a full
    instance archive per tick. The poll that reports "connected" is the one that changed state."""
    import json
    from types import SimpleNamespace
    from entry import connector_routes
    specs = {'wps_mcp': {'auth': 'browser_poll', 'fields': []}, 'amap': {'auth': 'api_key', 'fields': ['apiKey']}}
    replies = iter([
        {'sessionId': 'one', 'status': 'pending', 'authorizationUrl': 'https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=x'},
        {'sessionId': 'one', 'status': 'pending'},
        {'sessionId': 'one', 'status': 'connected', 'token': 'kingsoft-token-secret'},
    ])
    sent, archived = [], []

    async def instance(session, path, data, capability):
        sent.append(data)
        return {**next(replies), 'connectors': [{'id': key, 'configured': True, 'enabled': True, 'connected': True}
                                                for key in specs]}

    async def checkpoint(entry, user, tenant):
        archived.append(user)

    monkeypatch.setattr(connector_routes, 'checkpoint', checkpoint)
    user = SimpleNamespace(user_id='alice', sid='sid')
    entry = SimpleNamespace(share_routes=SimpleNamespace(instance=instance),
                            store=SimpleNamespace(get_session=lambda sid: asyncio.sleep(0, user)),
                            _tenant_for=lambda session: asyncio.sleep(0, 'tenant'))
    routes = connector_routes.ConnectorRoutes(entry)
    call = lambda operation, **extra: routes.browser_operation(
        user, operation, 'default', {'operation': operation, 'id': 'wps_mcp', **extra}, specs)

    started = json.loads((await call('authorize')).text)
    assert started['authorizationUrl'].startswith('https://mcp-center.wps.cn/') and started['sessionId'] == 'one'
    assert json.loads((await call('authorize.poll', sessionId='one')).text)['status'] == 'pending'
    assert archived == []
    done = await call('authorize.poll', sessionId='one')
    assert json.loads(done.text)['status'] == 'connected' and archived == ['alice']
    assert 'kingsoft-token-secret' not in done.text
    assert [item['operation'] for item in sent] == ['authorize', 'authorize.poll', 'authorize.poll']
    with pytest.raises(ValueError):  # a poll must name its session
        await call('authorize.poll')
