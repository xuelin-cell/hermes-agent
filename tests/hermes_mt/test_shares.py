"""Cloud sharing uses real PG, instance routes, persisted provenance and HTTP gateway I/O."""
from __future__ import annotations

import hashlib
import base64
import asyncio
import os
import socket
import sys
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
from entry.share_gateway import ShareGateway
from entry.share_store import ShareStore
from entry.shares import Shares
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=')
HTML = '<!doctype html><html><head></head><body>confirmed</body></html>'


@asynccontextmanager
async def instance_processes(homes):
    # Separate processes exercise the actual launch-home resolver, as production instances do.
    processes, ports = [], {}
    script = """
import sys, asyncio
from fastapi import FastAPI, Request
from plugins.conversation_share.dashboard.plugin_api import router
from hermes_cli.web_routers.files import router as files_router
from tools.execution_metadata import execution_scope
from tui_gateway import server
import uvicorn
app = FastAPI()
app.include_router(router, prefix='/api/plugins/conversation-share')
app.include_router(files_router)
server._sessions['runtime'] = {'profile_name': 'default', 'session_key': 'chat'}
@app.middleware('http')
async def credentials(request, next):
    assert request.headers.get('Authorization') is None
    return await next(request)
@app.post('/test/publish')
async def publish(request: Request):
    data = await request.json()
    def run():
        import json
        import hermes_cli.plugins as plugins
        from hermes_cli.lifecycle import invoke_hook
        from hermes_constants import get_hermes_home
        from tools.terminal_tool import record_session_cwd
        from tools.registry import registry
        plugins.discover_plugins(force=True)
        tool = registry.get_entry('publish_artifact')
        assert tool and tool.toolset == 'desktop_ui'
        workspace = get_hermes_home() / 'workspace'
        record_session_cwd('task', str(workspace))
        invoke_hook('pre_llm_call', session_id='chat', platform='desktop', is_first_turn=True)
        file = workspace / 'report.md'
        file.write_text('# 你好\\n正式分享')
        invoke_hook('post_tool_call', tool_name='write_file', session_id='chat', task_id='task', status='ok',
            args={'path': str(file), 'content': file.read_text()}, result={'resolved_path': str(file)})
        if data.get('uploaded'):
            from plugins.conversation_share.origins import current
            current().mark_uploaded('chat')
        with execution_scope({'cloud_share': data.get('grant', '')}, 'runtime'):
            result = registry.dispatch('publish_artifact', {'path': str(file)}, task_id='task', session_id='chat')
        return json.loads(result) if isinstance(result, str) else result
    return await asyncio.to_thread(run)
@app.get('/health')
def health(): return {'ok': True}
uvicorn.run(app, fd=int(sys.argv[1]), log_level='error')
"""
    try:
        for user, home in homes.items():
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            ports[user] = listener.getsockname()[1]
            env = {**os.environ, 'HERMES_HOME': str(home)}
            process = await asyncio.create_subprocess_exec(sys.executable, '-c', script, str(listener.fileno()),
                env=env, pass_fds=(listener.fileno(),), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            processes.append(process)
            listener.close()
            async with aiohttp.ClientSession() as http:
                for _ in range(200):
                    if process.returncode is not None:
                        raise AssertionError((await process.stderr.read()).decode())
                    try:
                        async with http.get(f'http://127.0.0.1:{ports[user]}/health') as response:
                            if response.status == 200:
                                break
                    except aiohttp.ClientError:
                        pass
                    await asyncio.sleep(.1)
                else:
                    raise AssertionError('Instance startup timed out')
        yield ports
    finally:
        for process in processes:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


@asynccontextmanager
async def stack(tmp_path, database_url):
    homes = {}
    for user in ('alice', 'bob'):
        home = tmp_path / user
        home.mkdir()
        workspace = home / 'workspace'
        workspace.mkdir()
        (home / 'config.yaml').write_text(f'cloud_sharing:\n  enabled: true\nterminal:\n  backend: local\n  cwd: {workspace}\n')
        db = SessionDB(home / 'state.db')
        db.create_session('chat', source='desktop', cwd=str(workspace))
        db.append_message('chat', 'user', 'question')
        image = workspace / 'plot.png'
        image.write_bytes(PNG)
        db.append_message('chat', 'assistant', f'answer {user} ![plot]({image})')
        db.close()
        homes[user] = home
    gateway = web.Application()
    received, objects = [], {}
    failures = {'put': 0, 'delete': 0}
    async def upload(request):
        payload = await request.read()
        received.append((request.method, request.match_info['id'], request.headers['Authorization'], payload))
        objects[request.match_info['id']] = payload
        if failures['put']:
            failures['put'] -= 1
            return web.Response(status=503)  # Object exists, but the acknowledgement was lost.
        return web.json_response({'shareId': request.match_info['id'], 'url': f'https://share.test/{request.match_info["id"]}'})
    async def delete(request):
        received.append((request.method, request.match_info['id'], request.headers['Authorization'], b''))
        if failures['delete']:
            failures['delete'] -= 1
            return web.Response(status=503)
        objects.pop(request.match_info['id'], None)
        return web.Response(status=204)
    gateway.router.add_put('/{id}.html', upload)
    gateway.router.add_delete('/{id}.html', delete)
    async with instance_processes(homes) as ports, TestServer(gateway) as gateway_server:
        app = build_app(Settings(database_url=database_url, credential_key=Fernet.generate_key().decode()))
        entry = next(r.handler.__self__ for r in app.router.routes() if r.handler.__name__ == 'login')
        app.on_startup.clear()
        app.on_cleanup.clear()
        await entry.database.connect()
        async with aiohttp.ClientSession() as http:
            entry.http = http
            async def ensure(user):
                return SimpleNamespace(user_id=user, token='instance-' + user, traffic_token='', host_header='',
                    origin=f'127.0.0.1:{ports[user]}')
            entry.tenants = SimpleNamespace(ensure_running=ensure)
            async def warm(user):
                return None
            entry._warm = warm
            gateway_client = ShareGateway(http, str(gateway_server.make_url('')).rstrip('/'))
            def reset():
                entry.shares = Shares(ShareStore(entry.database), gateway_client, entry.share_routes.instance, entry.share_routes.authorize)
            reset()
            async with TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
                credentials = {}
                for user in homes:
                    response = await entry._finish_login(user, '', int(__import__('time').time() * 1000) + 3600000, maas_token='maas-' + user)
                    credentials[user] = {name: cookie.value for name, cookie in response.cookies.items()}
                async def call(user, kind, operation, data, expected=200):
                    response = await client.post(f'/hermes/__entry/{kind}-shares/{operation}', json=data,
                        cookies=credentials[user], headers={'Authorization': 'Bearer maas-' + user})
                    result = await response.json()
                    assert response.status == expected, result
                    return result
                try:
                    yield SimpleNamespace(call=call, reset=reset, homes=homes, received=received,
                        failures=failures, objects=objects, entry=entry, credentials=credentials, client=client, ports=ports, http=http)
                finally:
                    await entry.share_routes.agent.close()
                    for task in entry._bg:
                        await task
                    await entry.database.close()


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
async def test_agent_publishes_through_entry_with_turn_and_login_bound_authority(tmp_path, postgres_database_url):
    async with stack(tmp_path, postgres_database_url) as env:
        async def tool(owner, **data):
            async with env.http.post(f'http://127.0.0.1:{env.ports[owner]}/test/publish', json=data) as response:
                assert response.status == 200, await response.text()
                return await response.json()

        assert 'error' in await tool('alice')
        assert not env.received
        grant = (await env.call('alice', 'artifact', 'grant', {'sessionId': 'runtime'}))['cloud_share']
        assert 'error' in await tool('bob', grant=grant)
        result = await tool('alice', grant=grant)
        assert result['url'] == f'https://share.test/{result["share_id"]}'
        assert result['expires_at'] and result['version'] == 1
        assert env.received[-1][2] == 'Bearer maas-alice'
        assert '你好'.encode() in env.received[-1][3]
        records = await env.call('alice', 'artifact', 'inspect', {'query': {'shareId': result['share_id']}})
        assert records['url'] == result['url']
        count = len(env.received)
        assert 'error' in await tool('alice', grant=grant)  # A completed turn cannot lend its authority.
        assert len(env.received) == count
        revoked = (await env.call('alice', 'artifact', 'grant', {'sessionId': 'runtime'}))['cloud_share']
        blocked = await env.client.post('/hermes/api/plugins/conversation-share/internal/grant',
            json={}, cookies=env.credentials['alice'])
        assert blocked.status == 404
        await env.client.post('/hermes/__entry/logout', cookies=env.credentials['alice'])
        assert 'error' in await tool('alice', grant=revoked)
        bob = (await env.call('bob', 'artifact', 'grant', {'sessionId': 'runtime'}))['cloud_share']
        assert 'error' in await tool('bob', grant=bob, uploaded=True)
        assert len(env.received) == count


@pytest.mark.asyncio
async def test_conversation_shares_recover_pending_uploads_and_isolate_owners(tmp_path, postgres_database_url):
    async with stack(tmp_path, postgres_database_url) as env:
        request = {'sessionId': 'chat', 'scope': 'session', 'locale': 'zh', 'theme': 'light'}
        prepared = await env.call('alice', 'conversation', 'prepare', {'request': request})
        assert 'alice' in str(prepared['document'])
        image = prepared['document']['assets'][0]
        image_url = await env.call('alice', 'conversation', 'image', {'ticket': prepared['ticket'], 'reference': image['reference']})
        assert base64.b64decode(image_url.split(',', 1)[1]) == PNG
        await env.call('alice', 'conversation', 'image', {'ticket': prepared['ticket'], 'reference': '/not-in-snapshot'}, 409)
        env.failures['put'] = 1
        await env.call('alice', 'conversation', 'publish', {'ticket': prepared['ticket'], 'html': HTML}, 502)
        first = env.received[-1]
        env.reset()  # New Entry service instance, same persisted PG state.
        prepared = await env.call('alice', 'conversation', 'prepare', {'request': request})
        published = await env.call('alice', 'conversation', 'publish', {'ticket': prepared['ticket'], 'html': HTML.replace('confirmed', 'different')})
        assert env.received[-1][1:] == first[1:]  # ID and exact original bytes survive retries.
        assert b"script-src 'none'" in first[3]
        await env.call('bob', 'conversation', 'publish', {'ticket': prepared['ticket'], 'html': HTML}, 409)
        assert await env.call('bob', 'conversation', 'list', {'sessionId': 'chat'}) == []
        await env.call('bob', 'conversation', 'revoke', {'key': published['key']})
        assert published['shareId'] in env.objects
        env.failures['delete'] = 1
        await env.call('alice', 'conversation', 'revoke', {'key': published['key']}, 502)
        assert (await env.call('alice', 'conversation', 'list', {'sessionId': 'chat'}))[0]['state'] == 'published'
        await env.call('alice', 'conversation', 'revoke', {'key': published['key']})
        assert published['shareId'] not in env.objects
        prepared = await env.call('alice', 'conversation', 'prepare', {'request': request})
        db = SessionDB(env.homes['alice'] / 'state.db')
        db.append_message('chat', 'user', 'changed')
        db.append_message('chat', 'assistant', 'new reply')
        db.close()
        await env.call('alice', 'conversation', 'publish', {'ticket': prepared['ticket'], 'html': HTML}, 409)
        await env.call('alice', 'conversation', 'cancel', {'ticket': prepared['ticket']})
        await env.call('alice', 'conversation', 'publish', {'ticket': prepared['ticket'], 'html': HTML}, 409)
        assert all(request[2] == 'Bearer maas-alice' for request in env.received)


@pytest.mark.asyncio
async def test_artifact_shares_use_real_hooks_files_and_persistent_upload_restrictions(tmp_path, postgres_database_url):
    import hermes_cli.plugins as plugins
    from hermes_cli.lifecycle import invoke_hook
    from tools.terminal_tool import record_session_cwd
    async with stack(tmp_path, postgres_database_url) as env:
        sources = {}
        for owner in ('alice', 'bob', 'alice'):
            home = env.homes[owner]
            context = set_hermes_home_override(home)
            try:
                plugins.discover_plugins(force=True)
                record_session_cwd('task', str(home / 'workspace'))
                invoke_hook('pre_llm_call', session_id='chat', platform='desktop', is_first_turn=True)
                file = home / 'workspace/report.html'
                file.write_text(HTML)
                invoke_hook('post_tool_call', tool_name='write_file', session_id='chat', task_id='task', status='ok',
                    args={'path': str(file), 'content': HTML}, result={'resolved_path': str(file)})
                sources[owner] = {'sessionId': 'chat', 'path': str(file), 'hash': hashlib.sha256(file.read_bytes()).hexdigest()}
            finally:
                reset_hermes_home_override(context)
        source = sources['alice']
        revision_before = (await env.call('alice', 'artifact', 'revision', {}))['revision']
        eligibility = await env.call('alice', 'artifact', 'eligibility', {'source': source})
        assert eligibility['publishable'], eligibility
        assert not (await env.call('bob', 'artifact', 'eligibility', {'source': source}))['publishable']
        data = {'key': 'file:chat:report', 'source': source, 'html': HTML, 'title': 'report'}
        env.failures['put'] = 1
        await env.call('alice', 'artifact', 'publish', data, 502)
        first = env.received[-1]
        env.reset()
        record = await env.call('alice', 'artifact', 'publish', data)
        assert env.received[-1][1:] == first[1:]
        assert record['sourceHash'] == source['hash']
        assert await env.call('bob', 'artifact', 'inspect', {'query': data['key']}) is None
        assert (await env.call('alice', 'artifact', 'inspect', {'query': data['key']}))['shareId'] == record['shareId']
        updated = await env.call('alice', 'artifact', 'expiration', {'key': data['key'], 'shareId': record['shareId'], 'ttlDays': 7})
        assert updated['expiresAt'] > record['expiresAt']
        await env.call('alice', 'artifact', 'revoke', {'key': data['key'], 'shareId': 'stale'}, 409)
        env.failures['delete'] = 1
        await env.call('alice', 'artifact', 'revoke', {'key': data['key'], 'shareId': record['shareId']}, 502)
        assert not (await env.call('alice', 'artifact', 'inspect', {'query': data['key']})).get('deletedAt')
        await env.call('alice', 'artifact', 'revoke', {'key': data['key'], 'shareId': record['shareId']})
        assert record['shareId'] not in env.objects
        # Expired, uncertain uploads are deleted before a new lifetime can create a fresh object.
        expiring = {**data, 'key': 'expired-pending'}
        env.failures['put'] = 1
        await env.call('alice', 'artifact', 'publish', expiring, 502)
        old_id = env.received[-1][1]
        async with env.entry.shares.store.locked('alice', 'artifact', expiring['key']) as slot:
            _, pending, frozen = await slot.load()
            pending['expiresAt'] = '2000-01-01T00:00:00.000Z'
            await slot.prepare(pending, frozen)
        env.reset()
        renewed = await env.call('alice', 'artifact', 'publish', expiring)
        assert renewed['shareId'] != old_id and old_id not in env.objects
        async with env.entry.shares.store.locked('alice', 'artifact', expiring['key']) as slot:
            current, _, _ = await slot.load()
            await slot.save({**current, 'expiresAt': '2000-01-01T00:00:00.000Z'})
        env.failures['delete'] = 1
        assert not (await env.call('alice', 'artifact', 'inspect', {'query': expiring['key']})).get('deletedAt')
        assert (await env.call('alice', 'artifact', 'inspect', {'query': expiring['key']}))['deletedAt']
        assert renewed['shareId'] not in env.objects
        # Markdown uses the same verified source bytes with a separately rendered HTML snapshot.
        context = set_hermes_home_override(env.homes['alice'])
        markdown = env.homes['alice'] / 'workspace/report.md'
        try:
            markdown.write_text('# confirmed')
            invoke_hook('post_tool_call', tool_name='write_file', session_id='chat', task_id='task', status='ok',
                args={'path': str(markdown), 'content': '# confirmed'}, result={'resolved_path': str(markdown)})
        finally:
            reset_hermes_home_override(context)
        markdown_source = {'sessionId': 'chat', 'path': str(markdown), 'hash': hashlib.sha256(markdown.read_bytes()).hexdigest()}
        markdown_record = await env.call('alice', 'artifact', 'publish', {
            'key': 'markdown', 'title': 'report.md', 'html': HTML, 'source': markdown_source})
        assert markdown_record['sourceHash'] == markdown_source['hash']
        Path(source['path']).write_text(HTML + 'changed')
        assert not (await env.call('alice', 'artifact', 'eligibility', {'source': source}))['publishable']
        await env.call('alice', 'artifact', 'mark-uploaded', {'sessionId': 'chat'})
        context = set_hermes_home_override(env.homes['alice'])
        try:
            invoke_hook('pre_llm_call', session_id='child', parent_session_id='chat', platform='desktop', is_first_turn=True)
            invoke_hook('post_llm_call', session_id='child', platform='desktop', assistant_response='```html\n<html>child</html>\n```')
        finally:
            reset_hermes_home_override(context)
        inherited = await env.call('alice', 'artifact', 'eligibility', {'source': {'sessionId': 'child', 'content': '<html>child</html>'}})
        assert inherited == {'publishable': False, 'reason': 'user_upload'}
        assert (await env.call('alice', 'artifact', 'revision', {}))['revision'] > revision_before
        await env.call('alice', 'artifact', 'publish', data, 409)
