"""Missing connector migrations use real providers, TLS mail, OAuth PKCE and Entry cookies."""
import asyncio
import json
import logging
import shutil
import sys
import tarfile
import time
from types import SimpleNamespace
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet
import pytest
import pytest_asyncio

from entry.app import build_app
from entry.config import Settings
from entry.connector_oauth import ConnectorAccessLogger
from tests.hermes_mt.test_connectors import worker, port, forwarder, mcp_action, mtconnectors, mtstate
from tests.hermes_mt.connector_platform import Platform, Mail, tls_context


@pytest_asyncio.fixture
async def environment(tmp_path, postgres_database_url, monkeypatch):
    platform, mail = Platform(), Mail()
    provider = web.Application()
    provider.router.add_route('*', '/{tail:.*}', platform.handle)
    tls = tls_context(tmp_path)
    imap = await asyncio.start_server(mail.imap, '127.0.0.1', 0, ssl=tls)
    smtp = await asyncio.start_server(mail.smtp, '127.0.0.1', 0, ssl=tls)
    listeners, managers = [imap, smtp], {}
    async with TestServer(provider) as upstream:
        script, node = await worker(tmp_path, str(upstream.make_url('')).rstrip('/'), actual_providers=True,
            mail_ports=(imap.sockets[0].getsockname()[1], smtp.sockets[0].getsockname()[1]))
        from entry import connector_contract
        monkeypatch.setattr(connector_contract, 'CONTRACT_FILE', Path(script).parents[3] / 'contract.json')
        app = build_app(Settings(database_url=postgres_database_url, credential_key=Fernet.generate_key().decode(), backend='docker'))
        entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
        app.on_startup.clear()
        app.on_cleanup.clear()
        tenants = {}
        for owner in ('alice', 'bob'):
            home = tmp_path / owner
            home.mkdir()
            (home / 'config.yaml').write_text('mcp_servers: {}\n')
            manager = mtconnectors.Connectors(home, sys.executable, worker=script, node=node, port=port())
            managers[owner] = manager
            module = forwarder(home, manager, 'instance-' + owner, monkeypatch)
            server = await asyncio.start_server(module._handle, '127.0.0.1', 0)
            listeners.append(server)
            tenants[owner] = SimpleNamespace(user_id=owner, token='instance-' + owner,
                origin=f'127.0.0.1:{server.sockets[0].getsockname()[1]}', traffic_token='', host_header='', sandbox_id=None)
        async def ensure(owner): return tenants[owner]
        async def warm(owner): pass
        entry.tenants = SimpleNamespace(ensure_running=ensure)
        entry._warm = warm
        await entry.database.connect()
        try:
            async with aiohttp.ClientSession() as http, TestClient(TestServer(app,
                    access_log_class=ConnectorAccessLogger, access_log=logging.getLogger('connector-test-access')),
                    cookie_jar=aiohttp.DummyCookieJar()) as client:
                entry.http = http
                cookies = {}
                for owner in managers:
                    response = await entry._finish_login(owner, '', int((time.time() + 3600) * 1000))
                    cookies[owner] = {name: value.value for name, value in response.cookies.items()}
                async def call(owner, operation, expected=200, **extra):
                    response = await client.post('/hermes/__entry/connectors', json={'operation': operation, 'profile': 'default', **extra}, cookies=cookies[owner])
                    result = await response.json()
                    assert response.status == expected, result
                    return response, result
                yield SimpleNamespace(platform=platform, mail=mail, entry=entry, client=client, http=http,
                    managers=managers, call=call, cookies=cookies, tenants=tenants, tmp=tmp_path)
        finally:
            for manager in managers.values():
                await manager.close()
            for server in listeners:
                server.close()
                await server.wait_closed()
            for task in entry._bg:
                task.cancel()
            await asyncio.gather(*entry._bg, return_exceptions=True)
            await entry.database.close()


async def restore(env, owner):
    manager = env.managers[owner]
    archive, _ = mtstate.build_archive(manager.home, env.tmp / ('snapshot-' + str(time.monotonic_ns())), 'sandbox', 1, '')
    key = (manager.home / 'open-connector/secrets.json').read_bytes()
    await manager.close()
    shutil.rmtree(manager.home)
    manager.home.mkdir()
    with tarfile.open(archive) as saved:
        saved.extractall(manager.home, filter='data')
    await manager.restore()
    assert (manager.home / 'open-connector/secrets.json').read_bytes() == key


@pytest.mark.asyncio
async def test_mail_and_aminer_real_provider_isolation_revoke_and_restore(environment):
    env = environment
    for owner in ('alice', 'bob', 'alice'):
        values = {'aminer': {'apiKey': owner + '-academic'},
            'qq_mail': {'email': owner + '@qq.com', 'authorizationCode': owner.ljust(16, 'x')},
            'netease_mail': {'email': owner + '@163.com', 'authorizationCode': owner.ljust(16, 'x')}}
        for id, credentials in values.items():
            _, result = await env.call(owner, 'connect', id=id, values=credentials)
            assert next(row for row in result['connectors'] if row['id'] == id)['connected']
            action, inputs = ('aminer.search_paper', {'title': 'test'}) if id == 'aminer' else (id + '.list_folders', {})
            result = await mcp_action(env.http, env.managers[owner], id, action, inputs)
            assert owner in json.dumps(result), result
            database = (env.managers[owner].home / 'open-connector/connect.sqlite').read_bytes()
            assert credentials[next(reversed(credentials))].encode() not in database
    assert {('imap', 'alice'), ('smtp', 'alice'), ('imap', 'bob'), ('smtp', 'bob')} <= set(env.mail.logins)
    await env.call('alice', 'connect', expected=409, id='qq_mail', values={'email': 'alice@qq.com', 'authorizationCode': 'bad'})
    await restore(env, 'alice')
    result = await mcp_action(env.http, env.managers['alice'], 'qq_mail', 'qq_mail.list_folders', {})
    assert 'alice' in json.dumps(result)
    for id in ('qq_mail', 'netease_mail', 'aminer'):
        stale = env.managers['alice'].saved(id)
        await env.call('alice', 'disable', id=id)
        assert (await env.http.post(stale['url'], headers=stale['headers'], json={})).status == 403
        await env.call('alice', 'enable', id=id)
        await env.call('alice', 'disconnect', id=id)
        assert (await env.http.post(stale['url'], headers=stale['headers'], json={})).status == 403
        _, status = await env.call('bob', 'list')
        assert next(row for row in status['connectors'] if row['id'] == id)['connected']


