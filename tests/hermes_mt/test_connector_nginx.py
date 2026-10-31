"""The browser refuses redirects, so connector POSTs must reach Entry unchanged."""
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

import pytest


REPO = Path(__file__).resolve().parents[2]


def test_connector_post_is_not_redirected_to_the_oauth_directory(tmp_path):
    docker = shutil.which('docker')
    if not docker:
        pytest.skip('Docker is required for the Nginx integration test')
    available = subprocess.run([docker, 'image', 'inspect', 'nginx:1.27-alpine'],
                               capture_output=True, timeout=15)
    if available.returncode:
        pytest.skip('Local Docker daemon and nginx:1.27-alpine image are required; no image is pulled')
    production = (REPO / 'deploy/hermes-mt/nginx/hermes-mt.conf').read_text()
    config = tmp_path / 'nginx.conf'
    config.write_text('events {}\nhttp {\n' + production + '''
server { listen 9400; location / {
    default_type application/json;
    return 200 '{"method":"$request_method","uri":"$request_uri"}';
} }
}
''')
    container = subprocess.check_output([
        docker, 'run', '-d', '--rm', '--add-host', 'entry:127.0.0.1',
        '-p', '127.0.0.1::8081', '-v', f'{config}:/etc/nginx/nginx.conf:ro',
        'nginx:1.27-alpine',
    ], text=True, timeout=30).strip()
    try:
        for _ in range(50):
            ready = subprocess.run([docker, 'exec', container, 'wget', '-qO-',
                                    'http://127.0.0.1:9400/'], capture_output=True, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(.1)
        assert ready.returncode == 0
        info = json.loads(subprocess.check_output([docker, 'inspect', container], timeout=10))[0]
        port = info['NetworkSettings']['Ports']['8081/tcp'][0]['HostPort']

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args):
                return None

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
        path = '/hermes/__entry/connectors'
        request = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
                                         data=b'{"operation":"list","profile":"default"}',
                                         headers={'Content-Type': 'application/json'})
        with opener.open(request, timeout=10) as response:
            assert response.status == 200
            assert json.load(response) == {'method': 'POST', 'uri': path}
        callback = '/hermes/__entry/connectors/qcc_mcp/oauth/callback?state=test&code=test'
        with opener.open(f'http://127.0.0.1:{port}{callback}', timeout=10) as response:
            assert json.load(response) == {'method': 'GET', 'uri': callback}
    finally:
        subprocess.run([docker, 'stop', container], check=True, capture_output=True, timeout=15)
