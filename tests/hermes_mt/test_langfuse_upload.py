"""Entry capabilities carry traces, never MaaS credentials, into Agent instances."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from dataclasses import replace
import gzip
import ipaddress
import secrets
import ssl
import time

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography import x509
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import pytest

from entry.app import build_app
from entry.config import Settings
from entry.store import LangfuseCredentials, LoginState, Session


class Sessions:
    def __init__(self):
        self.sessions = {}
        self.inactive_users = set()
        self.credentials = {}

    async def finish_login(self, **values):
        session = Session(secrets.token_hex(24), values['user_id'], int(time.time()) + 600)
        self.sessions[session.sid] = session
        return LoginState(session, False)

    async def get_session(self, sid):
        return self.sessions.get(sid)

    async def delete_session(self, sid):
        self.sessions.pop(sid, None)

    async def is_user_active(self, user_id):
        return user_id not in self.inactive_users

    async def ensure_langfuse_credentials(self, user_id):
        if user_id not in self.credentials:
            self.credentials[user_id] = LangfuseCredentials(
                user_id, 'pk-lf-' + secrets.token_hex(16), 'sk-lf-' + secrets.token_hex(32))
        return self.credentials[user_id]

    async def langfuse_upload_user(self, public_key, secret_key):
        for credential in self.credentials.values():
            if credential.public_key == public_key and secrets.compare_digest(credential.secret_key, secret_key):
                return credential.user_id
        return None

    async def write_audit(self, *args):
        pass


def tls(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'localhost')])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), False)
            .sign(key, hashes.SHA256()))
    cert_file, key_file = tmp_path / 'gateway.pem', tmp_path / 'gateway-key.pem'
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(cert_file, key_file)
    return server, ssl.create_default_context(cafile=str(cert_file))


@asynccontextmanager
async def relay(tmp_path):
    server_ssl, client_ssl = tls(tmp_path)
    received, mode = [], {'status': 200}
    gateway = web.Application()

    async def upload(request):
        received.append((request.headers.copy(), await request.read(), request.path))
        return web.Response(status=mode['status'], body=b'' if mode['status'] == 200 else b'private upstream diagnostics',
                            headers={'Location': '/do-not-follow'})

    gateway.router.add_post('/langfuse/api/public/otel/v1/traces', upload)
    upstream = TestServer(gateway, scheme='https')
    await upstream.start_server(ssl=server_ssl)
    settings = Settings(credential_key=Fernet.generate_key().decode(),
                        database_url='postgresql://unused@127.0.0.1:1/unused',
                        langfuse_entry_url='https://entry.example',
                        langfuse_gateway_url=str(upstream.make_url('/langfuse')))
    app = build_app(settings)
    entry = next(r.handler.__self__ for r in app.router.routes() if r.handler.__name__ == 'login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    entry.store = Sessions()

    async def warm(owner):
        pass

    entry._warm = warm
    try:
        async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=client_ssl)) as http:
            entry.http = http
            async with TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
                yield client, entry, received, mode
    finally:
        for task in entry._bg:
            await task
        entry.langfuse_routes.close()
        await upstream.close()


async def login(entry, owner, token=None):
    token = token or 'maas-' + owner
    response = await entry._finish_login(owner, '', int((time.time() + 3600) * 1000), maas_token=token)
    return {'cookies': {name: value.value for name, value in response.cookies.items()},
            'headers': {'Authorization': 'Bearer ' + token}}


async def issue(client, auth):
    response = await client.post('/hermes/__entry/langfuse/grant', **auth)
    assert response.status == 200, await response.text()
    assert response.headers['Cache-Control'] == 'no-store'
    return await response.json()


def credentials(grant):
    return aiohttp.BasicAuth(grant['public_key'], grant['secret_key'])


@pytest.mark.asyncio
async def test_entry_shares_latest_jwt_across_user_logins_without_requiring_browser_session(tmp_path):
    async with relay(tmp_path) as (client, entry, received, mode):
        a = await login(entry, 'alice')
        b = await login(entry, 'bob')
        cookie_name = entry.s.cookie_name
        sid = a['cookies'][cookie_name]
        # Successful login caches the JWT even before any tracing grant is issued.
        assert entry.langfuse_routes.authorizations['alice'].token == 'maas-alice'
        jwt_expiry = entry.langfuse_routes.authorizations['alice'].expires_at
        grants = [await issue(client, auth) for auth in (a, b)]
        assert entry.langfuse_routes.authorizations['alice'].expires_at == jwt_expiry

        async def upload(grant, expected_token):
            # No browser cookie or JWT: only the instance's existing SDK credentials.
            response = await client.post(grant['base_path'] + '/api/public/otel/v1/traces',
                auth=credentials(grant), data=b'background', headers={'Content-Type': 'application/x-protobuf'})
            assert response.status == 200, await response.text()
            assert received[-1][0]['Authorization'] == 'Bearer ' + expected_token
            assert 'Cookie' not in received[-1][0]

        for index, token in ((0, 'maas-alice'), (1, 'maas-bob'), (0, 'maas-alice')):
            await upload(grants[index], token)
        # Another login updates the user's single cache without rotating its upload key.
        other_a = await login(entry, 'alice', token='maas-alice-other-login')
        await upload(grants[0], 'maas-alice-other-login')
        await upload(grants[1], 'maas-bob')
        # A verified credential update is also shared by all this user's tasks.
        session = await entry.store.get_session(sid)
        proof, _ = entry.browser_auth.issue(session, 'maas-alice-updated', session.expires_at * 1000)
        refreshed = {'cookies': {**a['cookies'], cookie_name + '_maas': proof},
                     'headers': {'Authorization': 'Bearer maas-alice-updated'}}
        response = await client.post('/hermes/__entry/maas-auth', **refreshed)
        assert response.status == 200 and 'maas-alice-updated' not in await response.text()
        # No grant reissue or SDK credential rotation is needed for this cache update.
        await upload(grants[0], 'maas-alice-updated')
        await upload(grants[1], 'maas-bob')
        # An unbound JWT cannot poison the authorization cache.
        response = await client.post('/hermes/__entry/maas-auth', cookies=refreshed['cookies'], headers=b['headers'])
        assert response.status == 401
        await upload(grants[0], 'maas-alice-updated')
        key = 'alice'
        entry.langfuse_routes.authorizations[key] = replace(entry.langfuse_routes.authorizations[key], expires_at=1)
        before = len(received)
        response = await client.post(grants[0]['base_path'] + '/api/public/otel/v1/traces',
                                     auth=credentials(grants[0]))
        assert response.status == 401 and len(received) == before
        entry.langfuse_routes.purge()
        assert key not in entry.langfuse_routes.authorizations
        # A valid browser credential check restores a missing in-memory authorization.
        assert (await client.post('/hermes/__entry/maas-auth', **refreshed)).status == 200
        await upload(grants[0], 'maas-alice-updated')
        assert (await client.post('/hermes/__entry/logout', cookies=a['cookies'])).status == 200
        assert (await client.post('/hermes/__entry/logout', cookies=other_a['cookies'])).status == 200
        assert await entry.store.get_session(sid) is None
        # All browser sessions may be gone; 5G/cron uploads still use the valid user authorization.
        await upload(grants[0], 'maas-alice-updated')
        # Browser session expiry likewise does not invalidate the cached JWT or upload key.
        for live_sid, session in list(entry.store.sessions.items()):
            entry.store.sessions[live_sid] = replace(session, expires_at=1)
        await upload(grants[0], 'maas-alice-updated')
        entry.store.inactive_users.add('alice')
        before = len(received)
        response = await client.post(grants[0]['base_path'] + '/api/public/otel/v1/traces',
                                     auth=credentials(grants[0]))
        assert response.status == 401 and len(received) == before
        assert entry.langfuse_routes.authorizations[key].token == 'maas-alice-updated'
        await upload(grants[1], 'maas-bob')
        # Re-enabling the user reuses its existing credential and cached JWT.
        entry.store.inactive_users.remove('alice')
        await upload(grants[0], 'maas-alice-updated')
        entry.langfuse_routes.close()
        assert not entry.langfuse_routes.authorizations
        # Restarting Entry loses only JWT memory, not the persisted upload credential.
        response = await client.post(grants[0]['base_path'] + '/api/public/otel/v1/traces',
                                     auth=credentials(grants[0]))
        assert response.status == 401
        restored = await login(entry, 'alice', token='maas-alice-after-restart')
        assert await issue(client, restored) == grants[0]
        await upload(grants[0], 'maas-alice-after-restart')


@pytest.mark.asyncio
async def test_stable_credentials_bind_uploads_to_user_without_expiry_or_reissue_rotation(tmp_path):
    async with relay(tmp_path) as (client, entry, received, mode):
        a, b = await login(entry, 'alice'), await login(entry, 'bob')
        assert (await client.post('/hermes/__entry/langfuse/grant', headers=a['headers'])).status == 401
        assert (await client.post('/hermes/__entry/langfuse/grant', cookies=a['cookies'], headers=b['headers'])).status == 401
        grants = {'alice': await issue(client, a), 'bob': await issue(client, b)}
        for owner in ('alice', 'bob', 'alice'):
            grant = grants[owner]
            assert 'maas-' not in str(grant)
            stored = entry.store.credentials[owner]
            assert grant['secret_key'] not in repr(stored) and 'maas-' not in repr(stored)
            assert stored.user_id == owner
            assert 'expires_at' not in grant
            body = ('trace-' + owner).encode()
            response = await client.post(grant['base_path'] + '/api/public/otel/v1/traces',
                auth=credentials(grant), data=gzip.compress(body),
                headers={'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', 'X-User-Id': 'forged',
                         'x-langfuse-ingestion-version': '4'})
            assert response.status == 200
            headers, uploaded, path = received[-1]
            assert uploaded == body and headers['Authorization'] == 'Bearer maas-' + owner
            assert headers['x-langfuse-ingestion-version'] == '4'
            assert 'Cookie' not in headers and 'X-User-Id' not in headers and 'Content-Encoding' not in headers
            assert path == '/langfuse/api/public/otel/v1/traces'
        grant = grants['alice']
        route = grant['base_path'] + '/api/public/otel/v1/traces'
        assert (await client.post(route, **a)).status == 401
        assert (await client.post(route + '?target=https://elsewhere.invalid', auth=credentials(grant),
                                  headers={'Content-Type': 'application/x-protobuf'})).status == 400
        assert (await client.get(grant['base_path'] + '/api/public/projects', auth=credentials(grant))).status == 404
        assert (await client.get('/hermes/__entry/me', auth=credentials(grant))).status == 401
        assert (await client.post(grant['base_path'] + '/api/public/otel/v1/traces',
            auth=aiohttp.BasicAuth(grant['public_key'], grants['bob']['secret_key']))).status == 401
        renewed = await issue(client, a)
        assert renewed == grant
        mode['status'] = 302
        response = await client.post(renewed['base_path'] + '/api/public/otel/v1/traces', auth=credentials(renewed),
                                     data=b'trace', headers={'Content-Type': 'application/x-protobuf'})
        assert response.status == 502 and 'private upstream' not in await response.text()
        for upstream_status in (401, 403):
            mode['status'] = upstream_status
            response = await client.post(renewed['base_path'] + '/api/public/otel/v1/traces', auth=credentials(renewed),
                                         data=b'trace', headers={'Content-Type': 'application/x-protobuf'})
            assert response.status == upstream_status
            assert await entry.store.langfuse_upload_user(renewed['public_key'], renewed['secret_key']) == 'alice'
            assert 'private upstream' not in await response.text()
        mode['status'] = 200
        response = await client.post(renewed['base_path'] + '/api/public/otel/v1/traces', auth=credentials(renewed),
                                     data=b'recovered', headers={'Content-Type': 'application/x-protobuf'})
        assert response.status == 200
        assert received[-1][1] == b'recovered'
        entry.langfuse_routes.purge()
        assert await issue(client, a) == renewed
        renewed = await issue(client, a)
        await client.post('/hermes/__entry/logout', cookies=a['cookies'])
        response = await client.post(renewed['base_path'] + '/api/public/otel/v1/traces', auth=credentials(renewed),
                                     data=b'background-after-logout', headers={'Content-Type': 'application/x-protobuf'})
        assert response.status == 200
        assert await entry.store.langfuse_upload_user(grants['bob']['public_key'], grants['bob']['secret_key']) == 'bob'
        response = await client.delete('/hermes/__entry/langfuse/grant', **b)
        assert response.status == 405
        assert await entry.store.langfuse_upload_user(grants['bob']['public_key'], grants['bob']['secret_key']) == 'bob'
        await client.post('/hermes/__entry/logout', cookies=b['cookies'])
        assert await entry.store.langfuse_upload_user(grants['bob']['public_key'], grants['bob']['secret_key']) == 'bob'


@pytest.mark.asyncio
async def test_real_langfuse_sdk_exports_protobuf_through_entry_without_login_jwt_in_instance(tmp_path, monkeypatch):
    from langfuse import Langfuse
    from plugins.observability import langfuse as plugin
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    from opentelemetry.sdk.trace import TracerProvider

    async with relay(tmp_path) as (client, entry, received, mode):
        login_auth = await login(entry, 'alice')
        grant = await issue(client, login_auth)
        provider = TracerProvider()
        sdk = Langfuse(public_key=grant['public_key'], secret_key=grant['secret_key'],
                       base_url=str(client.make_url(grant['base_path'])),
                       tracer_provider=provider)
        monkeypatch.setattr(plugin, '_LANGFUSE_CLIENT', sdk)
        try:
            def run_hooks():
                scope = {'session_id': 'cloud-conversation', 'turn_id': 'turn-1', 'api_request_id': 'api-1'}
                plugin.on_pre_llm_request(**scope, request_messages=[{'role': 'user', 'content': 'hello'}])
                plugin.on_pre_tool_call(**scope, tool_name='terminal', tool_call_id='tc-1', args={'command': 'pwd'})
                plugin.on_post_tool_call(**scope, tool_name='terminal', tool_call_id='tc-1', result='workspace')
                plugin.on_post_llm_call(**scope, assistant_response='answer')
            await asyncio.to_thread(run_hooks)
            await asyncio.to_thread(sdk.flush)
            assert received
            spans = []
            for headers, body, _ in received:
                assert headers['Authorization'] == 'Bearer maas-alice'
                assert b'maas-alice' not in body and grant['secret_key'].encode() not in body
                request = ExportTraceServiceRequest.FromString(body)
                spans.extend(span for resource in request.resource_spans for scope in resource.scope_spans for span in scope.spans)
            by_name = {span.name: span for span in spans}
            assert by_name['Tool: terminal'].parent_span_id == by_name['Hermes turn'].span_id
            assert by_name['Tool: terminal'].trace_id == by_name['Hermes turn'].trace_id
        finally:
            await asyncio.to_thread(sdk.shutdown)
            await asyncio.to_thread(provider.shutdown)