@pytest.mark.asyncio
async def test_oauth_cookie_binding_pkce_one_time_refresh_and_archive(environment, caplog):
    env = environment
    caplog.set_level(logging.INFO, logger='connector-test-access')
    for owner in ('alice', 'bob', 'alice'):
        for id in ('qcc_mcp', 'eastmoney_mcp', 'ifind_mcp'):
            response, result = await env.call(owner, 'authorize', id=id, values={'clientId': 'registered-cloud-client'} if id == 'ifind_mcp' else {})
            assert set(result) == {'connectors', 'authorizationUrl'}
            params = env.platform.grant(result['authorizationUrl'], owner)
            ticket_name = 'hermes_connector_oauth_' + id
            ticket = response.cookies[ticket_name].value
            assert response.cookies[ticket_name]['httponly']
            callback = '/hermes/__entry/connectors/' + id + '/oauth/callback'
            expired = json.loads(env.entry.store.cipher.decrypt(ticket.encode()))
            expired['expires'] = time.time() - 1
            rejected = await env.client.get(callback, params=params, cookies={**env.cookies[owner],
                ticket_name: env.entry.store.cipher.encrypt(json.dumps(expired)).decode()})
            assert rejected.status == 400
            # A stolen state/authorization URL cannot bind a different logged-in user.
            wrong = 'bob' if owner == 'alice' else 'alice'
            rejected = await env.client.get(callback, params=params, cookies={**env.cookies[wrong], ticket_name: ticket})
            assert rejected.status == 400
            rejected = await env.client.get(callback, params={**params, 'state': 'forged'}, cookies={**env.cookies[owner], ticket_name: ticket})
            assert rejected.status == 400
            if owner == 'alice' and id == 'qcc_mcp':
                await restore(env, owner)  # Pending PKCE state survives a rebuilt instance too.
            completed = await env.client.get(callback, params=params, cookies={**env.cookies[owner], ticket_name: ticket})
            text = await completed.text()
            assert completed.status == 200, text
            assert params['state'] not in text and '-secret' not in text
            assert params['state'] not in caplog.text
            replay = await env.client.get(callback, params=params, cookies={**env.cookies[owner], ticket_name: ticket})
            assert replay.status == 400
            _, status = await env.call(owner, 'list')
            assert next(row for row in status['connectors'] if row['id'] == id)['connected']
            inputs = {'toolName': 'lookup', 'arguments': {}, **({'serverType': 'finance'} if id == 'ifind_mcp' else {})}
            result = await mcp_action(env.http, env.managers[owner], id, id + '.call_tool', inputs)
            assert owner in json.dumps(result), result
    await restore(env, 'alice')
    await asyncio.sleep(2)  # Expired access token must refresh using the persisted encrypted credential.
    for id in ('qcc_mcp', 'eastmoney_mcp', 'ifind_mcp'):
        result = await mcp_action(env.http, env.managers['alice'], id, id + '.call_tool',
            {'toolName': 'lookup', 'arguments': {}, **({'serverType': 'finance'} if id == 'ifind_mcp' else {})})
        assert 'alice' in json.dumps(result), result
        stale = env.managers['alice'].saved(id)
        await env.call('alice', 'disconnect', id=id)
        assert (await env.http.post(stale['url'], headers=stale['headers'], json={})).status == 403
    # Token exchange is one-time. If archiving fails, save the resulting state without
    # re-exchanging the code or repeating a provider action.
    response, result = await env.call('alice', 'authorize', id='qcc_mcp', values={})
    params = env.platform.grant(result['authorizationUrl'], 'alice')
    ticket = response.cookies['hermes_connector_oauth_qcc_mcp'].value
    env.tenants['alice'].sandbox_id = 'sandbox-alice'
    async def failed_archive(*args): raise RuntimeError('archive unavailable')
    env.entry.cube = SimpleNamespace(sync_state=failed_archive)
    failed = await env.client.get('/hermes/__entry/connectors/qcc_mcp/oauth/callback', params=params,
        cookies={**env.cookies['alice'], 'hermes_connector_oauth_qcc_mcp': ticket})
    assert failed.status == 400 and '保存未确认' in await failed.text()
    assert params['code'] not in env.platform.grants  # The provider already consumed this code.
    env.tenants['alice'].sandbox_id = None
    _, state = await env.call('alice', 'save', id='qcc_mcp')
    assert next(row for row in state['connectors'] if row['id'] == 'qcc_mcp')['connected']
    assert 'alice' in env.platform.refreshes
    home = env.managers['bob'].home
    for name in ('connect.sqlite', 'connect.sqlite-wal'):
        file = home / 'open-connector' / name
        if file.exists():
            raw = file.read_bytes()
            assert b'bob-refresh' not in raw and b'code_verifier' not in raw
