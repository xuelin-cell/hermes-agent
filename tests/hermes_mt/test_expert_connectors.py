"""Real expert installs, canonical FastAPI ownership gate, one Node host and scoped MCP/OAuth."""
import asyncio
import importlib
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import pytest_asyncio
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import yaml

from tests.hermes_mt.test_connector_extended import environment as base_environment, restore
from tests.hermes_mt.test_connectors import mcp_action, port, provider_values
from tests.plugins.test_uniwork_kits_plugin import kits, _expert_pkg, _zip_dir


@pytest_asyncio.fixture
async def environment(base_environment, kits, monkeypatch):
    env = base_environment
    monkeypatch.setattr(Path, 'home', lambda: env.tmp)
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    routes = importlib.import_module('hermes_plugins.uniwork_kits.cloud_routes')
    archive_dir = env.tmp / 'archives'
    for name in ('demo-expert', 'other-expert'):
        _zip_dir(_expert_pkg(env.tmp, name=name), archive_dir / (name + '.zip'))
    for owner, manager in env.managers.items():
        config = yaml.safe_load((manager.home / 'config.yaml').read_text())
        config['cloud_kits'] = {'enabled': True}
        (manager.home / 'config.yaml').write_text(yaml.safe_dump(config))
        with monkeypatch.context() as patch:
            patch.setenv('HERMES_HOME', str(manager.home))
            with kits.store.scoped_home(manager.home):
                for name in ('demo-expert', 'other-expert'):
                    receipt = kits.installer.install(archive_dir / (name + '.zip'), manager.home, triggers=kits.installer.bundled_triggers(), generate_triggers=False)
                    assert receipt.ok, receipt.error
                    kits.expert_sync.sync_named(manager.home, name)
                    assert cloud.profile_home(manager.home, name).parent == manager.home / 'profiles'
    app = FastAPI()
    @app.middleware('http')
    async def scope(request, call_next):
        token = request.headers.get('X-Hermes-Session-Token')
        owner = next((name for name in env.managers if token == 'profile-' + name), None)
        if not owner:
            return JSONResponse({'error': 'unauthorized'}, status_code=403)
        with kits.store.scoped_home(env.managers[owner].home):
            return await call_next(request)
    app.include_router(routes.router, prefix='/api/plugins/uniwork-kits/cloud')
    backend_port = port()
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=backend_port, log_level='error', lifespan='off'))
    serving = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(.01)
    assert server.started
    for owner, manager in env.managers.items():
        manager.profile_token = 'profile-' + owner
        manager.backend_port = backend_port
    env.kits, env.cloud = kits, cloud
    try:
        yield env
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, 10)


async def action(env, owner, profile, id='aminer', name='aminer.search_paper', inputs=None, headers=None):
    scope = await env.managers[owner].scoped(profile)
    return await mcp_action(env.http, scope, id, name, inputs or {'title': 'test'}, extra_headers=headers)


