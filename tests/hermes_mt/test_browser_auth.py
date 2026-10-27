"""Browser-held MaaS tokens remain bound to their Entry login across HTTP requests."""
from __future__ import annotations

import json
import secrets
import time
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.browser_auth import BrowserAuth
from entry.config import Settings
from entry.crypto import CredentialCipher
from entry.db import Database
from entry.maas import Maas
from entry.proxy import proxy_http
from entry.store import LoginState, Session, Store
from entry.tenants import Tenant


class MemorySessions:
    """Exercise the HTTP boundary without requiring an external database in the first test."""
    def __init__(self):
        self.sessions = {}

    async def finish_login(self, **values):
        session = Session(secrets.token_urlsafe(24), values['user_id'], int(time.time()) + 600)
        self.sessions[session.sid] = session
        return LoginState(session, False)

    async def get_session(self, sid):
        return self.sessions.get(sid)

    async def delete_session(self, sid):
        self.sessions.pop(sid, None)

    async def write_audit(self, *args):
        pass


async def exercise_login(store=None, database_url='postgresql://unused@127.0.0.1:1/unused'):
    upstream = web.Application()
    async def sms(request):
        body = await request.json()
        owner = body['phone']
        return web.json_response({'uid': owner, 'token': f'login-{owner}', 'expireIn': 3600})
    async def plan(request):
        assert request.headers['Authorization'].startswith('Bearer login-')
        return web.json_response({})
    upstream.router.add_post('/login/smsLogin', sms)
    upstream.router.add_get('/plan', plan)
    async with TestServer(upstream) as maas_server:
        settings = Settings(credential_key=Fernet.generate_key().decode(), database_url=database_url,
                            maas_app=str(maas_server.make_url('')).rstrip('/'),
                            myplan_url=str(maas_server.make_url('/plan')), dev_login=True)
        app = build_app(settings)
        entry = next(r.handler.__self__ for r in app.router.routes() if r.handler.__name__ == 'login')
        app.on_startup.clear()
        app.on_cleanup.clear()
        entry.store = store or MemorySessions()
        # No tenant is needed for account-only operations; verify no instance is started.
        async def warm(user):
            return None
        entry._warm = warm
        async with aiohttp.ClientSession() as http:
            entry.maas = Maas(settings, http)
            async with TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
                async def login(phone):
                    response = await client.post('/hermes/__entry/login', json={'phone': phone, 'smsCode': '123456'})
                    assert response.status == 200
                    assert response.headers['Cache-Control'] == 'no-store'
                    data = await response.json()
                    assert data['maas_auth']['token'] == f'login-{phone}'
                    cookies = {name: value.value for name, value in response.cookies.items()}
                    proof_cookie = response.cookies[settings.cookie_name + '_maas']
                    assert proof_cookie['httponly'] and proof_cookie['path'] == '/hermes/'
                    return data, cookies

                alice, a = await login('13811111111')
                bob, b = await login('13822222222')
                route = '/hermes/__entry/maas-auth'
                async def check(data, cookies, status):
                    response = await client.post(route, cookies=cookies,
                        headers={'Authorization': 'Bearer ' + data['maas_auth']['token']})
                    assert response.status == status
                    body = await response.text()
                    assert data['maas_auth']['token'] not in body
                    return json.loads(body) if status == 200 else None
                assert (await check(alice, a, 200))['user_id'] == '13811111111'
                await check(bob, a, 401)
                mixed = {**a, settings.cookie_name + '_maas': b[settings.cookie_name + '_maas']}
                await check(alice, mixed, 401)
                await check(bob, b, 200)
                await check(alice, a, 200)  # A -> B -> A
                no_proof = {settings.cookie_name: a[settings.cookie_name]}
                await check(alice, no_proof, 401)  # pre-upgrade login
                tampered = {**a, settings.cookie_name + '_maas': 'invalid-proof'}
                await check(alice, tampered, 401)
                claims = json.loads(entry.browser_auth.cipher.decrypt(a[settings.cookie_name + '_maas'].encode()))
                claims['expires'] = 1
                expired = {**a, settings.cookie_name + '_maas': entry.browser_auth.cipher.encrypt(json.dumps(claims)).decode()}
                await check(alice, expired, 401)
                # A second Entry process can validate the binding with the same deployment key.
                second = BrowserAuth(entry.browser_auth.cipher)
                session = await entry.store.get_session(a[settings.cookie_name])
                identity = second.require(session, a[settings.cookie_name + '_maas'], 'Bearer ' + alice['maas_auth']['token'])
                assert alice['maas_auth']['token'] not in repr(identity)
                response = await client.post('/hermes/__entry/logout', cookies=a)
                assert response.status == 200
                assert response.cookies[settings.cookie_name + '_maas']['max-age'] == '0'
                await check(alice, a, 401)
                await check(bob, b, 200)
                dev = await client.post('/hermes/__entry/dev-login', cookies=b, json={'user': 'dev'})
                assert 'maas_auth' not in await dev.json()
                assert dev.cookies[settings.cookie_name + '_maas']['max-age'] == '0'
                script = await client.get('/hermes/__entry/browser-auth.js')
                assert script.status == 200 and script.content_type == 'application/javascript'
                for task in entry._bg:
                    await task
                return bob['maas_auth']['token']


@pytest.mark.asyncio
async def test_browser_login_binding_and_proxy_credential_boundary():
    await exercise_login()
    # The real proxy forwards neither the browser bearer nor its cookies to an instance.
    async def receive(request):
        assert 'Authorization' not in request.headers
        assert 'Cookie' not in request.headers
        assert request.headers['X-Hermes-Session-Token'] == 'instance-token'
        return web.json_response({'ok': True})
    target = web.Application()
    target.router.add_get('/probe', receive)
    async with TestServer(target) as server, aiohttp.ClientSession() as http:
        tenant = Tenant('alice', 'alice', '127.0.0.1', 'instance-token')
        tenant = SimpleNamespace(**tenant.__dict__)
        tenant.origin = f'{server.host}:{server.port}'
        proxy = web.Application()
        async def forward(request):
            return await proxy_http(request, Settings(), http, tenant, 'probe')
        proxy.router.add_get('/probe', forward)
        async with TestClient(TestServer(proxy)) as client:
            response = await client.get('/probe', headers={'Authorization': 'Bearer browser-secret', 'Cookie': 'secret=proof'})
            assert response.status == 200


@pytest.mark.asyncio
async def test_browser_login_uses_real_store_without_persisting_maas_token(postgres_database_url):
    database = Database(postgres_database_url, min_size=1, max_size=2)
    await database.connect()
    try:
        store = Store(database, CredentialCipher(Fernet.generate_key().decode()))
        token = await exercise_login(store, postgres_database_url)
        async with database.acquire() as connection:
            for table in ('users', 'auth_sessions', 'tenant_credentials', 'audit_events'):
                rows = await connection.fetch(f'SELECT row_to_json(t)::text AS row FROM {table} t')
                assert all(token not in row['row'] for row in rows)
    finally:
        await database.close()
