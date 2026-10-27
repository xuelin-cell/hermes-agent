"""Real Entry + PG + shared Node plan clients against a local MaaS protocol fixture."""
from __future__ import annotations

import asyncio
import base64
import json
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from aiohttp import web, DummyCookieJar
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet
import pytest

from entry.app import build_app
from entry.config import Settings
from entry.drive_worker import DriveWorker

ROOT = Path(__file__).resolve().parents[2]


@asynccontextmanager
async def stack(tmp_path, database_url):
    calls, mode = [], {'fail': False, 'hold': False}
    started, release = asyncio.Event(), asyncio.Event()

    async def upstream(request):
        assert request.headers['Authorization'].startswith('Bearer maas-')
        assert 'Cookie' not in request.headers
        calls.append((request.path, request.headers['Authorization']))
        if mode['hold']:
            started.set()
            await release.wait()
        if mode['fail']:
            return web.json_response({'apiKey': 'do-not-expose-upstream'}, status=502)
        if request.path.endswith('system-config'):
            assert set(request.query) == {'key'}
            key = request.query['key']
            assert key in {'welcome_config_v3_zh-CN', 'welcome_config_v3_en'}
            return web.json_response({'version': 'v3', 'configValue': json.dumps({'modules': [{'name': request.headers['Authorization'][-4:] + '-' + key}]})})
        if request.path.endswith('market-ticket'):
            return web.json_response({'ticket': 'signed-ticket', 'customerId': 'customer', 'timestamp': '123', 'number': '456'})
        phone = request.headers['Authorization'].removeprefix('Bearer maas-')
        return web.json_response({'code': 0, 'data': {
            'productName': phone[-4:], 'planType': 'token_plan', 'status': 'valid',
            'apiKey': 'private-model-key', 'models': 'private-model-config', 'agentKeyPersonal': 'private-agent-key',
            'tokenPlanUsage': {'totalQuota': 1000, 'usedQuota': len(calls) * 10, 'concurrencyLimit': 2},
        }})

    upstream_app = web.Application()
    upstream_app.router.add_get('/{tail:.*}', upstream)
    async with TestServer(upstream_app) as service:
        script = tmp_path / 'worker.mjs'
        script.write_text('import { startDriveWorker } from ' + json.dumps((ROOT / 'deploy/hermes-mt/entry/entry/static/cloud-drive-worker.mjs').as_uri()) + ';\n' +
            'startDriveWorker((url, options) => { const u = new URL(url); if (u.origin !== "https://maas.ai-yuanjing.com") throw new Error("Wrong origin"); return fetch(' + json.dumps(str(service.make_url('')).rstrip('/')) + ' + u.pathname + u.search, options); });')
        app = build_app(Settings(database_url=database_url, credential_key=Fernet.generate_key().decode()))
        entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
        app.on_startup.clear()
        app.on_cleanup.clear()
        await entry.database.connect()
        entry.drive_routes.worker.scratch.cleanup()
        entry.drive_routes.worker = DriveWorker(script, node=shutil.which('node'))

        async def warm(user):
            pass
        entry._warm = warm

        async def login(request):
            body = await request.json()
            return await entry._finish_login(body['phone'], '', int(time.time() * 1000) + 600_000,
                                            phone='' if body.get('legacy') else body['phone'], maas_token='maas-' + body['phone'])
        app.router.add_post('/test-login', login)
        async with TestClient(TestServer(app), cookie_jar=DummyCookieJar()) as client:
            async def auth(phone, legacy=False):
                response = await client.post('/test-login', json={'phone': phone, 'legacy': legacy})
                data = await response.json()
                cookies = {key: value.value for key, value in response.cookies.items()}
                return {'cookies': cookies, 'headers': {'Authorization': 'Bearer ' + data['maas_auth']['token']}}

            async def call(identity, operation):
                response = await client.post('/hermes/__entry/plan/' + operation, **identity)
                return response, await response.json() if response.content_type == 'application/json' else None

            try:
                yield client, entry, auth, call, calls, mode, started, release
            finally:
                release.set()
                await entry.drive_routes.close()
                await entry.database.close()


