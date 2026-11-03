"""Cloud uses the real installer, profile resolution and on-disk archives across tenant homes."""
import importlib
import json
from pathlib import Path

import pytest
import yaml

from tests.plugins.test_uniwork_kits_plugin import (
    kits, profile_env, kit_pkg, expert_pkg, _expert_pkg, _zip_dir,
)


def test_cloud_install_profiles_and_archive_are_owned_by_each_tenant(kits, profile_env, kit_pkg,
                                                                   expert_pkg, tmp_path, monkeypatch):
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    bundles = tmp_path / 'bundled'
    _zip_dir(kit_pkg, bundles / 'plugins/demo-kit.zip')
    _zip_dir(expert_pkg, bundles / 'plugins/demo-expert.zip')
    other = _expert_pkg(tmp_path, name='other-expert')
    _zip_dir(other, bundles / 'plugins/other-expert.zip')
    roots = [profile_env, tmp_path / 'tenant-b']
    for root in roots:
        root.mkdir(exist_ok=True)
        (root / 'config.yaml').write_text(yaml.safe_dump({
            'cloud_kits': {'enabled': True}, 'uniwork_kits': {'bundled_dir': str(bundles)},
            'model': {'provider': 'yuanjing', 'default': 'fixture'},
            'providers': {'yuanjing': {'base_url': 'http://example.invalid/v1'}},
        }))
        (root / '.env').write_text('MODEL_SECRET=' + root.name + '\n')
        monkeypatch.setenv('HERMES_HOME', str(root))
        assert all(not row['installed'] for row in cloud.describe(cloud.home())['plugins'])
        for name in ('demo-kit', 'demo-expert', 'other-expert'):
            assert cloud.action({'operation': 'install', 'name': name})['ok']
        for name in ('demo-expert', 'other-expert'):
            target = cloud.profile_home(root, name)
            assert target == root / 'profiles' / name
            assert root.name in (target / '.env').read_text()
            config = yaml.safe_load((target / 'config.yaml').read_text())
            assert config['cloud_kits']['enabled'] is True
            assert config['security']['allow_lazy_installs'] is False
            (target / 'MEMORY.md').write_text(root.name + '/' + name)
        assert len(cloud.directory(root)['experts']) == 2
        with pytest.raises(kits.installer.KitError):
            cloud.profile_home(root, '../tenant-b')
        arbitrary = root / 'profiles/unmanaged'
        arbitrary.mkdir()
        with pytest.raises(kits.installer.KitError):
            cloud.profile_home(root, 'unmanaged')
        cloud.action({'operation': 'toggle', 'name': 'demo-kit', 'enabled': False})
        assert not next(row for row in cloud.describe(root)['plugins'] if row['name'] == 'demo-kit')['enabled']
        with pytest.raises(kits.installer.KitError):
            cloud.action({'operation': 'uninstall', 'name': 'demo-expert'})
    monkeypatch.setenv('HERMES_HOME', str(roots[0]))
    assert cloud.home() == roots[0]
    assert (cloud.profile_home(roots[0], 'demo-expert') / 'MEMORY.md').read_text() == roots[0].name + '/demo-expert'
    cloud.action({'operation': 'uninstall', 'name': 'demo-expert', 'delete_profile': True})
    assert not next(row for row in cloud.describe(roots[0])['plugins'] if row['name'] == 'demo-expert')['installed']
    assert (roots[1] / 'profiles/demo-expert/MEMORY.md').exists()
    # Template resources remain available but an explicit uninstall is never auto-reinstalled.
    assert all(row['name'] != 'demo-expert' for row in cloud.directory(roots[0])['experts'])


def test_cloud_mutation_publishes_activity_and_refuses_draining_or_active_turns(kits, profile_env,
                                                                             tmp_path, monkeypatch):
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    from tui_gateway import server

    (profile_env / 'config.yaml').write_text('cloud_kits:\n  enabled: true\n')
    marker = profile_env / '.mt/kits-active.json'
    with cloud.changing(profile_env):
        assert json.loads(marker.read_text())['running']
    assert not marker.exists()
    fence = profile_env / '.mt/connectors-draining'
    fence.write_text('draining')
    with pytest.raises(kits.installer.KitError, match='排空'):
        with cloud.changing(profile_env):
            pytest.fail('mutation admitted during drain')
    fence.unlink()
    monkeypatch.setattr(server, '_sessions', {'active': {'running': True, 'profile_home': str(profile_env)}})
    with pytest.raises(kits.installer.KitError, match='正在执行'):
        with cloud.changing(profile_env):
            pytest.fail('mutation admitted during a turn')
    assert not marker.exists()


