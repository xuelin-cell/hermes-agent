"""One lazy OpenConnector process per instance; credentials never cross the management response."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import aiohttp
from mtconnector_profile import ConnectorProfile, authorize_profile


class Connectors(ConnectorProfile):
    def __init__(self, home: Path, python: str, *, worker=None, node=None, port=9122, profile_token='', backend_port=9120):
        super().__init__(home, port)
        self.python = python
        self.profile_token, self.backend_port = profile_token, backend_port
        self.restored = False
        self.worker = worker or str(Path(__file__).parent / 'connectors/src/server/storage/worker.mjs')
        self.node, self.port = node, port
        self.process = None
        self.lock = asyncio.Lock()
        self.values = None
        self.managing = False

    @property
    def specs(self):
        return json.loads((Path(self.worker).parents[3] / 'contract.json').read_text())

    async def start(self):
        if self.process and self.process.returncode is None:
            return
        self.values = self.credentials()
        node = self.node
        if not node:
            resolver = await asyncio.create_subprocess_exec(self.python, '-c',
                'from pm import installed_package; print(installed_package("node").binary)', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            output, _ = await resolver.communicate()
            if resolver.returncode:
                raise RuntimeError('Connector Node runtime unavailable')
            node = output.decode().strip()
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR') if key in os.environ}
        env.update(HERMES_HOME=str(self.home), OOMOL_CONNECT_ENCRYPTION_KEY=self.values['encryption'],
            OOMOL_CONNECT_ADMIN_TOKEN=self.values['admin'], OOMOL_CONNECT_RUNTIME_TOKEN=self.values['runtime'],
            OOMOL_CONNECT_PORT=str(self.port), OOMOL_CONNECT_PROFILE_TOKEN=self.profile_token,
            OOMOL_CONNECT_PROFILE_PORT=str(self.backend_port), NODE_ENV='production')
        self.process = await asyncio.create_subprocess_exec(node, self.worker, env=env,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1)) as http:
                for _ in range(100):
                    if self.process.returncode is not None:
                        break
                    try:
                        async with http.get(f'http://127.0.0.1:{self.port}/health',
                            headers={'Authorization': 'Bearer ' + self.values['admin']}) as response:
                            if response.status == 200:
                                return
                    except (aiohttp.ClientError, asyncio.TimeoutError):
                        pass
                    await asyncio.sleep(0.1)
            raise RuntimeError('Connector failed to start')
        except BaseException:
            await self.close()
            raise

    async def call(self, operation, values=None, *, id=None, **extra):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45)) as http:
            async with http.post(f'http://127.0.0.1:{self.port}/__manage',
                headers={'Authorization': 'Bearer ' + self.values['admin']},
                json={'operation': operation, 'id': id, 'values': values, **extra}) as response:
                if response.status != 200:
                    raise RuntimeError('连接器操作失败，请核对凭据或查询状态；不要自动重放写操作。')
                return await response.json()

    async def scoped(self, name):
        home = await authorize_profile(self.home, name, self.profile_token, self.backend_port)
        scope = self if name == 'default' else ConnectorProfile(home, self.port, name)
        scope.discard_inherited()
        scope.values = scope.credentials()
        return scope

    async def restore(self):
        async with self.lock:
            self.restored = False
            (self.home / '.mt/connectors-draining').unlink(missing_ok=True)
            names = ['default']
            directory = self.home / 'profiles'
            if directory.is_dir() and not directory.is_symlink():
                names.extend(path.name for path in directory.iterdir()
                             if path.is_dir() and not path.is_symlink() and (path / 'open-connector/secrets.json').is_file())
            for name in names:
                try:
                    scope = await self.scoped(name)
                except ValueError:
                    continue  # Removed/disabled experts must never restart their tools.
                _, _, config = scope.config()
                for id in self.specs:
                    saved = config.get('mcp_servers', {}).get('connector_' + id)
                    if isinstance(saved, dict) and saved.get('cloud_connector') == id and saved.get('enabled') is True:
                        await self.start()
                        scope.update(id, True)
            self.restored = True

    async def recover(self):
        if not self.process or self.process.returncode is not None or not self.restored:
            await self.restore()

    def draining(self, enabled):
        file = self.home / '.mt/connectors-draining'
        if enabled:
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.atomic(file, 'draining')
        else:
            file.unlink(missing_ok=True)

    async def request(self, data):
        if not isinstance(data, dict):
            raise ValueError('无效的连接器请求。')
        profile = data.get('profile', 'default')
        operation = data.get('operation')
        specs, id = self.specs, data.get('id')
        if operation not in {'list', 'connect', 'enable', 'disable', 'disconnect', 'save', 'authorize', 'oauth.complete'} or (operation != 'list' and id not in specs):
            raise ValueError('该连接器或授权方式尚未在云端开放。')
        values = data.get('values')
        if operation == 'connect' and specs[id]['auth'] == 'oauth2':
            raise ValueError('该连接器需要 OAuth 授权。')
        if operation in {'authorize', 'oauth.complete'} and specs[id]['auth'] != 'oauth2':
            raise ValueError('该连接器使用表单凭据。')
        if operation == 'connect' and (not isinstance(values, dict) or set(values) != set(specs[id]['fields'])
                or any(not isinstance(value, str) or not value.strip() or len(value) > 16384 for value in values.values())):
            raise ValueError('请完整填写连接器凭据。')
        async with self.lock:
            if (self.home / '.mt/connectors-draining').exists():
                raise RuntimeError('实例正在排空，请稍后重试。')
            self.managing = True
            try:
                scope = await self.scoped(profile)
                existing = scope.saved(id) if id else None
                if operation != 'list' and existing and (not isinstance(existing, dict) or existing.get('cloud_connector') != id):
                    raise ValueError('MCP name already exists: connector_' + id)
                await self.start()
                authorization = {}
                if operation in {'authorize', 'oauth.complete'}:
                    authorization = await self.call(operation, values, id=id, profile=profile, origin=data.get('origin'), parameters=data.get('parameters'))
                    if operation == 'oauth.complete':
                        scope.update(id, True)
                        authorization = {}
                elif operation == 'connect':
                    await self.call('connect', values, id=id, profile=profile)
                    scope.update(id, True)
                elif operation in {'enable', 'disable'}:
                    status = await self.call('list', profile=profile)
                    if not next(row['configured'] for row in status['connectors'] if row['id'] == id):
                        raise ValueError('请先配置连接器凭据。')
                    scope.update(id, operation == 'enable')
                elif operation == 'disconnect':
                    scope.update(id, False)
                    await self.call('disconnect', id=id, profile=profile)
                    scope.update(id, False, remove=True)
                status = await self.call('list', profile=profile)
                rows = []
                for row in status['connectors']:
                    saved = scope.saved(row['id']) or {}
                    enabled = isinstance(saved, dict) and saved.get('cloud_connector') == row['id'] and saved.get('enabled') is True
                    rows.append({**row, 'enabled': enabled, 'connected': row['configured'] and enabled})
                return {'connectors': rows, **authorization}
            finally:
                self.managing = False

    def busy(self):
        if self.managing:
            return True
        if not self.process or self.process.returncode is not None:
            return False
        try:
            state = json.loads((self.home / '.mt/connectors-active.json').read_text())
            return state.get('pid') == self.process.pid and state.get('active', 0) > 0
        except (OSError, ValueError):
            return False

    async def close(self):
        process, self.process = self.process, None
        if process and process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(process.wait(), 8)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