@pytest.mark.asyncio
async def test_plan_usage_is_redacted_cached_and_bound_to_the_original_login(tmp_path, postgres_database_url):
    async with stack(tmp_path, postgres_database_url) as (client, entry, auth, call, calls, mode, started, release):
        a, b = await auth('13811111111'), await auth('13822222222')
        (response, first), (_, concurrent) = await asyncio.gather(call(a, 'usage'), call(a, 'usage'))
        assert response.status == 200 and first == concurrent and len(calls) == 1
        assert first['data']['quota']['remaining'] == 990
        me = await (await client.get('/hermes/__entry/me', cookies=a['cookies'])).json()
        assert first['account'] == {'maskedPhone': me['display'], 'expiresAt': me['expires_at'] * 1000}
        for identity, name in [(b, '2222'), (a, '1111')]:
            response, result = await call(identity, 'usage')
            assert response.headers['Cache-Control'] == 'no-store' and result['data']['productName'] == name
            assert not any(secret in json.dumps(result) for secret in ['private-', 'maas-', 'apiKey', 'models', 'agentKey'])
        assert len(calls) == 2
        _, refreshed = await call(a, 'refresh')
        assert refreshed['data']['quota']['used'] > first['data']['quota']['used'] and len(calls) == 3
        mode['fail'] = True
        _, failed = await call(a, 'refresh')
        assert failed == {'status': 'failed'}
        mixed = {**a, 'headers': b['headers']}
        assert (await call(mixed, 'usage'))[0].status == 401
        mode.update(fail=False, hold=True)
        pending = asyncio.create_task(call(a, 'refresh'))
        await started.wait()
        await client.post('/hermes/__entry/logout', cookies=a['cookies'])
        release.set()
        assert (await pending)[0].status == 401
        assert (await call(a, 'usage'))[0].status == 401


@pytest.mark.asyncio
async def test_subscription_uses_trusted_phone_single_use_ticket_and_never_returns_maas_token(tmp_path, postgres_database_url):
    async with stack(tmp_path, postgres_database_url) as (client, entry, auth, call, calls, mode, started, release):
        a = await auth('13811111111')
        for _ in range(2):
            response, result = await call(a, 'subscribe')
            assert response.status == 200 and result['status'] == 'ready'
            url = urlsplit(result['url'])
            assert url.scheme == 'https' and url.netloc == 'market.ai-yuanjing.com'
            params = parse_qs(url.fragment.split('?', 1)[1])
            assert base64.b64decode(params['u'][0]).decode() == '13811111111'
            assert params['ticket'] == ['signed-ticket'] and 'maas-' not in result['url']
        assert len(calls) == 2  # A fresh market-ticket for every explicit request.
        legacy = await auth('13822222222', legacy=True)
        assert (await call(legacy, 'subscribe'))[1] == {'status': 'failed', 'reason': 'missing-phone'}
        assert len(calls) == 2
        mode['fail'] = True
        assert (await call(a, 'subscribe'))[1] == {'status': 'failed', 'reason': 'upstream'}
        assert (await call({**a, 'headers': {'Authorization': 'Bearer forged'}}, 'subscribe'))[0].status == 401


@pytest.mark.asyncio
async def test_welcome_v3_uses_fixed_locale_and_the_current_bound_account(tmp_path, postgres_database_url):
    async with stack(tmp_path, postgres_database_url) as (client, entry, auth, call, calls, mode, started, release):
        a, b = await auth('13811111111'), await auth('13822222222')
        for identity, suffix in [(a, '1111'), (b, '2222'), (a, '1111')]:
            response = await client.post('/hermes/__entry/welcome/zh-CN', **identity)
            data = await response.json()
            assert response.status == 200 and response.headers['Cache-Control'] == 'no-store'
            assert data['version'] == 'v3' and data['modules'][0]['name'] == suffix + '-welcome_config_v3_zh-CN'
            assert not any(secret in json.dumps(data) for secret in ['maas-', 'private-', 'Authorization'])
        assert (await client.post('/hermes/__entry/welcome/en', **a)).status == 200
        count = len(calls)
        assert (await client.post('/hermes/__entry/welcome/fr', **a)).status == 400
        assert (await client.post('/hermes/__entry/welcome/en', cookies=a['cookies'], headers=b['headers'])).status == 401
        assert len(calls) == count
        mode['fail'] = True
        response = await client.post('/hermes/__entry/welcome/en', **a)
        assert response.status == 503 and 'do-not-expose' not in await response.text()
