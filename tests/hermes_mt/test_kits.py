"""Kits reuse desktop resource staging and Entry's durable mutation protocol."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet
import pytest
import yaml

from entry.app import build_app
from entry.config import Settings
from tests.plugins.test_uniwork_kits_plugin import kits, profile_env, expert_pkg, kit_pkg, _zip_dir

REPO = Path(__file__).resolve().parents[2]


def test_staged_desktop_resources_have_a_content_fingerprint(expert_pkg, tmp_path):
    bundle = tmp_path / 'config/plugins/uniwork-bundled'
    archive = bundle / 'plugins/demo-expert.zip'
    _zip_dir(expert_pkg, archive)
    out = tmp_path / 'runtime'
    script = REPO / 'deploy/hermes-mt/scripts/build-kits.py'
    env = {**os.environ, 'UNIWORK_BUNDLED_PLUGINS': str(bundle), 'UNIWORK_BUNDLED_PLUGINS_REF': ''}
    def stage():
        result = subprocess.run([sys.executable, str(script), str(out)], env=env,
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        return (out / '.fingerprint').read_text()
    first = stage()
    assert first == stage()
    staged = out / 'plugins/uniwork-kits/bundled/uniwork-bundled/plugins/demo-expert.zip'
    assert staged.read_bytes() == archive.read_bytes()
    (expert_pkg / 'extra.md').write_text('resource update')
    _zip_dir(expert_pkg, archive)
    assert first != stage()


@pytest.mark.asyncio
async def test_kit_install_is_acknowledged_after_archive_and_retry_never_reinstalls(
        kits, profile_env, expert_pkg, tmp_path, postgres_database_url, monkeypatch):
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    bundle = tmp_path / 'bundle'
    _zip_dir(expert_pkg, bundle / 'plugins/demo-expert.zip')
    (profile_env / 'config.yaml').write_text(yaml.safe_dump({'cloud_kits': {'enabled': True},
        'uniwork_kits': {'bundled_dir': str(bundle)}}))
    monkeypatch.syspath_prepend(str(REPO / 'deploy/hermes-mt/seed'))
    import mtstate
    from entry import state_checkpoint
    counts = {'installs': 0, 'saves': 0, 'fail': True}
    async def backend_action(request):
        assert request.headers.get('X-Hermes-Session-Token') == 'instance-a'
        assert 'Cookie' not in request.headers and 'Authorization' not in request.headers
        counts['installs'] += 1
        result = await asyncio.to_thread(cloud.action, await request.json())
        return web.json_response(result)
    backend = web.Application()
    backend.router.add_post('/api/plugins/uniwork-kits/cloud/action', backend_action)
    app = build_app(Settings(database_url=postgres_database_url, credential_key=Fernet.generate_key().decode(), backend='docker'))
    entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    await entry.database.connect()
    async def checkpoint(_entry, owner, tenant):
        assert owner == 'a'
        counts['saves'] += 1
        if counts['fail']:
            raise OSError('archive unavailable')
        archive, manifest = await asyncio.to_thread(mtstate.build_archive, profile_env, tmp_path / 'snapshot', 'tenant-a', 1, '')
        import tarfile

        with tarfile.open(archive) as snapshot:
            assert 'profiles/demo-expert/config.yaml' in snapshot.getnames()
        return archive
    monkeypatch.setattr(state_checkpoint, 'checkpoint', checkpoint)
    try:
        async with TestServer(backend) as upstream, aiohttp.ClientSession() as http, TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
            entry.http = http
            tenant = SimpleNamespace(origin=f'{upstream.host}:{upstream.port}', token='instance-a', ip='', host_header='', traffic_token='', sandbox_id=None)
            async def ensure(_owner): return tenant
            entry.tenants = SimpleNamespace(ensure_running=ensure)
            auth = {}
            for owner in ('a', 'b'):
                login = await entry._finish_login(owner, '', int((time.time() + 3600) * 1000))
                auth[owner] = {'cookies': {name: value.value for name, value in login.cookies.items()}}
            url = '/agents/api/__entry/skills/'
            body = {'id': 'install-expert-a', 'method': 'POST', 'path': 'api/plugins/uniwork-kits/cloud/action',
                    'body': {'operation': 'install', 'name': 'demo-expert'}, 'profile': 'default'}
            assert (await client.post(url + 'start', json=body)).status == 401
            assert (await client.post(url + 'start', json=body, **auth['a'])).status == 200
            async def status(action='status'):
                response = await client.post(url + action, json={'id': body['id']}, **auth['a'])
                assert response.status == 200
                return await response.json()
            for _ in range(100):
                state = await status()
                if state['phase'] == 'save_failed': break
                await asyncio.sleep(.05)
            assert state['phase'] == 'save_failed', state
            assert state['result'] is None
            assert counts['installs'] == 1
            assert (await client.post(url + 'status', json={'id': body['id']}, **auth['b'])).status == 404
            counts['fail'] = False
            await status('retry-save')
            for _ in range(100):
                state = await status()
                if state['phase'] == 'saved': break
                await asyncio.sleep(.05)
            assert state['phase'] == 'saved', state
            assert state['result']['ok']
            assert counts['installs'] == 1 and counts['saves'] == 2
    finally:
        await entry.skill_routes.close()
        await entry.database.close()


@pytest.mark.asyncio
async def test_kit_toggle_is_kept_by_entry_and_replayed_over_an_older_archive(
        kits, profile_env, kit_pkg, expert_pkg, tmp_path, postgres_database_url, monkeypatch):
    """A kit toggle (and recording a recent expert) no longer waits for an instance archive: entry
    keeps the toggle and bootstrap replays it, kit first, then the skill toggles made after it."""
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    with (profile_env / 'config.yaml').open('a') as config:
        config.write('cloud_kits:\n  enabled: true\n')
    assert kits.installer.install(kit_pkg, profile_env, triggers={}).ok
    assert kits.installer.install(expert_pkg, profile_env, triggers={}).ok
    kit = kits.store.load_index(profile_env)['plugins']['demo-kit']
    assert kit['skill_names'] and kit['mcp_keys']
    monkeypatch.syspath_prepend(str(REPO / 'deploy/hermes-mt/seed'))
    import mtstate
    older, _ = mtstate.build_archive(profile_env, tmp_path / 'archive', 'tenant-a', 1, '')
    from entry import state_checkpoint
    async def checkpoint(*args): raise AssertionError('a kit toggle must not archive the instance')
    monkeypatch.setattr(state_checkpoint, 'checkpoint', checkpoint)
    async def backend_action(request):
        return web.json_response(await asyncio.to_thread(cloud.action, await request.json()))
    backend = web.Application()
    backend.router.add_post('/api/plugins/uniwork-kits/cloud/action', backend_action)
    app = build_app(Settings(database_url=postgres_database_url, credential_key=Fernet.generate_key().decode(), backend='docker'))
    entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    await entry.database.connect()
    try:
        async with TestServer(backend) as upstream, aiohttp.ClientSession() as http, TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
            entry.http = http
            tenant = SimpleNamespace(origin=f'{upstream.host}:{upstream.port}', token='instance-a', ip='', host_header='', traffic_token='', sandbox_id=None)
            async def ensure(_owner): return tenant
            entry.tenants = SimpleNamespace(ensure_running=ensure)
            login = await entry._finish_login('a', '', int((time.time() + 3600) * 1000))
            auth = {'cookies': {name: value.value for name, value in login.cookies.items()}}
            async def run(key, path, body):
                start = {'id': key, 'method': 'PUT' if path == 'api/skills/toggle' else 'POST', 'path': path, 'body': body}
                assert (await client.post('/agents/api/__entry/skills/start', json=start, **auth)).status == 200
                for _ in range(100):
                    state = await (await client.post('/agents/api/__entry/skills/status', json={'id': key}, **auth)).json()
                    if state['phase'] != 'changing' and state['phase'] != 'saving':
                        return state
                    await asyncio.sleep(.05)
            action = 'api/plugins/uniwork-kits/cloud/action'
            skill = kit['skill_names'][0]
            # A per-skill toggle made before the kit toggle is superseded by it.
            await entry.store.set_skill_enabled('a', skill, True)
            assert (await run('toggle-kit-off', action, {'operation': 'toggle', 'name': 'demo-kit', 'enabled': False}))['phase'] == 'saved'
            assert (await run('record-recent', action, {'operation': 'recent', 'name': 'demo-expert'}))['phase'] == 'saved'
            settings = await entry.store.get_profile_settings('a')
            assert settings['kits'] == {'demo-kit': False} and skill not in settings.get('skills', {})

            restored = tmp_path / 'restored'
            restored.mkdir()
            import tarfile
            with tarfile.open(older) as saved:
                saved.extractall(restored, filter='data')
            assert kits.store.load_index(restored)['plugins']['demo-kit'].get('enabled', True) is True
            mtstate.patch_config_file(restored / 'config.yaml', settings)
            replayed = kits.store.load_index(restored)['plugins']['demo-kit']
            config = yaml.safe_load((restored / 'config.yaml').read_text())
            assert replayed['enabled'] is False
            assert set(kit['skill_names']) <= set(config['skills']['disabled'])
            assert all(config['mcp_servers'][key]['enabled'] is False for key in kit['mcp_keys'])
    finally:
        await entry.skill_routes.close()
        await entry.database.close()
