"""Per-profile connector configuration, keys, and canonical managed-expert resolution."""
from __future__ import annotations

import json
import os
import secrets
import tempfile
from pathlib import Path
from urllib.parse import quote

import aiohttp
import yaml


def profile_home(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or name.startswith('.') or '/' in name or '\\' in name or len(name) > 160:
        raise ValueError('无效的连接器档案。')
    if name == 'default':
        return root
    directory = root / 'profiles'
    home = directory / name
    if directory.is_symlink() or home.is_symlink() or not home.is_dir() or home.resolve().parent != directory.resolve():
        raise ValueError('专家档案不存在。')
    return home


async def authorize_profile(root, name, token, backend_port):
    home = profile_home(root, name)
    if name != 'default':
        if not token:
            raise ValueError('当前实例未开放专家连接器。')
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.get(f'http://127.0.0.1:{backend_port}/api/plugins/uniwork-kits/cloud/connector-profile',
                    params={'name': name}, headers={'X-Hermes-Session-Token': token}) as response:
                if response.status in (403, 404):
                    raise ValueError('专家未安装、已停用或不属于当前账号。')
                if response.status != 200 or (await response.json()).get('profile') != name:
                    raise RuntimeError('专家档案校验暂不可用。')
    return home


class ConnectorProfile:
    def __init__(self, home, port, profile='default'):
        self.home, self.port, self.profile = home, port, profile
        self.prefix = '' if profile == 'default' else '/profiles/' + quote(profile, safe='')
        self.values = None

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
                'cloud_connector_profile': self.profile,
                'url': f'http://127.0.0.1:{self.port}{self.prefix}/mcp/{id}',
                'headers': {'Authorization': 'Bearer ' + self.values['runtime']}, 'timeout': 600}
        if (file.read_text() if file.exists() else '') != raw:
            raise RuntimeError('Configuration changed; refresh and retry')
        self.atomic(file, yaml.safe_dump(config, allow_unicode=True, sort_keys=False))


    def discard_inherited(self):
        if self.profile == 'default':
            return
        file, _, config = self.config()
        servers = config.get('mcp_servers', {})
        stale = [name for name, entry in servers.items() if isinstance(entry, dict) and entry.get('cloud_connector')
                 and entry.get('cloud_connector_profile') != self.profile]
        if stale:
            for name in stale:
                del servers[name]
            self.atomic(file, yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
