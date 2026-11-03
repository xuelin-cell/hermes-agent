"""Per-home mailbox state and private Node protocol worker; no MaaS credentials."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi import HTTPException


def atomic(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class MailRuntime:
    def __init__(self, home, workspace, script=None, node='/usr/local/bin/node'):
        self.home = Path(home)
        self.workspace = Path(workspace).resolve()
        self.directory = self.home / 'agent-mail'
        self.directory.mkdir(mode=0o700, exist_ok=True)
        if self.directory.is_symlink():
            raise HTTPException(409, 'Invalid mailbox state directory')
        self.script = script or Path(__file__).with_name('worker.mjs')
        self.node = node
        self.process = None
        self.lock = asyncio.Lock()

    def cipher(self):
        key = self.directory / 'key'
        if key.is_symlink():
            raise HTTPException(409, 'Invalid mailbox key')
        if not key.exists():
            atomic(key, Fernet.generate_key())
        return Fernet(key.read_bytes())

    def read(self):
        file = self.directory / 'state.enc'
        if file.is_symlink():
            raise HTTPException(409, 'Invalid mailbox state')
        return json.loads(self.cipher().decrypt(file.read_bytes())) if file.exists() else {}

    def save(self, value):
        atomic(self.directory / 'state.enc', self.cipher().encrypt(json.dumps(value).encode()))

    async def call(self, operation, state, **args):
        if self.process is None or self.process.returncode is not None:
            self.process = await asyncio.create_subprocess_exec(self.node, str(self.script),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                limit=16 * 1024 * 1024, env={'PATH': os.defpath, 'HOME': str(self.home), 'LANG': 'C.UTF-8'})
        quota = self.workspace / '.agent-mail'
        attachments = self.workspace / 'uploads' / 'mail-attachments'
        if quota.is_symlink() or not attachments.resolve().is_relative_to(self.workspace):
            raise HTTPException(409, 'Invalid mailbox storage')
        request_id = secrets.token_hex(16)
        message = {'id': request_id, 'operation': operation, 'directory': str(quota), 'attachments': str(attachments),
                   'values': {'email': state.get('email', ''), 'authorizationCode': state.get('authorizationCode', '')}, **args}
        try:
            self.process.stdin.write((json.dumps(message) + '\n').encode())
            await self.process.stdin.drain()
            reply = json.loads(await asyncio.wait_for(self.process.stdout.readline(), 100))
            if reply.get('id') != request_id or reply.get('error'):
                raise HTTPException(502, reply.get('error') or 'Mailbox worker interrupted')
            return reply['result']
        except (asyncio.TimeoutError, ValueError, OSError):
            await self.close()
            raise HTTPException(502, '邮箱操作结果未确认，请刷新检查；勿重复发送邮件。') from None
        except asyncio.CancelledError:
            await self.close()
            raise

    async def status(self, state=None):
        state = self.read() if state is None else state
        quota = await self.call('quota', state) if state.get('email') else {'dailyQuota': 50, 'todaySent': 0}
        return {'email': state.get('email', ''), 'enabled': state.get('enabled') is True, **quota}

    async def close(self):
        if self.process is not None:
            if self.process.returncode is None:
                self.process.terminate()
            await self.process.wait()
            self.process = None
