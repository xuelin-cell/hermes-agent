"""One lazy OpenConnector process per instance; credentials never cross the management response."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import tempfile
from pathlib import Path

import aiohttp
import yaml


class Connectors:
    def __init__(self, home: Path, python: str, *, worker=None, node=None, port=9122):
        self.home, self.python = home, python
        self.worker = worker or str(Path(__file__).parent / 'connectors/src/server/storage/worker.mjs')
        self.node, self.port = node, port
        self.process = None
        self.lock = asyncio.Lock()
        self.values = None
        self.managing = False

    @property
    def specs(self):
        return json.loads((Path(self.worker).parents[3] / 'contract.json').read_text())

    def config(self):
        file = self.home / 'config.yaml'
        if file.is_symlink():
            raise ValueError('Invalid connector configuration')
        raw = file.read_text() if file.exists() else ''
        try:
            config = yaml.safe_load(raw) or {}
        except yaml.YAMLError:
            raise ValueError('Invalid connector configuration') from None
        if not isinstance(config, dict) or not isinstance(config.get('mcp_servers', {}), dict):
            raise ValueError('Invalid connector configuration')
        return file, raw, config

    @staticmethod
    def atomic(file, data):
        fd, temporary = tempfile.mkstemp(dir=file.parent, prefix='.connector-')
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def credentials(self):
        directory = self.home / 'open-connector'
        if directory.is_symlink():
            raise ValueError('Invalid connector directory')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        file = directory / 'secrets.json'
        if file.is_symlink():
            raise ValueError('Invalid connector key file')
        if file.exists():
            values = json.loads(file.read_text())
            if not isinstance(values, dict) or any(not isinstance(values.get(key), str) or len(values[key]) != 64 for key in ('encryption', 'admin', 'runtime')):
                raise ValueError('Invalid connector keys')
            file.chmod(0o600)
            return values
        if (directory / 'connect.sqlite').exists():
            raise ValueError('Connector key missing; restore the original key before starting')
        values = {key: secrets.token_hex(32) for key in ('encryption', 'admin', 'runtime')}
        self.atomic(file, json.dumps(values))
        return values

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
            OOMOL_CONNECT_PORT=str(self.port), NODE_ENV='production')
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

    def saved(self, id):
        _, _, config = self.config()
        return config.get('mcp_servers', {}).get('connector_' + id)

    def update(self, id, enabled, *, remove=False):
        file, raw, config = self.config()
        servers = config.setdefault('mcp_servers', {})
        name = 'connector_' + id
        existing = servers.get(name)
        if existing and (not isinstance(existing, dict) or existing.get('cloud_connector') != id):
            raise ValueError('MCP name already exists: ' + name)
        if remove:
            servers.pop(name, None)
        else:
            servers[name] = {'cloud_connector': id, 'enabled': enabled,
                'url': f'http://127.0.0.1:{self.port}/mcp/{id}',
                'headers': {'Authorization': 'Bearer ' + self.values['runtime']}, 'timeout': 600}
        if (file.read_text() if file.exists() else '') != raw:
            raise RuntimeError('Configuration changed; refresh and retry')
        self.atomic(file, yaml.safe_dump(config, allow_unicode=True, sort_keys=False))

    async def restore(self):
        async with self.lock:
            (self.home / '.mt/connectors-draining').unlink(missing_ok=True)
            # No runtime is needed for a Home with no managed connector entries.
            _, _, config = self.config()
            if not any(isinstance(value, dict) and value.get('cloud_connector') and value.get('enabled') is True
                    for value in config.get('mcp_servers', {}).values()):
                return
            for id in self.specs:
                saved = self.saved(id)
                if isinstance(saved, dict) and saved.get('cloud_connector') == id and saved.get('enabled') is True:
                    await self.start()
                    self.update(id, True)

    async def recover(self):
        if not self.process or self.process.returncode is not None:
            await self.restore()

    def draining(self, enabled):
        file = self.home / '.mt/connectors-draining'
        if enabled:
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.atomic(file, 'draining')
        else:
            file.unlink(missing_ok=True)

    async def request(self, data):
        if not isinstance(data, dict) or data.get('profile', 'default') != 'default':
            raise ValueError('云端连接器只支持默认档案。')
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
                existing = self.saved(id) if id else None
                if operation != 'list' and existing and (not isinstance(existing, dict) or existing.get('cloud_connector') != id):
                    raise ValueError('MCP name already exists: connector_' + id)
                await self.start()
                authorization = {}
                if operation in {'authorize', 'oauth.complete'}:
                    authorization = await self.call(operation, values, id=id, origin=data.get('origin'), parameters=data.get('parameters'))
                    if operation == 'oauth.complete':
                        self.update(id, True)
                        authorization = {}
                elif operation == 'connect':
                    await self.call('connect', values, id=id)
                    self.update(id, True)
                elif operation in {'enable', 'disable'}:
                    status = await self.call('list')
                    if not next(row['configured'] for row in status['connectors'] if row['id'] == id):
                        raise ValueError('请先配置连接器凭据。')
                    self.update(id, operation == 'enable')
                elif operation == 'disconnect':
                    self.update(id, False)
                    await self.call('disconnect', id=id)
                    self.update(id, False, remove=True)
                status = await self.call('list')
                rows = []
                for row in status['connectors']:
                    saved = self.saved(row['id']) or {}
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
