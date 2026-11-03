"""Drain rollback exercises the real Cube HTTP client and persistent tenant runtime."""
import asyncio
import sys
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from entry.cube_api import Cube, CubeError, SandboxGone
from entry.tenants import TenantManager
from tests.hermes_mt.test_messaging_media import context
from tests.hermes_mt.test_forward_seed import forward


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['delete', 'archive', 'paused', 'paused_platform'])
async def test_failed_retirement_resumes_same_owner_and_retries_after_entry_restart(postgres_database_url, failure):
    settings, app, entry, binding, epoch, delivery = await context(postgres_database_url, 'uniagentgate')
    token = await entry.store.ensure_tenant_token('alice')
    await entry.store.record_sandbox('alice', 'old', 'tpl-old', epoch)
    await entry.store.set_state_owner('alice', 'old', '', {})
    state = {'phase': 'ready', 'hermes': True, 'resume_fails': False}
    calls = []

    async def endpoint(request):
        calls.append((request.method, request.path))
        if request.path == '/sandboxes/old/resume':
            if state.get('platform_resume_fails'):
                raise web.HTTPGatewayTimeout()
            state['sandbox_state'] = 'running'
            return web.json_response({'ok': True})
        if request.path == '/__mt/health':
            if state.get('sandbox_state') == 'paused':
                raise web.HTTPServiceUnavailable()
            return web.json_response({'ok': True})
        if request.path == '/sandboxes/old':
            if request.method == 'DELETE':
                raise web.HTTPInternalServerError(text='deletion rejected')
            return web.json_response({'sandboxID': 'old', 'state': state.get('sandbox_state', 'running'), 'templateID': 'tpl-old'})
        if request.path == '/__mt/status':
            if state.get('sandbox_state') == 'paused':
                raise web.HTTPServiceUnavailable()
            return web.json_response({'bootstrapped': True, 'hermes': state['hermes'], 'state': {'phase': state['phase'], 'owner': 'old'}})
        if request.path == '/api/health':
            return web.json_response({'ok': state['hermes']})
        assert request.headers['X-MT-Token'] == token
        if request.path == '/__mt/drain':
            state.update(phase='drained', hermes=False)
            if failure == 'archive':
                state['phase'] = 'drain_failed'
                raise web.HTTPInternalServerError(text='archive failed after stopping hermes')
            return web.json_response({'archive': {'archive': 'final.tar.gz'}})
        if request.path == '/__mt/resume':
            if state['resume_fails']:
                raise web.HTTPServiceUnavailable()
            state.update(phase='ready', hermes=True)
            return web.json_response({'ok': True})
        pytest.fail('unexpected Cube mutation: ' + request.path)

    api = web.Application()
    api.router.add_route('*', '/{path:.*}', endpoint)
    try:
        async with TestServer(api) as server:
            origin = str(server.make_url('')).rstrip('/')
            cube = Cube(origin, origin, 'cube.test')
            try:
                manager = TenantManager(settings, None, entry.store, None, cube)
                assert not await manager._drain_and_delete('alice', 'old', token, 'upgrade')
                assert state['hermes'] and (await entry.store.get_runtime('alice')).sandbox_id == 'old'
                assert (await entry.store.get_runtime('alice')).lifecycle == ''
                assert ('POST', '/__mt/resume') in calls
                # A failed rollback keeps a durable recovery marker for the next Entry.
                state.update(phase='drained', hermes=False, resume_fails=True)
                if failure.startswith('paused'):
                    state['sandbox_state'] = 'paused'
                    state['platform_resume_fails'] = failure == 'paused_platform'
                await entry.store.set_lifecycle('alice', 'deleting')
                with pytest.raises(CubeError):
                    await manager._resume_after_drain('alice', 'old', token)
                rt = await entry.store.get_runtime('alice')
                assert rt.lifecycle == 'deleting'
                restarted = TenantManager(settings, None, entry.store, None, cube)
                assert restarted._needs_change(rt, await cube.get_sandbox('old'))
                state['resume_fails'] = False
                state['platform_resume_fails'] = False
                assert await restarted._settle_cube('alice', 'alice', rt, await cube.get_sandbox('old'), token, None) == 'old'
                assert state['hermes'] and (await entry.store.get_runtime('alice')).lifecycle == ''
                if failure.startswith('paused'):
                    assert calls.index(('POST', '/sandboxes/old/resume')) < calls.index(('GET', '/__mt/health'))
                assert ('POST', '/sandboxes') not in calls
                resumed = calls.count(('POST', '/__mt/resume'))
                state.update(phase='fenced', hermes=False)
                with pytest.raises(CubeError):
                    await restarted._resume_after_drain('alice', 'old', token)
                state['sandbox_state'] = 'deleting'
                with pytest.raises(SandboxGone):
                    await restarted._resume_after_drain('alice', 'old', token)
                assert calls.count(('POST', '/__mt/resume')) == resumed
            finally:
                await cube.close()
    finally:
        await entry.database.close()


@pytest.mark.asyncio
async def test_forward_resume_restarts_process_and_reopens_connectors_but_refuses_fenced_owner(forward, tmp_path, monkeypatch):
    forward._bootstrapped = True
    forward._state = SimpleNamespace(phase='drained')
    forward._draining = True
    forward._drained = {'ok': True}
    forward._connectors.draining(True)
    forward._hermes_proc = None
    tasks = [asyncio.create_task(asyncio.Event().wait()) for _ in range(2)]
    forward._supervisor_task, forward._archiver_task = tasks

    async def spawn(token):
        forward._hermes_proc = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time; time.sleep(30)', cwd=tmp_path)
    monkeypatch.setattr(forward, '_spawn_hermes', spawn)
    class Writer:
        data = b''
        def write(self, value): self.data += value
    try:
        writer = Writer()
        await forward._resume(writer)
        assert b'200 OK' in writer.data and forward._hermes_proc.returncode is None
        assert not forward._draining and forward._state.phase == 'ready'
        assert not (tmp_path / '.mt/connectors-draining').exists()
        proc = forward._hermes_proc
        forward._state.phase = 'fenced'
        blocked = Writer()
        await forward._resume(blocked)
        assert b'409 Conflict' in blocked.data and forward._hermes_proc is proc
    finally:
        if forward._hermes_proc:
            forward._hermes_proc.terminate()
            await forward._hermes_proc.wait()
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
