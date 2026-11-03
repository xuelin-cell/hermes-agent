"""Recovery uses real PID liveness and scoped disk state; existing turns never auto-replay."""
import importlib
import json
import subprocess
import sys

import httpx
import pytest
import yaml
from fastapi import FastAPI

from tests.plugins.test_uniwork_kits_plugin import kits, profile_env, expert_pkg


@pytest.mark.asyncio
async def test_recovery_claims_dead_writers_once_and_isolates_account_homes(kits, profile_env, tmp_path):
    from tui_gateway.turn_marker import record_turn_start
    recovery = importlib.import_module('hermes_plugins.uniwork_kits.cloud_recovery')
    routes = importlib.import_module('hermes_plugins.uniwork_kits.cloud_routes')
    child = subprocess.Popen([sys.executable, '-c', 'pass'])
    child.wait(timeout=5)
    roots = {'a':profile_env, 'b':tmp_path/'b'}
    for key, home in roots.items():
        home.mkdir(exist_ok=True)
        (home/'config.yaml').write_text('cloud_kits: {enabled: true}\n')
        record_turn_start(home, 'same-session', 'task-'+key)
        record_turn_start(home, 'still-running', 'live')
        file = home/'desktop/interrupted_turns.json'
        markers = json.loads(file.read_text())
        markers['same-session']['writer_pid'] = child.pid
        markers['same-session'].pop('writer_start_time', None)
        file.write_text(json.dumps(markers))
        recovery.claim_all(home)
        assert yaml.safe_load((home/'config.yaml').read_text())['desktop']['auto_continue']['enabled'] is False
        remaining = json.loads(file.read_text())
        assert 'still-running' in remaining and 'same-session' not in remaining
    app = FastAPI()
    @app.middleware('http')
    async def scope(request, call_next):
        with kits.store.scoped_home(roots[request.headers['owner']]): return await call_next(request)
    app.include_router(routes.router, prefix='/cloud')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://instance') as http:
        first = None
        for owner in ('a','b','a'):
            result = (await http.get('/cloud/interrupted', headers={'owner':owner})).json()['turns']
            assert len(result)==1 and result[0]['prompt']=='task-'+owner
            if owner=='a':
                if first is None: first=result
                else: assert result==first  # Reopening does not restart the 15-minute clock.
        assert (await http.post('/cloud/interrupted/dismiss',json={'sessionId':'same-session'},headers={'owner':'a'})).status_code==200
        assert (await http.get('/cloud/interrupted',headers={'owner':'a'})).json()['turns']==[]
        assert len((await http.get('/cloud/interrupted',headers={'owner':'b'})).json()['turns'])==1


@pytest.mark.asyncio
async def test_expert_cron_rpc_and_script_execution_keep_owning_profile(kits, profile_env, expert_pkg, tmp_path):
    from cron import jobs, scheduler
    from tui_gateway import server
    from plugins.cloud_messaging.notifications import Notifications
    from tests.plugins.test_uniwork_kits_plugin import _expert_pkg, _zip_dir
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    routes = importlib.import_module('hermes_plugins.uniwork_kits.cloud_routes')
    bundles = tmp_path / 'bundles'
    _zip_dir(expert_pkg, bundles / 'plugins/demo-expert.zip')
    _zip_dir(_expert_pkg(tmp_path, name='other-expert'), bundles / 'plugins/other-expert.zip')
    (profile_env / 'config.yaml').write_text(yaml.safe_dump({'cloud_kits': {'enabled': True}, 'uniwork_kits': {'bundled_dir': str(bundles)}}))
    homes = {}
    for name in ('demo-expert', 'other-expert'):
        cloud.action({'operation': 'install', 'name': name})
        home = homes[name] = cloud.profile_home(profile_env, name)
        (home / 'scripts').mkdir(exist_ok=True)
        (home / 'scripts/report.sh').write_text('printf "' + name + '"\n')
        with kits.store.scoped_home(home):
            job = jobs.create_job(prompt=None, name=name, schedule='every 1h', script='report.sh', no_agent=True, deliver='local')
            success, _, result, error = scheduler.run_job(job)
            assert success and error is None and result == name
        # Expert results use the tenant's central relay queue, not another account's root.
        assert Notifications(home).path == Notifications(profile_env).path

    class Socket:
        def __init__(self, profile):
            self.raw = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'cron.manage', 'params': {'action': 'list', 'profile': profile}})
        async def receive_text(self): return self.raw
        async def send_json(self, value): raise AssertionError(value)

    for profile in ('demo-expert', 'other-expert', 'demo-expert'):
        raw = await routes.ExpertSocket(Socket(profile)).receive_text()
        reply = server.handle_request(json.loads(raw))
        assert 'result' in reply, reply
        assert reply['result']['scoped'] == profile
        assert [job['name'] for job in reply['result']['jobs']] == [profile]
