"""Bounded, credential-free Chromium printing for a user's rendered Markdown snapshot."""
from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
import signal
import sys
import tempfile

MAX_HTML = 8 * 1024 * 1024
MAX_PDF = 32 * 1024 * 1024
TIMEOUT = 40
CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; base-uri \'none\'; form-action \'none\'; frame-src \'none\'">'


class ExportError(Exception):
    pass


@contextlib.asynccontextmanager
async def pdf(content: str, python: str):
    if not isinstance(content, str) or len(content.encode('utf-8')) > MAX_HTML:
        raise ExportError('invalid_content')
    with tempfile.TemporaryDirectory(prefix='hermes-pdf-export-') as folder:
        output = Path(folder) / 'document.pdf'
        env = {'PATH': os.defpath, 'HOME': folder, 'LANG': 'C.UTF-8', 'TMPDIR': folder}
        if os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):
            env['PLAYWRIGHT_BROWSERS_PATH'] = os.environ['PLAYWRIGHT_BROWSERS_PATH']
        proc = await asyncio.create_subprocess_exec(
            python, str(Path(__file__).resolve()), str(output),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            env=env, start_new_session=True,
        )
        try:
            await asyncio.wait_for(proc.communicate(content.encode('utf-8')), TIMEOUT)
            if proc.returncode or not output.is_file() or output.stat().st_size > MAX_PDF:
                raise ExportError('conversion_failed')
            with output.open('rb') as source:
                if source.read(5) != b'%PDF-':
                    raise ExportError('conversion_failed')
            yield output
        finally:
            # Playwright and Chromium are descendants: retire the whole job on success, timeout or cancellation.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()


async def _print(html: str, output: str):
    from playwright.async_api import async_playwright
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            context = await browser.new_context(java_script_enabled=False, offline=True, service_workers='block')
            await context.route('**/*', lambda route: route.abort())
            page = await context.new_page()
            await page.set_content(CSP + html, wait_until='load', timeout=15_000)
            await page.pdf(path=output, format='A4', prefer_css_page_size=True, print_background=True)
        finally:
            await browser.close()


if __name__ == '__main__':
    raw = sys.stdin.buffer.read(MAX_HTML + 1)
    if len(raw) > MAX_HTML:
        raise SystemExit(2)
    asyncio.run(_print(raw.decode('utf-8'), sys.argv[1]))
