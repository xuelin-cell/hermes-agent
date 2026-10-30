"""Cloud-only adapters. Core REST/RPC implementations remain the authority for profiles."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket

from . import cloud, expert_sync, installer, store

router = APIRouter()


@router.get('/catalog')
def catalog():
    try:
        return cloud.describe(cloud.home())
    except installer.KitError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get('/bundled')
def bundled():
    root = cloud.home()
    resources = cloud.resources(root)
    return {'ran': True, 'running': False, 'name': '', 'done': 0, 'total': len(resources),
            'installed': len(store.load_index(root)['plugins']), 'unchanged': 0, 'failed': [], 'error': ''}


@router.get('/experts')
def directory():
    return cloud.directory(cloud.home())


@router.get('/profiles')
async def profiles():
    from hermes_cli.web_routers.profiles import list_profiles_endpoint

    root = cloud.home()
    allowed = {'default', *(row['profile'] for row in cloud.directory(root)['experts'])}
    result = await list_profiles_endpoint()
    return {**result, 'profiles': [row for row in result['profiles'] if row['name'] in allowed]}


@router.get('/profile')
def profile(name: str = 'default'):
    try:
        root = cloud.home()
        cloud.profile_home(root, name)
        if name != 'default':
            entry = next(key for key, value in store.load_index(root)['plugins'].items()
                         if value.get('profile') == name and value.get('kind') == 'expert')
            with cloud._lock, store.scoped_home(root):
                expert_sync.sync_named(root, entry)
        return {'profile': name}
    except installer.KitError as exc:
        raise HTTPException(403, str(exc)) from exc


@router.post('/action')
async def action(data: dict):
    try:
        return await asyncio.to_thread(cloud.action, data)
    except (installer.KitError, OSError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


class ExpertSocket:
    """Validate every RPC profile before handing frames to the real gateway dispatcher."""
    def __init__(self, socket):
        self.socket = socket

    def __getattr__(self, key):
        return getattr(self.socket, key)

    async def receive_text(self):
        while True:
            raw = await self.socket.receive_text()
            try:
                frame = json.loads(raw)
            except ValueError:
                return raw  # Preserve the gateway's parse-error contract.
            if not isinstance(frame, dict) or not isinstance(frame.get('params', {}), dict):
                return raw
            try:
                root = cloud.home()
                if (root / '.mt/connectors-draining').exists():
                    raise installer.KitError('实例正在排空，请稍后重试。')
                from tui_gateway import server

                params = frame.get('params', {})
                profile = params.get('profile') or 'default'
                session = server._sessions.get(params.get('session_id') or params.get('sid'))
                if session is not None:
                    owner = session.get('profile_home')
                    expected = root if not owner else Path(owner)
                    if not params.get('profile'):
                        profile = 'default' if expected == root else expected.name
                        params['profile'] = profile
                        frame['params'] = params
                        raw = json.dumps(frame)
                    if expected != cloud.profile_home(root, profile):
                        raise installer.KitError('会话与专家档案不匹配。')
                cloud.profile_home(root, profile)
                method = str(frame.get('method', ''))
                if method in {'session.create', 'session.resume', 'prompt.submit', 'slash.exec', 'command.dispatch'} and (root / '.mt/kits-active.json').exists():
                    raise installer.KitError('套件正在变更，请完成后再开始对话。')
                if method.startswith(('profiles.create', 'profiles.delete', 'profiles.configure', 'profiles.import')):
                    raise installer.KitError('专家档案由套件管理，请在套件页操作。')
                if profile != 'default' and method.startswith(('cron.', 'schedule.')):
                    raise installer.KitError('云端专家定时任务尚未开放。')
            except installer.KitError as exc:
                await self.socket.send_json({'jsonrpc': '2.0', 'id': frame.get('id'),
                                             'error': {'code': -32602, 'message': str(exc)}})
                continue
            return raw


@router.websocket('/ws')
async def socket(ws: WebSocket):
    from hermes_cli.web_routers.chat_ws import gateway_ws

    await gateway_ws(ExpertSocket(ws))
