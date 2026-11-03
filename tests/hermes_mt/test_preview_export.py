"""Actual forwarder HTTP and Chromium printing, with temp files and no external services."""
from __future__ import annotations

import asyncio
import importlib.util
import os
from pathlib import Path
import sys

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

SEED = Path(__file__).resolve().parents[2] / 'deploy/hermes-mt/seed'


def forward_module(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(SEED))
    spec = importlib.util.spec_from_file_location('export_forward_test', SEED / 'forward.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._hermes_token = 'test-instance-token'
    module.WORKSPACE = tmp_path
    return module


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
async def test_real_pdf_http_rejects_other_tokens_blocks_resources_and_retires_temp_files(tmp_path, monkeypatch):
    if not importlib.util.find_spec('playwright'):
        pytest.skip('A PM test runtime with Playwright and installed Chromium is required')
    from playwright.async_api import async_playwright
    async with async_playwright() as driver:
        executable = Path(driver.chromium.executable_path)
    if not executable.is_file():
        pytest.skip('Chromium is not installed for this test runtime')
    browser_root = next(parent.parent for parent in executable.parents if parent.name.startswith('chromium-'))
    monkeypatch.setenv('PLAYWRIGHT_BROWSERS_PATH', str(browser_root))
    runtime = sys.executable
    module = forward_module(monkeypatch, tmp_path)
    module.HERMES_PYTHON = runtime
    hits = []
    async def trap(request):
        hits.append(request.path)
        return web.Response(text='untrusted external resource')
    trap_app = web.Application()
    trap_app.router.add_route('*', '/{tail:.*}', trap)
    server = await asyncio.start_server(module._handle, '127.0.0.1', 0)
    url = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}/__mt_user/preview-export'
    monkeypatch.setenv('TMPDIR', str(tmp_path))
    monkeypatch.setattr(module.mtexport.tempfile, 'tempdir', str(tmp_path))
    async with TestServer(trap_app) as external, aiohttp.ClientSession() as client:
        content = '<h1>Export snapshot 中文</h1>' + f'<img src="{external.make_url("/image")}"><script>location.href="{external.make_url("/script")}"</script>'
        async with client.post(url, json={'content': content}) as response:
            assert response.status == 403
        async with client.post(url, json={'content': content}, headers={'X-Hermes-Session-Token': 'test-instance-token'}) as response:
            body = await response.read()
            assert response.status == 200 and response.content_type == 'application/pdf'
            assert body.startswith(b'%PDF-') and len(body) > 1000
            assert response.headers['Cache-Control'] == 'no-store'
        assert hits == []
        # Export bytes are streamed once, not left in the instance workspace or its temp job folder.
        async with asyncio.timeout(2):
            while list(tmp_path.glob('hermes-pdf-export-*')):
                await asyncio.sleep(.02)
        assert not list(tmp_path.glob('hermes-pdf-export-*'))
    server.close()
    await server.wait_closed()


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
async def test_export_limits_cancel_and_child_environment(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SEED))
    import mtexport
    monkeypatch.setenv('MT_CREDENTIAL_KEY', 'must-not-reach-child')
    monkeypatch.setenv('HERMES_DASHBOARD_SESSION_TOKEN', 'must-not-reach-child')
    script = tmp_path / 'fake_printer.py'
    script.write_text('import os,sys,time\nassert "MT_CREDENTIAL_KEY" not in os.environ\nassert "HERMES_DASHBOARD_SESSION_TOKEN" not in os.environ\nsys.stdin.buffer.read()\nopen(sys.argv[1], "wb").write(b"%PDF-fixture")\ntime.sleep(10)\n')
    original = asyncio.create_subprocess_exec
    async def start(*argv, **kwargs):
        return await original(sys.executable, str(script), argv[-1], **kwargs)
    monkeypatch.setattr(mtexport.asyncio, 'create_subprocess_exec', start)
    monkeypatch.setattr(mtexport, 'TIMEOUT', 2)
    with pytest.raises(asyncio.TimeoutError):
        async with mtexport.pdf('<p>snapshot</p>', sys.executable):
            raise AssertionError('timeout must not deliver a file')
    with pytest.raises(mtexport.ExportError):
        async with mtexport.pdf('x' * (mtexport.MAX_HTML + 1), sys.executable):
            raise AssertionError('oversized content must not start a renderer')
