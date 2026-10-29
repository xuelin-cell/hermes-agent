"""Real OpenConnector SQLite/MCP, private forwarder, Entry/PG and state restoration."""
import asyncio
import importlib.util
import hashlib
import json
import shutil
import socket
import sys
import tarfile
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from urllib.parse import urlsplit, urlunsplit

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet
import yaml

from entry.app import build_app
from entry.config import Settings
from hermes_constants import set_hermes_home_override, reset_hermes_home_override

REPO = Path(__file__).resolve().parents[2]
SEED = REPO / 'deploy/hermes-mt/seed'
sys.path.insert(0, str(SEED))
import mtconnectors
import mtstate


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


async def worker(tmp_path, origin, *, actual_providers=False):
    node = shutil.which('node')
    assert node, 'Node is required for connector integration tests'
    source = tmp_path / 'fixture.ts'
    output = tmp_path / 'runtime/src/server/storage/worker.mjs'
    builder = await asyncio.create_subprocess_exec(node, str(REPO / 'apps/desktop/scripts/build-cloud-connectors.mjs'), str(tmp_path / 'runtime'), cwd=REPO)
    assert await builder.wait() == 0
    # Only the provider's HTTP transport is substituted. Validation, execution,
    # encrypted SQLite, service auth and MCP are the real implementations.
    source.write_text('''
import {startConnectors} from HOST;
import {ProviderLoader} from LOADER;
import {defineProviderExecutors,requireApiKeyCredential} from PROVIDER;
import {amapActionHandlers,validateAmapCredential} from AMAP;
const transport=(url,options)=>{const u=new URL(url);if(u.origin!=='https://restapi.amap.com')throw Error('wrong upstream');return fetch(ORIGIN+u.pathname+u.search,options)};
const executors=defineProviderExecutors({service:'amap',handlers:amapActionHandlers,
 createContext:async(context)=>({apiKey:(await requireApiKeyCredential(context,'amap')).apiKey,fetcher:transport,signal:context.signal})});
const host=await startConnectors({home:process.env.HERMES_HOME,port:Number(process.env.OOMOL_CONNECT_PORT),
 encryption:process.env.OOMOL_CONNECT_ENCRYPTION_KEY,admin:process.env.OOMOL_CONNECT_ADMIN_TOKEN,runtime:process.env.OOMOL_CONNECT_RUNTIME_TOKEN,
 providerLoader:new ProviderLoader({amap:async()=>({executors,credentialValidators:{apiKey:(input,context)=>validateAmapCredential(input,transport,context.signal)}})})});
process.once('SIGTERM',()=>void host.close().then(()=>process.exit(0)));
'''.replace('HOST', json.dumps(str(REPO / 'apps/desktop/services/open-connector/cloud/connectors.ts')))
        .replace('LOADER', json.dumps(str(REPO / 'apps/desktop/services/open-connector/src/providers/provider-loader.ts')))
        .replace('PROVIDER', json.dumps(str(REPO / 'apps/desktop/services/open-connector/src/providers/provider-runtime.ts')))
        .replace('AMAP', json.dumps(str(REPO / 'apps/desktop/services/open-connector/src/providers/amap/runtime.ts')))
        .replace('ORIGIN', json.dumps(origin)))
    if actual_providers:
        source.write_text('''
import {startConnectors} from HOST;
import dns from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
dns.lookup=async()=>[{address:'1.1.1.1',family:4}]; syncBuiltinESMExports();
const native=globalThis.fetch;
const allowed=new Set(['restapi.amap.com','open.mail.163.com','account.wps.cn','openapi.wps.cn','qyapi.weixin.qq.com','ima.qq.com']);
globalThis.fetch=(input,options)=>{const request=input instanceof Request?input:null;const url=new URL(request?.url??String(input));
 if(!allowed.has(url.hostname))throw Error('Unexpected external destination: '+url.hostname);
 const headers=new Headers(options?.headers??request?.headers);headers.set('X-Fixture-Host',url.hostname);
 const target=ORIGIN+url.pathname+url.search;
 return native(request?new Request(target,new Request(request,{...options,headers})):target,request?undefined:{...options,headers});};
const host=await startConnectors({home:process.env.HERMES_HOME,port:Number(process.env.OOMOL_CONNECT_PORT),encryption:process.env.OOMOL_CONNECT_ENCRYPTION_KEY,
admin:process.env.OOMOL_CONNECT_ADMIN_TOKEN,runtime:process.env.OOMOL_CONNECT_RUNTIME_TOKEN});
process.once('SIGTERM',()=>void host.close().then(()=>process.exit(0)));
'''.replace('HOST', json.dumps(str(REPO / 'apps/desktop/services/open-connector/cloud/connectors.ts'))).replace('ORIGIN', json.dumps(origin)))
    build = "import {build} from 'esbuild';await build({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent',banner:{js:\"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);\"}})"
    process = await asyncio.create_subprocess_exec(node, '--input-type=module', '-e', build, str(source), str(output), cwd=REPO)
    assert await process.wait() == 0
    return str(output), node


