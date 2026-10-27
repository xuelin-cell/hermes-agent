"""Real PG, Node protocol worker and HTTP instance boundaries for browser and agent drive access."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import socket
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.config import Settings
from entry.drive_worker import DriveWorker

ROOT = Path(__file__).resolve().parents[2]
CONTENT = b'cloud-file-content\n'


@asynccontextmanager
async def upstream():
    calls, uploads, counts = [], [], {}
    async def handle(request):
        if request.path == '/auth':
            data = await request.json()
            assert set(data) == {'phone', 'appVersion'}
            assert 'Authorization' not in request.headers
            phone = data['phone']
            counts[phone] = counts.get(phone, 0) + 1
            return web.json_response({'meta': {'code': '0'}, 'result': {'accessToken': 'drive-' + phone}})
        token = request.headers.get('Authorization', '')
        assert token.startswith('Bearer login-')
        phone = token.removeprefix('Bearer login-')
        assert request.headers['X-Drive-Access-Token'] == 'drive-' + phone
        calls.append((phone, request.path))
        value = {}
        if request.path == '/assets':
            value = {'items': [] if request.query.get('page_no') == '2' else [
                {'asset_id': phone, 'name': 'report.txt', 'kind': 'file', 'parent_asset_id': '0', 'size_bytes': len(CONTENT)}]}
        elif request.path.endswith('/usage'):
            value = {'used_bytes': 12, 'total_bytes': 1000}
        elif request.path == '/drive/capabilities':
            value = {'upload': True, 'download': True, 'max_upload_bytes': 1024 * 1024}
        elif request.path == '/unicom/FileDetails':
            value = {'fid': 'file-id', 'name': 'report.txt'}
        elif request.path == '/assets/download':
            value = {'download_path': '/drive/content?fid=file-id'}
        elif request.path == '/drive/content':
            return web.Response(body=CONTENT)
        elif request.path == '/drive/upload-part':
            uploads.append((phone, json.loads(base64.b64decode(request.headers['X-Drive-Upload-Metadata'])), await request.read()))
            return web.json_response({'ok': True, 'status': 'succeeded', 'data': {}})
        return web.json_response({'ok': True, 'status': 'succeeded', 'data': value})
    app = web.Application()
    app.router.add_route('*', '/{tail:.*}', handle)
    async with TestServer(app) as server:
        yield str(server.make_url('')).rstrip('/'), calls, uploads, counts


@asynccontextmanager
async def entry_client(tmp_path, database_url, upstream_url, instances=None):
    script = tmp_path / 'worker.mjs'
    script.write_text('import { startDriveWorker } from ' + json.dumps((ROOT / 'deploy/hermes-mt/entry/entry/static/cloud-drive-worker.mjs').as_uri()) + ';\n' +
        'startDriveWorker((url, options) => { const u = new URL(url); const p = u.pathname.includes("/clouddrive/v1") ? u.pathname.split("/clouddrive/v1")[1] + u.search : "/auth"; return fetch(' + json.dumps(upstream_url) + ' + p, options); });')
    app = build_app(Settings(database_url=database_url, credential_key=Fernet.generate_key().decode()))
    entry = next(r.handler.__self__ for r in app.router.routes() if r.handler.__name__ == 'login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    await entry.database.connect()
    entry.drive_routes.worker.scratch.cleanup()
    entry.drive_routes.worker = DriveWorker(script, node=shutil.which('node'))
    async def warm(user):
        return None
    entry._warm = warm
    async def test_login(request):
        phone = (await request.json())['phone']
        return await entry._finish_login(phone, '', int(time.time() * 1000) + 600_000,
                                        phone=phone, maas_token='login-' + phone)
    app.router.add_post('/test-login', test_login)
    if instances:
        async def ensure(user):
            return SimpleNamespace(ip='127.0.0.1', origin=f'127.0.0.1:{instances[user]}', host_header='', traffic_token='', token='instance-token')
        entry.tenants = SimpleNamespace(ensure_running=ensure)
    async with aiohttp.ClientSession() as http:
        entry.http = http
        async with TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
            async def login(phone):
                response = await client.post('/test-login', json={'phone': phone})
                body = await response.json()
                return {'cookies': {key: val.value for key, val in response.cookies.items()},
                        'headers': {'Authorization': 'Bearer ' + body['maas_auth']['token']}}
            async def call(auth, action, body):
                response = await client.post('/hermes/__entry/drive/' + action, json=body, **auth)
                assert response.status == 200, await response.text()
                return await response.json()
            async def result(auth, key):
                for _ in range(500):
                    value = await call(auth, 'status', {'id': key})
                    if value['done']:
                        return value['result']
                    await asyncio.sleep(.02)
                raise AssertionError('Drive operation did not finish')
            try:
                yield client, entry, login, call, result
            finally:
                await entry.drive_routes.close()
                await entry.database.close()


@pytest.mark.asyncio
async def test_browser_drive_keeps_accounts_and_bytes_isolated_with_real_worker_and_pg(tmp_path, postgres_database_url):
    async with upstream() as (url, calls, uploads, counts):
        async with entry_client(tmp_path, postgres_database_url, url) as (client, entry, login, call, result):
            a, b = await login('13811111111'), await login('13822222222')
            for auth, phone in [(a, '13811111111'), (b, '13822222222'), (a, '13811111111')]:
                operation = await call(auth, 'request', {'request': {'route': '/assets?space_id=personal&parent_asset_id=0'}})
                assert (await result(auth, operation['id']))['items'][0]['asset_id'] == phone
            assert counts == {'13811111111': 1, '13822222222': 1}
            mixed = {**a, 'headers': b['headers']}
            response = await client.post('/hermes/__entry/drive/ready', json={}, **mixed)
            assert response.status == 401
            await call(a, 'upload-start', {'id': 'upload-one', 'name': '资料.txt', 'size': len(CONTENT)})
            response = await client.post('/hermes/__entry/drive/part/upload-one?offset=0', data=CONTENT, **a)
            assert response.status == 200
            # Replayed or foreign chunks cannot change the original upload.
            assert (await client.post('/hermes/__entry/drive/part/upload-one?offset=0', data=CONTENT, **a)).status == 409
            assert (await client.post('/hermes/__entry/drive/part/upload-one?offset=18', data=b'x', **b)).status == 404
            await call(a, 'upload-finish', {'id': 'upload-one', 'parentAssetId': '0'})
            upload_result = await result(a, 'upload-one')
            assert upload_result['status'] == 'succeeded', upload_result
            assert len(uploads) == 1 and uploads[0][2] == CONTENT and uploads[0][1]['fileName'] == '资料.txt'
            assert (await client.post('/hermes/__entry/drive/upload-start', json={'id': 'upload-one', 'name': '资料.txt', 'size': len(CONTENT)}, **a)).status == 409
            # The same caller-chosen ID in another account cannot overwrite A's durable receipt.
            await call(b, 'upload-start', {'id': 'upload-one', 'name': 'other.txt', 'size': 0})
            await call(b, 'upload-finish', {'id': 'upload-one', 'parentAssetId': '0'})
            assert (await result(b, 'upload-one'))['name'] == 'other.txt'
            assert (await call(a, 'status', {'id': 'upload-one'}))['result']['name'] == '资料.txt'
            operation = await call(a, 'transfer', {'id': 'download-one', 'request': {
                'operation': 'download', 'assetId': 'asset', 'name': '资料.txt', 'size': len(CONTENT)}})
            assert (await result(a, operation['id']))['readyForBrowser']
            assert (await client.get('/hermes/__entry/drive/files/download-one', **b)).status == 404
            response = await client.get('/hermes/__entry/drive/files/download-one', **a)
            assert response.status == 200 and await response.read() == CONTENT
            assert (await client.get('/hermes/__entry/drive/files/download-one', **a)).status == 404
            async with entry.database.acquire() as connection:
                receipts = await connection.fetch('SELECT result::text FROM cloud_drive_operations')
            assert receipts and all('login-' not in row['result'] and 'drive-138' not in row['result'] for row in receipts)
            response = await client.post('/hermes/__entry/logout', **a)
            assert response.status == 200
            assert (await client.post('/hermes/__entry/drive/status', json={'id': 'download-one'}, **a)).status == 401


@asynccontextmanager
async def instance(tmp_path):
    home = tmp_path / 'instance'
    workspace = home / 'workspace'
    workspace.mkdir(parents=True)
    (workspace / 'generated.txt').write_bytes(CONTENT)
    (home / 'config.yaml').write_text('cloud_drive: {enabled: true}\nterminal:\n  cwd: ' + str(workspace) + '\nmcp_servers:\n  UniWork-Drive:\n    uniwork_managed: uniwork.desktop.drive.v1\n    enabled: true\n')
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    config_file = home / 'config.yaml'
    config_file.write_text(config_file.read_text().replace('    enabled: true\n',
        '    enabled: true\n    url: http://127.0.0.1:' + str(port) + '/api/plugins/cloud-drive/mcp\n'
        '    execution_metadata: true\n    strict_redirect_headers: true\n    headers:\n'
        '      X-Hermes-Session-Token: "${HERMES_DASHBOARD_SESSION_TOKEN}"\n      X-Hermes-Context-Probe: "1"\n'))
    script = '''
import asyncio, sys
from fastapi import FastAPI
from plugins.cloud_drive.dashboard.plugin_api import router
from tools.execution_metadata import execution_scope
from tui_gateway import server
import uvicorn
app = FastAPI()
app.include_router(router, prefix='/api/plugins/cloud-drive')
@app.middleware('http')
async def isolate(request, next):
    assert request.headers.get('Authorization') is None
    if request.headers.get('X-Hermes-Context-Probe'):
        assert request.headers['X-Hermes-Session-Token'] == 'instance-token'
    return await next(request)
server._sessions['runtime'] = {'profile_name': 'default'}
tasks = {}
@app.post('/test/start/{grant}')
async def start(grant: str):
    event = asyncio.Event()
    async def run():
        with execution_scope({'cloud_drive': grant}, 'runtime'):
            await event.wait()
    tasks[grant] = (asyncio.create_task(run()), event)
    await asyncio.sleep(0)
    return {'ok': True}
@app.post('/test/end/{grant}')
async def end(grant: str):
    task, event = tasks.pop(grant)
    event.set()
    await task
    return {'ok': True}
@app.post('/test/registry/{grant}')
async def registry_call(grant: str):
    def run():
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.mcp_tool_schema import mcp_prefixed_tool_name
        from tools.registry import registry
        with execution_scope({'cloud_drive': grant}, 'runtime'):
            discover_mcp_tools(allowed_mcp_names=['UniWork-Drive'])
            return registry.dispatch(mcp_prefixed_tool_name('UniWork-Drive', 'list_files'), {}, session_id='runtime')
    return {'value': await asyncio.to_thread(run)}
@app.get('/health')
async def health(): return {'ok': True}
uvicorn.run(app, fd=int(sys.argv[1]), log_level='error')
'''
    process = await asyncio.create_subprocess_exec(sys.executable, '-c', script, str(listener.fileno()), str(port),
        env={**os.environ, 'HERMES_HOME': str(home), 'HERMES_DASHBOARD_SESSION_TOKEN': 'instance-token'}, pass_fds=(listener.fileno(),),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    listener.close()
    async with aiohttp.ClientSession() as http:
        try:
            for _ in range(300):
                if process.returncode is not None:
                    raise AssertionError((await process.stderr.read()).decode())
                try:
                    async with http.get(f'http://127.0.0.1:{port}/health') as response:
                        if response.status == 200:
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(.05)
            else:
                raise AssertionError('Instance failed to start')
            yield port, home, workspace, http
        finally:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
            print((await process.stderr.read()).decode()[-8000:])


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
async def test_agent_mcp_uses_live_execution_scope_and_instance_files_not_account_tokens(tmp_path, postgres_database_url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from tools.mcp_tool_handlers import _call_tool_racing_stdio_death
    async with instance(tmp_path) as (port, home, workspace, http), upstream() as (url, calls, uploads, counts):
        async with entry_client(tmp_path, postgres_database_url, url, {'13811111111': port}) as (client, entry, login, call, result):
            auth = await login('13811111111')
            grant = (await call(auth, 'grant', {'sessionId': 'runtime'}))['cloud_drive']
            await http.post(f'http://127.0.0.1:{port}/test/start/{grant}')
            async with streamable_http_client(f'http://127.0.0.1:{port}/api/plugins/cloud-drive/mcp') as (read, write, *_):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert any(tool.name == 'download' for tool in tools.tools)
                    task = SimpleNamespace(session=session, _config={'execution_metadata': True})
                    async def invoke(name, args):
                        reply = await _call_tool_racing_stdio_death(task, 'UniWork-Drive', name, args, {'cloud_drive': grant})
                        return json.loads(reply.content[0].text)
                    value = await invoke('list_files', {})
                    assert value['items'][0]['asset_id'] == '13811111111'
                    async with http.post(f'http://127.0.0.1:{port}/test/registry/{grant}') as response:
                        registered = await response.json()
                    assert '13811111111' in registered['value'] and 'login-' not in registered['value']
                    downloaded = await invoke('download', {'asset_id': 'asset'})
                    assert downloaded['ok'] and Path(downloaded['path']).is_relative_to(workspace)
                    assert Path(downloaded['path']).read_bytes() == CONTENT
                    preview = await call(auth, 'transfer', {'request': {'operation': 'preview', 'assetId': 'asset', 'name': 'report.txt'}})
                    previewed = await result(auth, preview['id'])
                    assert previewed['status'] == 'succeeded' and Path(previewed['preview']['path']).read_bytes() == CONTENT
                    assert not list(entry.drive_routes.worker.root.glob('*/previews/preview-*'))
                    uploaded = await invoke('upload', {'source_path': 'generated.txt'})
                    assert uploaded['status'] == 'succeeded' and uploads[-1][2] == CONTENT
                    before = len(uploads)
                    denied = await invoke('upload', {'source_path': '../config.yaml'})
                    assert denied.get('ok') is False and len(uploads) == before
                    (home / 'config.yaml').write_text((home / 'config.yaml').read_text().replace('enabled: true\n', 'enabled: false\n', 1).replace('cloud_drive: {enabled: false}', 'cloud_drive: {enabled: true}'))
                    count = len(calls)
                    assert (await invoke('get_capacity', {}))['code'] == 'DRIVE_ACCESS_DISABLED'
                    assert len(calls) == count
                    await http.post(f'http://127.0.0.1:{port}/test/end/{grant}')
