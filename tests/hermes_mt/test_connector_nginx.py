"""The browser refuses redirects, so connector POSTs must reach Entry unchanged; paths reach Entry as documented."""
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

import pytest


REPO = Path(__file__).resolve().parents[2]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)


@pytest.fixture
def nginx(tmp_path):
    """Production config in front of a stub Entry that echoes what it received. Yields {container port: host port}."""
    docker = shutil.which('docker')
    if not docker:
        pytest.skip('Docker is required for the Nginx integration test')
    available = subprocess.run([docker, 'image', 'inspect', 'nginx:1.27-alpine'],
                               capture_output=True, timeout=15)
    if available.returncode:
        pytest.skip('Local Docker daemon and nginx:1.27-alpine image are required; no image is pulled')
    production = (REPO / 'deploy/hermes-mt/nginx/hermes-mt.conf').read_text(encoding='utf-8')
    config = tmp_path / 'nginx.conf'
    config.write_text('events {}\nhttp {\n' + production + '''
server { listen 9400; location / {
    default_type application/json;
    return 200 '{"method":"$request_method","uri":"$request_uri"}';
} }
}
''', encoding='utf-8')
    # docker cp rather than a bind mount: mounting a file from a temp directory fails on Docker Desktop.
    container = subprocess.check_output([
        docker, 'create', '--rm', '--add-host', 'entry:127.0.0.1',
        '-p', '127.0.0.1::8081', '-p', '127.0.0.1::8082',
        'nginx:1.27-alpine',
    ], text=True, timeout=30).strip()
    try:
        subprocess.run([docker, 'cp', str(config), f'{container}:/etc/nginx/nginx.conf'],
                       check=True, capture_output=True, timeout=15)
        subprocess.run([docker, 'start', container], check=True, capture_output=True, timeout=30)
        for _ in range(50):
            ready = subprocess.run([docker, 'exec', container, 'wget', '-qO-',
                                    'http://127.0.0.1:9400/'], capture_output=True, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(.1)
        assert ready.returncode == 0
        info = json.loads(subprocess.check_output([docker, 'inspect', container], timeout=10))[0]
        yield {port: info['NetworkSettings']['Ports'][f'{port}/tcp'][0]['HostPort'] for port in (8081, 8082)}
    finally:
        subprocess.run([docker, 'rm', '-f', container], capture_output=True, timeout=30)


def forwarded(port, path, **request):
    """What the stub Entry saw for this request."""
    with OPENER.open(urllib.request.Request(f'http://127.0.0.1:{port}{path}', **request), timeout=10) as response:
        assert response.status == 200
        return json.load(response)


def redirected(port, path):
    with pytest.raises(urllib.error.HTTPError) as caught:
        OPENER.open(f'http://127.0.0.1:{port}{path}', timeout=10)
    return caught.value.code, caught.value.headers['Location']


def test_connector_post_is_not_redirected_to_the_oauth_directory(nginx):
    path = '/agents/api/__entry/connectors'
    assert forwarded(nginx[8081], path, data=b'{"operation":"list","profile":"default"}',
                     headers={'Content-Type': 'application/json'}) == {'method': 'POST', 'uri': path}
    callback = '/agents/api/__entry/connectors/qcc_mcp/oauth/callback?state=test&code=test'
    assert forwarded(nginx[8081], callback) == {'method': 'GET', 'uri': callback}


@pytest.mark.parametrize('path', [
    '/agents/login', '/agents/logout', '/agents/api/__entry/me', '/agents/api/ws',
    '/agents/api/__hermes_backend/api/health', '/agents/api/__hermes_backend/__mt_user/terminal',
    '/agents/api/channels/uniagentgate/cloud-binding/alice', '/hermes/__entry/service/v1/runtimes',
])
def test_current_paths_reach_entry_unchanged(nginx, path):
    assert forwarded(nginx[8081], path)['uri'] == path


@pytest.mark.parametrize('old, new', [
    ('/hermes/__entry/messaging/media/file?e=1&s=2', '/agents/api/__entry/messaging/media/file?e=1&s=2'),
    ('/hermes/__entry/langfuse/api/public/otel/v1/traces', '/agents/api/__entry/langfuse/api/public/otel/v1/traces'),
    ('/hermes/api/channels/uniagentgate/cloud-binding/alice', '/agents/api/channels/uniagentgate/cloud-binding/alice'),
    ('/api/channels/uniagentgate/cloud-binding/alice', '/agents/api/channels/uniagentgate/cloud-binding/alice'),
])
def test_addresses_already_handed_out_keep_working(nginx, old, new):
    assert forwarded(nginx[8081], old)['uri'] == new


@pytest.mark.parametrize('path, status, location', [
    ('/', 302, '/agents/'), ('/agents', 301, '/agents/'), ('/hermes', 301, '/agents/'), ('/hermes/', 301, '/agents/'),
    ('/hermes/login', 301, '/agents/'), ('/hermes/assets/app.js', 301, '/agents/'),
])
def test_old_pages_go_to_the_new_address(nginx, path, status, location):
    assert redirected(nginx[8081], path) == (status, location)


def test_service_listener_only_serves_the_unchanged_service_path(nginx):
    path = '/hermes/__entry/service/v1/runtimes'
    assert forwarded(nginx[8082], path)['uri'] == path
    for other in ('/agents/', '/agents/api/__entry/me', '/hermes/__entry/me'):
        with pytest.raises(urllib.error.HTTPError) as caught:
            OPENER.open(f'http://127.0.0.1:{nginx[8082]}{other}', timeout=10)
        assert caught.value.code == 404