@pytest.mark.asyncio
async def test_expert_credentials_tools_revocation_and_restore_are_profile_scoped(environment, monkeypatch):
    env = environment
    pids = {}
    for owner in ('alice', 'bob', 'alice'):
        manager = env.managers[owner]
        for profile, token in [('default', 'alice-academic'), ('demo-expert', 'bob-academic'), ('other-expert', 'alice-academic'), ('demo-expert', 'bob-academic')]:
            _, state = await env.call(owner, 'connect', profile=profile, id='aminer', values={'apiKey': token})
            assert next(row for row in state['connectors'] if row['id'] == 'aminer')['connected']
            assert token.split('-')[0] in json.dumps(await action(env, owner, profile))
            scope = await manager.scoped(profile)
            def dispatch():
                from tools.mcp_tool_discovery import discover_mcp_tools
                from tools.mcp_tool_schema import mcp_prefixed_tool_name
                from tools.registry import registry
                with env.kits.store.scoped_home(scope.home):
                    discover_mcp_tools(allowed_mcp_names=['connector_aminer'])
                    return registry.dispatch(mcp_prefixed_tool_name('connector_aminer', 'execute_action'),
                        {'actionId': 'aminer.search_paper', 'input': {'title': 'test'}}, session_id='expert-connectors')
            assert token.split('-')[0] in str(await asyncio.to_thread(dispatch))
            if owner in pids:
                assert manager.process.pid == pids[owner]  # No process per expert.
            pids[owner] = manager.process.pid
        scopes = [await manager.scoped(profile) for profile in ('default', 'demo-expert', 'other-expert')]
        assert len({scope.values['runtime'] for scope in scopes}) == 3
        root_config = scopes[0].saved('aminer')
        expert_config = scopes[1].saved('aminer')
        assert (await env.http.post(expert_config['url'], headers=root_config['headers'], json={})).status == 401
    for profile in ('../bob', 'missing-expert', '.hidden'):
        await env.call('alice', 'list', profile=profile, expected=400 if profile.startswith('.') else 409)
    unmanaged = env.managers['alice'].home / 'profiles/unmanaged'
    unmanaged.mkdir()
    await env.call('alice', 'list', profile='unmanaged', expected=409)
    assert not (unmanaged / 'open-connector').exists()
    alias = unmanaged.parent / 'alias'
    alias.symlink_to(env.managers['bob'].home / 'profiles/demo-expert', target_is_directory=True)
    try:
        await env.call('alice', 'list', profile='alias', expected=409)
    finally:
        alias.unlink()
    stale = (await env.managers['alice'].scoped('demo-expert')).saved('aminer')
    await env.call('alice', 'disable', profile='demo-expert', id='aminer')
    assert (await env.http.post(stale['url'], headers=stale['headers'], json={})).status == 403
    assert 'alice' in json.dumps(await action(env, 'alice', 'other-expert'))
    assert 'bob' in json.dumps(await action(env, 'bob', 'demo-expert'))
    await env.call('alice', 'enable', profile='demo-expert', id='aminer')
    await restore(env, 'alice')
    assert 'bob' in json.dumps(await action(env, 'alice', 'demo-expert'))
    with env.kits.store.scoped_home(env.managers['alice'].home):
        env.cloud.action({'operation': 'config', 'name': 'demo-expert', 'values': {'API_KEY': 'alice-only-setting'}})
    assert 'alice-only-setting' in (env.managers['alice'].home / 'profiles/demo-expert/.env').read_text()
    assert 'alice-only-setting' not in (env.managers['bob'].home / 'profiles/demo-expert/.env').read_text()
    # Expert removal uses the desktop's uninstall contract; experts have no enable toggle.
    env.platform.blocked, env.platform.release = asyncio.Event(), asyncio.Event()
    in_flight = asyncio.create_task(action(env, 'alice', 'demo-expert', inputs={'title': 'blocked'}))
    await asyncio.wait_for(env.platform.blocked.wait(), 5)
    try:
        assert env.managers['alice'].busy()
        with env.kits.store.scoped_home(env.managers['alice'].home), pytest.raises(env.kits.installer.KitError):
            env.cloud.action({'operation': 'uninstall', 'name': 'demo-expert', 'delete_profile': True})
    finally:
        env.platform.release.set()
        await in_flight
    with env.kits.store.scoped_home(env.managers['alice'].home):
        env.cloud.action({'operation': 'uninstall', 'name': 'demo-expert', 'delete_profile': True})
    assert (await env.http.post(stale['url'], headers=stale['headers'], json={})).status == 403
    assert 'bob' in json.dumps(await action(env, 'bob', 'demo-expert'))
    # The desktop installer creates profiles relative to its launch home. Emulate
    # the owning instance for this reinstall, just as in the initial fixture setup.
    with monkeypatch.context() as patch, env.kits.store.scoped_home(env.managers['alice'].home):
        patch.setenv('HERMES_HOME', str(env.managers['alice'].home))
        receipt = env.kits.installer.install(env.tmp / 'archives/demo-expert.zip', env.managers['alice'].home,
            triggers=env.kits.installer.bundled_triggers(), generate_triggers=False)
        assert receipt.ok, receipt.error
        env.kits.expert_sync.sync_named(env.managers['alice'].home, 'demo-expert')
    await env.call('alice', 'connect', profile='demo-expert', id='aminer', values={'apiKey': 'alice-academic'})
    assert 'alice' in json.dumps(await action(env, 'alice', 'demo-expert'))
    assert (await env.http.post(stale['url'], headers=stale['headers'], json={})).status == 401



@pytest.mark.asyncio
async def test_oauth_callbacks_and_signed_files_stay_with_the_initiating_expert(environment):
    env = environment
    grants = []
    for profile, label in [('demo-expert', 'alice1'), ('other-expert', 'alice2'), ('default', 'alice0')]:
        response, result = await env.call('alice', 'authorize', profile=profile, id='qcc_mcp', values={})
        params = env.platform.grant(result['authorizationUrl'], label)
        cookie = next((name, value.value) for name, value in response.cookies.items() if name.startswith('hermes_connector_oauth_'))
        grants.append((profile, label, params, cookie))
    assert len({name for _, _, _, (name, _) in grants}) == 3
    for profile, label, params, (name, ticket) in reversed(grants):
        callback = '/hermes/__entry/connectors/qcc_mcp/oauth/callback'
        response = await env.client.get(callback, params=params, cookies={**env.cookies['alice'], name: ticket})
        assert response.status == 200, await response.text()
        value = await action(env, 'alice', profile, 'qcc_mcp', 'qcc_mcp.call_tool', {'toolName': 'lookup', 'arguments': {}})
        assert label in json.dumps(value), value
    await restore(env, 'alice')
    for profile, label, _, _ in grants:
        value = await action(env, 'alice', profile, 'qcc_mcp', 'qcc_mcp.call_tool', {'toolName': 'lookup', 'arguments': {}})
        assert label in json.dumps(value), value
    for profile in ('demo-expert', 'other-expert'):
        await env.call('alice', 'connect', profile=profile, id='ima', values=provider_values('alice')['ima'])
    value = await action(env, 'alice', 'demo-expert', 'ima', 'ima.get_knowledge_item_original', {'mediaId': 'report', 'fileName': 'report.pdf'})
    url = value['data']['file']['downloadUrl']
    assert urlsplit(url).path.startswith('/profiles/demo-expert/api/files/')
    assert await (await env.http.get(url)).read() == b'%PDF-alice.pdf'
    wrong = url.replace('/profiles/demo-expert/', '/profiles/other-expert/')
    assert (await env.http.get(wrong)).status == 401
    await env.call('alice', 'disconnect', profile='demo-expert', id='qcc_mcp')
    assert 'alice2' in json.dumps(await action(env, 'alice', 'other-expert', 'qcc_mcp', 'qcc_mcp.call_tool', {'toolName': 'lookup', 'arguments': {}}))
