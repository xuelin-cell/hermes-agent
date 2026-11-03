"""Build-time smoke test for the PM-managed CLI and Chromium pair; no external network."""
import os
from pathlib import Path
import subprocess
import tempfile

from pm import installed_package


def check():
    browser = str(installed_package('agent-browser').binary)
    chromium = str(installed_package('chromium').binary)
    with tempfile.TemporaryDirectory(prefix='hermes-browser-check-') as directory:
        env = {key: os.environ[key] for key in ('PATH', 'LANG', 'TMPDIR') if key in os.environ}
        env.update(HOME=directory, AGENT_BROWSER_EXECUTABLE_PATH=chromium,
                   AGENT_BROWSER_SOCKET_DIR=directory,
                   AGENT_BROWSER_ARGS='--no-sandbox,--disable-dev-shm-usage')
        command = [browser, '--session', 'hermes-image-check']
        page = Path(directory) / 'page.html'
        page.write_text('<title>Hermes browser ready</title><p>offline check</p>', encoding='utf-8')
        try:
            subprocess.run(command + ['open', page.as_uri()], env=env, check=True,
                           capture_output=True, timeout=45)
            result = subprocess.run(command + ['get', 'title'], env=env, check=True,
                                    capture_output=True, text=True, timeout=15)
            assert 'Hermes browser ready' in result.stdout, result.stdout
            print('agent-browser + Chromium: offline page check passed')
        finally:
            subprocess.run(command + ['close'], env=env, capture_output=True, timeout=15)


if __name__ == '__main__':
    check()