async def weather(request):
    key = request.query.get('key')
    if key not in {'alice-key', 'bob-key'}:
        return web.json_response({'status': '0', 'info': 'INVALID_USER_KEY', 'infocode': '10001'})
    return web.json_response({'status': '1', 'infocode': '10000', 'lives': [{'city': key.split('-')[0], 'weather': '晴'}]})


class ConnectorPlatform:
    """Local HTTP/SSE platform, keeping the real provider auth and protocol implementations."""
    def __init__(self):
        self.sessions = {}

    async def sse(self, request):
        key = request.headers.get('x-api-key', '')
        if key not in {'alice-note', 'bob-note'}:
            return web.Response(status=401)
        identity = uuid4().hex
        queue = asyncio.Queue()
        self.sessions[identity] = (key.split('-')[0], queue)
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        try:
            await response.write(f'event: endpoint\ndata: /api/ynote/mcp/messages?session={identity}\n\n'.encode())
            while request.transport and not request.transport.is_closing():
                try:
                    item = await asyncio.wait_for(queue.get(), 1)
                    await response.write(('event: message\ndata: ' + json.dumps(item) + '\n\n').encode())
                except asyncio.TimeoutError:
                    await response.write(b': heartbeat\n\n')
        except ConnectionResetError:
            pass
        finally:
            self.sessions.pop(identity, None)
        return response

    async def handle(self, request):
        path = request.path
        if path == '/v3/weather/weatherInfo':
            return await weather(request)
        if path == '/api/ynote/mcp/sse':
            return await self.sse(request)
        body = await request.json() if request.can_read_body else {}
        if path == '/api/ynote/mcp/messages':
            owner, queue = self.sessions[request.query['session']]
            if body.get('method') == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'youdao-fixture', 'version': '1'}}
            elif body.get('method') == 'tools/list':
                result = {'tools': [{'name': 'listNotes', 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': True}}]}
            elif body.get('method') == 'tools/call':
                result = {'content': [{'type': 'text', 'text': json.dumps({'notes': [{'title': owner}]})}]}
            else:
                return web.Response(status=202)
            await queue.put({'jsonrpc': '2.0', 'id': body['id'], 'result': result})
            return web.Response(status=202)
        if path == '/api/authorization/agent/v1/token':
            key = body.get('api_key', '')
            if key not in {'apik:alice-wps', 'apik:bob-wps'}:
                return web.json_response({'code': 401}, status=401)
            return web.json_response({'code': 0, 'data': {'access_token': key.split(':')[1].split('-')[0], 'expires_in': 3600}})
        if path == '/v7/files/search':
            owner = request.headers.get('Authorization', '').removeprefix('Bearer ')
            assert owner in {'alice', 'bob'}
            return web.json_response({'code': 0, 'data': {'items': [{'id': 'file-' + owner, 'name': owner + '-report'}]}})
        if path == '/cgi-bin/aibot/cli/get_mcp_config':
            owner = body['bot_id'].split('-')[0]
            expected = hashlib.sha256(f"{owner}-secret{body['bot_id']}{body['time']}{body['nonce']}".encode()).hexdigest()
            if owner not in {'alice', 'bob'} or body['signature'] != expected:
                return web.json_response({'errcode': 853000})
            return web.json_response({'errcode': 0, 'list': [{'biz_type': 'contact', 'url': f'https://qyapi.weixin.qq.com/mcp/contact?owner={owner}'}]})
        if path == '/mcp/contact':
            assert body['method'] == 'tools/call' and body['params']['name'] == 'get_userlist'
            return web.json_response({'jsonrpc': '2.0', 'id': body['id'], 'result': {'structuredContent': {'errcode': 0, 'users': [{'userid': request.query['owner']}]}}})
        if path.startswith('/media/'):
            return web.Response(body=('%PDF-' + path.split('/')[-1]).encode(), content_type='application/pdf')
        if path.startswith('/openapi/'):
            owner = request.headers.get('ima-openapi-clientid', '').split('-')[0]
            if owner not in {'alice', 'bob'} or request.headers.get('ima-openapi-apikey') != owner + '-ima':
                return web.json_response({'code': 401})
            data = {
                '/openapi/note/v1/list_notebook': {'note_folder_infos': [{'folder_id': owner, 'name': owner}]},
                '/openapi/wiki/v1/search_knowledge_base': {'info_list': [{'id': owner, 'name': owner + '-knowledge'}], 'is_end': True},
                '/openapi/wiki/v1/get_media_info': {'media_type': 1, 'url_info': {'url': f'https://ima.qq.com/media/{owner}.pdf'}}
            }
            return web.json_response({'code': 0, 'data': data[path]})
        raise AssertionError('Unexpected platform request: ' + path)


PROVIDER_INPUTS = {
    'youdao_note': ('youdao_note.list_notes', {'parentId': '0'}),
    'wps_mcp': ('wps_mcp.search_files', {'keyword': 'report'}),
    'wecom_bot': ('wecom_bot.get_userlist', {}),
    'ima': ('ima.search_knowledge_bases', {'query': 'knowledge'})
}


def provider_values(owner):
    return {'youdao_note': {'apiKey': owner + '-note'}, 'wps_mcp': {'apiKey': 'apik:' + owner + '-wps'},
        'wecom_bot': {'botId': owner + '-bot', 'secret': owner + '-secret'}, 'ima': {'clientId': owner + '-client', 'apiKey': owner + '-ima'}}


async def mcp_action(http, manager, id, action, inputs, *, extra_headers=None):
    config = manager.saved(id)
    response = await http.post(config['url'], headers={**config['headers'], 'Accept': 'application/json, text/event-stream', **(extra_headers or {})},
        json={'jsonrpc': '2.0', 'id': uuid4().hex, 'method': 'tools/call', 'params': {'name': 'execute_action', 'arguments': {'actionId': action, 'input': inputs}}})
    text = await response.text()
    assert response.status == 200, text
    payload = json.loads(text.split('data: ', 1)[1].split('\n', 1)[0] if text.startswith('event:') else text)['result']
    return payload.get('structuredContent') or json.loads(payload['content'][0]['text'])


def forwarder(home, manager, token, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(home))
    spec = importlib.util.spec_from_file_location('connector_forward_' + home.name, SEED / 'forward.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._connectors = manager
    module._hermes_token = token
    module._bootstrapped = True
    return module


@pytest.mark.asyncio
async def test_private_connector_host_enforces_auth_ownership_and_disable(tmp_path, monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    async def blocked_weather(request):
        if request.query.get('city') == 'blocked':
            started.set()
            await release.wait()
        return await weather(request)
    provider = web.Application()
    provider.router.add_get('/v3/weather/weatherInfo', blocked_weather)
    async with TestServer(provider) as upstream, aiohttp.ClientSession() as http:
        script, node = await worker(tmp_path, str(upstream.make_url('')).rstrip('/'))
        home = tmp_path / 'home'
        home.mkdir()
        manager = mtconnectors.Connectors(home, sys.executable, worker=script, node=node, port=port())
        module = forwarder(home, manager, 'instance-secret', monkeypatch)
        server = await asyncio.start_server(module._handle, '127.0.0.1', 0)
        origin = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}'
        try:
            for token in ('', 'wrong'):
                response = await http.post(origin + '/__mt/connectors', json={'operation': 'list'}, headers={'X-Hermes-Session-Token': token})
                assert response.status == 403
            assert manager.process is None
            assert (await manager.request({'operation': 'list'}))['connectors'][0]['configured'] is False
            base = f'http://127.0.0.1:{manager.port}'
            for route in ('/__manage', '/api/connections', '/v1/actions/amap.weather', '/mcp/amap'):
                response = await http.post(base + route, json={'operation': 'list'})
                assert response.status == 401
            with pytest.raises(ValueError):
                await manager.request({'operation': 'connect', 'id': 'amap', 'profile': 'other', 'values': {'apiKey': 'alice-key'}})
            (home / 'config.yaml').write_text('mcp_servers:\n  connector_amap:\n    url: https://user-owned.example/mcp\n')
            with pytest.raises(ValueError, match='MCP name already exists'):
                await manager.request({'operation': 'connect', 'id': 'amap', 'values': {'apiKey': 'alice-key'}})
            assert not (await manager.call('list'))['connectors'][0]['configured']
            (home / 'config.yaml').write_text('mcp_servers: {}\n')
            with pytest.raises(RuntimeError):
                await manager.request({'operation': 'connect', 'id': 'amap', 'values': {'apiKey': 'bad-key'}})
            await manager.request({'operation': 'connect', 'id': 'amap', 'values': {'apiKey': 'alice-key'}})
            config = yaml.safe_load((home / 'config.yaml').read_text())['mcp_servers']['connector_amap']
            request = asyncio.create_task(http.post(config['url'], headers={**config['headers'], 'Accept': 'application/json, text/event-stream'},
                json={'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call', 'params': {'name': 'execute_action', 'arguments': {'actionId': 'amap.weather', 'input': {'city': 'blocked'}}}}))
            try:
                await asyncio.wait_for(started.wait(), 5)
                assert manager.busy()
                from entry.tenants import busy_reason
                assert busy_reason(await module._activity(), time.time(), 300) == 'connector_running'
                from entry.tenants import TenantManager
                async def inspect(name): return {'State': {'Running': True}}
                async def ip(name, network): return '127.0.0.1'
                async def instance_token(owner): return 'instance-secret'
                tenant_manager = TenantManager(Settings(backend='docker', forward_port=server.sockets[0].getsockname()[1]),
                    SimpleNamespace(inspect_container=inspect, container_ip=ip), SimpleNamespace(ensure_tenant_token=instance_token), http)
                assert await tenant_manager._busy_reason('alice') == 'connector_running'
                module._state = SimpleNamespace(phase='ready')
                response = await http.post(origin + '/__mt/drain', headers={'X-Mt-Token': 'instance-secret'})
                assert response.status == 409
                assert module._state.phase == 'ready'
            finally:
                release.set()
                result = await request
                await result.read()
            # Restore the process without replaying the completed MCP action.
            manager.process.kill()
            await manager.process.wait()
            await manager.recover()
            assert manager.process.returncode is None
            await manager.request({'operation': 'disable', 'id': 'amap'})
            config = yaml.safe_load((home / 'config.yaml').read_text())['mcp_servers']['connector_amap']
            response = await http.post(config['url'], headers=config['headers'], json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
            assert response.status == 403
            assert (await manager.call('list'))['connectors'][0]['configured'] is True
            module._draining = True
            response = await http.post(origin + '/__mt/connectors', headers={'X-Hermes-Session-Token': 'instance-secret'}, json={'operation': 'enable', 'id': 'amap'})
            assert response.status == 403
        finally:
            server.close()
            await server.wait_closed()
            await manager.close()


@pytest.mark.asyncio
async def test_entry_connector_mcp_scopes_and_archive_restore(tmp_path, postgres_database_url, monkeypatch):
    provider = web.Application()
    platform = ConnectorPlatform()
    provider.router.add_route('*', '/{tail:.*}', platform.handle)
    async with TestServer(provider) as upstream:
        script, node = await worker(tmp_path, str(upstream.make_url('')).rstrip('/'), actual_providers=True)
        from entry import connector_contract
        monkeypatch.setattr(connector_contract, 'CONTRACT_FILE', Path(script).parents[3] / 'contract.json')
        app = build_app(Settings(database_url=postgres_database_url, credential_key=Fernet.generate_key().decode(), backend='docker'))
        entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
        app.on_startup.clear()
        app.on_cleanup.clear()
        managers, homes, listeners, tenants = {}, {}, [], {}
        for owner in ('alice', 'bob'):
            home = tmp_path / owner
            home.mkdir()
            (home / 'config.yaml').write_text('mcp_servers: {}\n')
            homes[owner] = home
            managers[owner] = mtconnectors.Connectors(home, sys.executable, worker=script, node=node, port=port())
            module = forwarder(home, managers[owner], 'instance-' + owner, monkeypatch)
            listener = await asyncio.start_server(module._handle, '127.0.0.1', 0)
            listeners.append(listener)
            tenants[owner] = SimpleNamespace(user_id=owner, token='instance-' + owner,
                origin=f'127.0.0.1:{listener.sockets[0].getsockname()[1]}', traffic_token='', host_header='', sandbox_id=None)
        async def ensure(owner): return tenants[owner]
        async def warm(owner): pass
        entry.tenants = SimpleNamespace(ensure_running=ensure)
        entry._warm = warm
        await entry.database.connect()
        try:
            async with aiohttp.ClientSession() as http, TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
                entry.http = http
                auth = {}
                for owner in ('alice', 'bob'):
                    login = await entry._finish_login(owner, '', int((time.time() + 3600) * 1000))
                    auth[owner] = {'cookies': {name: value.value for name, value in login.cookies.items()}}
                async def call(owner, operation, expected=200, **extra):
                    response = await client.post('/hermes/__entry/connectors', json={'operation': operation, 'profile': 'default', **extra}, **auth[owner])
                    result = await response.json()
                    assert response.status == expected, result
                    return result
                assert (await client.post('/hermes/__entry/connectors', json={'operation': 'list'})).status == 401
                await call('alice', 'list', expected=400, user_id='bob')
                await call('alice', 'connect', expected=400, id='eastmoney_mcp', values={'apiKey': 'alice-key'})
                for owner in ('alice', 'bob', 'alice'):
                    for id, values in {'amap': {'apiKey': owner + '-key'}, **provider_values(owner)}.items():
                        result = await call(owner, 'connect', id=id, values=values)
                        assert next(row for row in result['connectors'] if row['id'] == id)['connected'] is True
                        assert 'key' not in json.dumps(result).lower() and '127.0.0.1' not in json.dumps(result)
                        action, inputs = PROVIDER_INPUTS.get(id, ('amap.weather', {'city': '110000'}))
                        def dispatch():
                            from tools.mcp_tool_discovery import discover_mcp_tools
                            from tools.mcp_tool_schema import mcp_prefixed_tool_name
                            from tools.registry import registry
                            scope = set_hermes_home_override(homes[owner])
                            try:
                                name = 'connector_' + id
                                discover_mcp_tools(allowed_mcp_names=[name])
                                return registry.dispatch(mcp_prefixed_tool_name(name, 'execute_action'),
                                    {'actionId': action, 'input': inputs}, session_id='test-connectors')
                            finally:
                                reset_hermes_home_override(scope)
                        value = str(await asyncio.to_thread(dispatch))
                        assert owner in value, value
                for id, values in provider_values('alice').items():
                    invalid = {**values, next(reversed(values)): 'invalid'}
                    await call('alice', 'connect', expected=409, id=id, values=invalid)
                    await call('alice', 'disable', id=id)
                    status = await call('alice', 'list')
                    assert all(row['connected'] for row in status['connectors'] if row['id'] != id)
                    config = managers['alice'].saved(id)
                    response = await http.post(config['url'], headers=config['headers'], json={})
                    assert response.status == 403
                    await call('alice', 'enable', id=id)
                    action, inputs = PROVIDER_INPUTS[id]
                    assert 'alice' in json.dumps(await mcp_action(http, managers['alice'], id, action, inputs))
                forbidden = await mcp_action(http, managers['alice'], 'wps_mcp', 'ima.search_knowledge_bases', {'query': ''},
                    extra_headers={'X-OpenConnector-Allowed-Services': 'ima'})
                assert forbidden['ok'] is False
                original = await mcp_action(http, managers['alice'], 'ima', 'ima.get_knowledge_item_original', {'mediaId': 'report', 'fileName': '报告.pdf'})
                assert original['ok'] is True, original
                download = original['data']['file']['downloadUrl']
                response = await http.get(download)
                assert await response.read() == b'%PDF-alice.pdf'
                assert response.headers['Content-Security-Policy'].endswith('sandbox')
                target = urlsplit(download)
                response = await http.get(urlunsplit(target._replace(netloc=f'127.0.0.1:{managers["bob"].port}')))
                assert response.status == 401
                response = await http.get(urlunsplit(target._replace(query='e=1&s=invalid')))
                assert response.status == 401
                original_keys = (homes['alice'] / 'open-connector/secrets.json').read_bytes()
                assert b'alice-key' not in (homes['alice'] / 'open-connector/connect.sqlite').read_bytes()
                for secret in (b'alice-note', b'apik:alice-wps', b'alice-secret', b'alice-ima'):
                    assert secret not in (homes['alice'] / 'open-connector/connect.sqlite').read_bytes()
                assert original_keys != (homes['bob'] / 'open-connector/secrets.json').read_bytes()
                await call('alice', 'disable', id='amap')
                assert (await call('bob', 'list'))['connectors'][0]['connected'] is True
                archive, _ = mtstate.build_archive(homes['alice'], tmp_path / 'archive', 'sandbox', 1, '')
                restored = tmp_path / 'restored'
                restored.mkdir()
                with tarfile.open(archive) as saved:
                    assert {'open-connector/connect.sqlite', 'open-connector/secrets.json', 'config.yaml'} <= set(saved.getnames())
                    saved.extractall(restored, filter='data')
                replacement = mtconnectors.Connectors(restored, sys.executable, worker=script, node=node, port=port())
                try:
                    await replacement.restore()
                    assert replacement.process is not None  # Other enabled providers share the same service.
                    state = await replacement.request({'operation': 'list'})
                    assert state['connectors'][0] == {'id': 'amap', 'configured': True, 'connected': False, 'enabled': False}
                    await replacement.request({'operation': 'enable', 'id': 'amap'})
                    assert (restored / 'open-connector/secrets.json').read_bytes() == original_keys
                    for id, (action, inputs) in PROVIDER_INPUTS.items():
                        assert 'alice' in json.dumps(await mcp_action(http, replacement, id, action, inputs))
                    response = await http.get(urlunsplit(target._replace(netloc=f'127.0.0.1:{replacement.port}')))
                    assert await response.read() == b'%PDF-alice.pdf'
                    config = yaml.safe_load((restored / 'config.yaml').read_text())['mcp_servers']['connector_amap']
                    assert str(replacement.port) in config['url']
                    await replacement.close()
                    replacement = mtconnectors.Connectors(restored, sys.executable, worker=script, node=node, port=port())
                    await replacement.restore()
                    assert replacement.process is not None
                    config = yaml.safe_load((restored / 'config.yaml').read_text())['mcp_servers']['connector_amap']
                    assert str(replacement.port) in config['url']
                    response = await http.post(config['url'], headers={**config['headers'], 'Accept': 'application/json, text/event-stream'},
                        json={'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {'name': 'execute_action', 'arguments': {'actionId': 'amap.weather', 'input': {'city': '110000'}}}})
                    assert 'alice' in await response.text()
                    await replacement.request({'operation': 'disconnect', 'id': 'amap'})
                    assert not (await replacement.request({'operation': 'list'}))['connectors'][0]['configured']
                    for id in PROVIDER_INPUTS:
                        old = replacement.saved(id)
                        await replacement.request({'operation': 'disconnect', 'id': id})
                        status = await replacement.request({'operation': 'list'})
                        assert next(row for row in status['connectors'] if row['id'] == id)['configured'] is False
                        response = await http.post(old['url'], headers=old['headers'], json={})
                        assert response.status == 403
                finally:
                    await replacement.close()
                # A mutation that cannot be checkpointed must not be reported as saved.
                tenants['alice'].sandbox_id = 'sandbox-alice'
                async def sync(*args): raise RuntimeError('archive failed')
                entry.cube = SimpleNamespace(sync_state=sync)
                await call('alice', 'enable', expected=409, id='amap')
                tenants['alice'].sandbox_id = None
                config_before = (homes['alice'] / 'config.yaml').read_bytes()
                assert (await call('alice', 'save', id='amap'))['connectors'][0]['connected'] is True
                assert (homes['alice'] / 'config.yaml').read_bytes() == config_before
        finally:
            for listener in listeners:
                listener.close()
                await listener.wait_closed()
            for manager in managers.values():
                await manager.close()
            for task in entry._bg:
                await task
            await entry.database.close()
