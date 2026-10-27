"""One private Node worker reuses the desktop drive protocol for all Entry logins."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from aiohttp import web


class DriveWorker:
    def __init__(self, script: Path | None = None, node: str = "/usr/local/bin/node"):
        self.script = script or Path(__file__).parent / 'static/cloud-drive-worker.mjs'
        self.node = node
        self.scratch = TemporaryDirectory(prefix='hermes-drive-')
        self.root = Path(self.scratch.name).resolve()
        self.process = None
        self.pending: dict[str, tuple[asyncio.Future, object]] = {}
        self.lock = asyncio.Lock()
        self.writer_lock = asyncio.Lock()
        self.reader = None
        self.logins = {}

    async def start(self):
        async with self.lock:
            if self.process and self.process.returncode is None:
                return
            if self.reader and not self.reader.done():
                await self.reader
            if not self.script.is_file():
                raise web.HTTPServiceUnavailable(text='网盘组件未构建，请更新入口镜像。')
            self.process = await asyncio.create_subprocess_exec(
                self.node, str(self.script), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=2 * 1024 * 1024,
                env={'PATH': os.defpath, 'HOME': str(self.root), 'LANG': 'C.UTF-8'})
            self.reader = asyncio.create_task(self._read(self.process))

    async def _read(self, process):
        try:
            while line := await process.stdout.readline():
                value = json.loads(line)
                pending = self.pending.get(value.get('id'))
                if not pending:
                    continue
                future, progress = pending
                if 'progress' in value:
                    if progress:
                        progress(value['progress'])
                elif not future.done():
                    future.set_result(value.get('result'))
        except (ValueError, OSError):
            pass
        finally:
            for future, _ in self.pending.values():
                if not future.done():
                    future.set_exception(web.HTTPBadGateway(text='网盘进程中断，写入结果需核验。'))
            if process.returncode is None:
                process.terminate()
            await process.wait()

    async def call(self, action, *, identity=None, progress=None, **values):
        await self.start()
        if len(self.pending) >= 32:
            raise web.HTTPServiceUnavailable(text='网盘操作繁忙，请稍后重试。')
        key = identity.login_id if identity else ''
        root = self.root / (key or 'system')
        root.mkdir(mode=0o700, exist_ok=True)
        data = {'id': secrets.token_hex(16), 'key': key, 'root': str(root), 'action': action, **values}
        if identity:
            for sid, (_, expires) in list(self.logins.items()):
                if expires <= time.time():
                    self.logins.pop(sid, None)
            if len(self.logins) >= 512 and identity.session_sid not in self.logins:
                self.logins.pop(next(iter(self.logins)))
            self.logins[identity.session_sid] = (identity.login_id, identity.expires_at / 1000)
            data['identity'] = {'uid': identity.user_id, 'phone': identity.phone,
                                'token': identity.token, 'expiresAt': identity.expires_at}
        future = asyncio.get_running_loop().create_future()
        self.pending[data['id']] = (future, progress)
        try:
            async with self.writer_lock:
                self.process.stdin.write((json.dumps(data) + '\n').encode())
                await self.process.stdin.drain()
            return await asyncio.wait_for(asyncio.shield(future), timeout=730)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            async with self.writer_lock:
                self.process.stdin.write((json.dumps({'id': secrets.token_hex(16), 'action': 'cancel', 'target': data['id']}) + '\n').encode())
                await self.process.stdin.drain()
            raise
        finally:
            self.pending.pop(data['id'], None)

    async def logout(self, sid):
        login = self.logins.pop(sid, None)
        if login and self.process and self.process.returncode is None:
            await self.call('logout', key=login[0])

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.reader:
            await self.reader
        self.scratch.cleanup()