def test_cloud_expert_socket_runs_real_rpc_and_local_model(kits, profile_env, expert_pkg,
                                                          tmp_path, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from hermes_state import SessionDB
    from tui_gateway import server
    import hermes_cli.web_server as web_server

    requests = []
    slow_started, release_slow = threading.Event(), threading.Event()
    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            text = 'local-model-reply'
            self.send_response(200)
            if body.get('stream'):
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                slow = 'slow-turn' in json.dumps(body.get('messages', [])[-1:])
                for delta, finish in [({'role': 'assistant', 'content': text}, None), ({}, 'stop')]:
                    if slow and finish:
                        slow_started.set()
                        release_slow.wait(timeout=10)
                    data = {'id': 'chat-test', 'object': 'chat.completion.chunk', 'created': 1,
                            'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(data) + '\n\n').encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'id': 'chat-test', 'object': 'chat.completion', 'created': 1,
                    'model': 'fixture', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}).encode())

    model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    thread = threading.Thread(target=model.serve_forever, daemon=True)
    thread.start()
    root = profile_env
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    routes = importlib.import_module('hermes_plugins.uniwork_kits.cloud_routes')
    bundle = tmp_path / 'bundles'
    _zip_dir(expert_pkg, bundle / 'plugins/demo-expert.zip')
    other = _expert_pkg(tmp_path, name='other-expert')
    _zip_dir(other, bundle / 'plugins/other-expert.zip')
    config = {'cloud_kits': {'enabled': True}, 'uniwork_kits': {'bundled_dir': str(bundle)},
              'model': {'provider': 'custom', 'default': 'fixture', 'base_url': f'http://127.0.0.1:{model.server_port}/v1', 'api_key': 'local-test'},
              'toolsets': [], 'agent': {'max_turns': 2}, 'mcp_servers': {}}
    (root / 'config.yaml').write_text(yaml.safe_dump(config))
    for name in ('demo-expert', 'other-expert'):
        cloud.action({'operation': 'install', 'name': name})
    monkeypatch.setattr(server, '_hermes_home', str(root))
    monkeypatch.setattr(server, '_db', SessionDB(db_path=root / 'state.db'))
    monkeypatch.setattr(server, '_sessions', {})
    monkeypatch.setattr(web_server, '_SESSION_TOKEN', 'cloud-test-token')
    app = FastAPI()
    app.include_router(routes.router, prefix='/api/plugins/uniwork-kits/cloud')
    try:
        stored = {}
        with TestClient(app, base_url='http://127.0.0.1') as client:
            from starlette.websockets import WebSocketDisconnect

            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect('/api/plugins/uniwork-kits/cloud/ws?token=wrong'):
                    pytest.fail('unauthenticated expert socket accepted')
            with client.websocket_connect('/api/plugins/uniwork-kits/cloud/ws?token=cloud-test-token') as ws:
                seq = 0
                def rpc(method, params):
                    nonlocal seq
                    seq += 1
                    ws.send_json({'jsonrpc': '2.0', 'id': seq, 'method': method, 'params': params})
                    events = []
                    while True:
                        frame = ws.receive_json()
                        if frame.get('id') == seq:
                            return frame, events
                        events.append(frame)
                rejected, _ = rpc('session.list', {'profile': 'unmanaged'})
                assert 'error' in rejected
                with cloud.changing(root):
                    rejected, _ = rpc('session.create', {'profile': 'demo-expert'})
                    assert 'error' in rejected
                for profile in ('demo-expert', 'other-expert', 'default', 'demo-expert'):
                    created, _ = rpc('session.create', {'profile': profile, 'source': 'desktop', 'title': 'Test ' + profile})
                    assert 'result' in created, created
                    result = created['result']
                    sid = result.get('session_id') or result.get('id')
                    assert sid, result
                    reply, events = rpc('prompt.submit', {'profile': profile, 'session_id': sid, 'text': 'Reply with a greeting.'})
                    assert 'error' not in reply, reply
                    # Completion arrives as an event, possibly after the submit acknowledgment.
                    while not any(frame.get('params', {}).get('type') == 'message.complete' for frame in events):
                        events.append(ws.receive_json())
                    assert any('local-model-reply' in json.dumps(frame) for frame in events)
                    expected = None if profile == 'default' else str(root / 'profiles' / profile)
                    assert server._sessions[sid]['profile_home'] == expected
                    if profile == 'demo-expert':
                        wrong, _ = rpc('session.interrupt', {'profile': 'other-expert', 'session_id': sid})
                        assert 'error' in wrong
                    stored[profile] = server._sessions[sid]['session_key']
                    if profile == 'other-expert':
                        rpc('prompt.submit', {'profile': profile, 'session_id': sid, 'text': 'slow-turn'})
                        assert slow_started.wait(timeout=5)
                        stopped, pending = rpc('session.interrupt', {'session_id': sid})
                        release_slow.set()
                        assert 'error' not in stopped, stopped
                        while not any(frame.get('params', {}).get('type') == 'message.complete' for frame in pending):
                            pending.append(ws.receive_json())
                    rpc('session.close', {'profile': profile, 'session_id': sid})
            # A fresh authenticated socket resumes each profile's own persisted history.
            with client.websocket_connect('/api/plugins/uniwork-kits/cloud/ws?token=cloud-test-token') as ws:
                for profile, key in stored.items():
                    resumed, _ = rpc('session.resume', {'profile': profile, 'session_id': key})
                    assert 'result' in resumed, resumed
                    assert 'local-model-reply' in json.dumps(resumed)
                    sid = resumed['result'].get('session_id') or resumed['result'].get('id')
                    rpc('session.close', {'profile': profile, 'session_id': sid})
        assert requests
        for profile in ('demo-expert', 'other-expert', 'default'):
            target = root if profile == 'default' else root / 'profiles' / profile
            db = SessionDB(db_path=target / 'state.db')
            rows = db._conn.execute('SELECT id FROM sessions').fetchall()
            assert rows
            assert any('local-model-reply' in json.dumps(db.get_messages_as_conversation(row[0])) for row in rows)
            db.close()
        monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'deploy/hermes-mt/seed'))
        import mtstate

        archive, manifest = mtstate.build_archive(root, tmp_path / 'snapshot', 'tenant-a', 1, '')
        restored = tmp_path / 'restored'
        restored.mkdir()
        mtstate.restore_archive(restored, archive.parent, manifest)
        monkeypatch.setenv('HERMES_HOME', str(restored))
        assert len(cloud.directory(restored)['experts']) == 2
        assert cloud.profile_home(restored, 'demo-expert') == restored / 'profiles/demo-expert'
        assert (restored / 'profiles/other-expert/state.db').is_file()
    finally:
        release_slow.set()
        model.shutdown()
        model.server_close()
        thread.join(timeout=5)
