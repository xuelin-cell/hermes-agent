"""Turn-scoped publication queue. Only Entry can exchange requests and results."""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()


def home_key():
    from hermes_constants import get_hermes_home
    return str(get_hermes_home().resolve())


def enabled():
    from hermes_cli.config import load_config
    if not load_config().get('cloud_sharing', {}).get('enabled'):
        raise HTTPException(404, 'Cloud sharing is not enabled')


@dataclass
class Grant:
    session: str
    home: str
    expires: float
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=4))
    pending: dict = field(default_factory=dict)
    started: bool = False


_grants: dict[str, Grant] = {}


def discard(key):
    value = _grants.pop(key, None)
    if value:
        for future in value.pending.values():
            if not future.done():
                future.set_result({'error': '分享授权已结束；若已发起发布，请先在分享面板确认结果。'})


def grant_for(key):
    from tools.execution_metadata import active_for, completed_for
    enabled()
    for expired, value in list(_grants.items()):
        if value.expires <= time.time():
            discard(expired)
    value = _grants.get(key)
    if not value or value.home != home_key():
        raise HTTPException(403, 'Invalid sharing capability')
    live = active_for(key, value.session)
    if completed_for(key, value.session) or not live and value.started:
        discard(key)
        raise HTTPException(410, 'Execution finished')
    value.started |= live
    return value, live


@router.post('/grant')
async def prepare(request: Request):
    enabled()
    data = await request.json()
    key, session = data.get('grant'), data.get('sessionId')
    if not isinstance(key, str) or len(key) != 48 or not isinstance(session, str) or len(session) > 160:
        raise HTTPException(400, 'Invalid grant')
    from tui_gateway import server
    owner = server._sessions.get(session)
    if (not owner or owner.get('profile_name', 'default') not in {'', 'default', None}
            or owner.get('profile_home') and str(Path(owner['profile_home']).resolve()) != home_key()):
        raise HTTPException(404, 'Session not found')
    for expired, value in list(_grants.items()):
        if value.expires <= time.time():
            discard(expired)
    if len(_grants) >= 128 or key in _grants:
        raise HTTPException(429, 'Too many sharing grants')
    _grants[key] = Grant(session, home_key(), min(float(data['expires']), time.time() + 900), asyncio.get_running_loop())
    return {'ok': True}


@router.post('/poll')
async def poll(request: Request):
    value, live = grant_for((await request.json())['grant'])
    if live:
        try:
            return await asyncio.wait_for(value.queue.get(), 2)
        except asyncio.TimeoutError:
            pass
    return {'waiting': True}


@router.post('/check')
async def check(request: Request):
    data = await request.json()
    value, live = grant_for(data['grant'])
    if not live:
        raise HTTPException(403, 'Execution is not active')
    pending = value.pending.get(data.get('requestId'))
    if not pending or pending.done():
        raise HTTPException(410, 'Publication request finished')
    return {'ok': True}


@router.post('/result')
async def finish(request: Request):
    data = await request.json()
    value, _ = grant_for(data['grant'])
    future = value.pending.get(data['requestId'])
    if future and not future.done():
        future.set_result(data['result'])
    return {'ok': True}


@router.post('/revoke')
async def revoke(request: Request):
    key = (await request.json())['grant']
    value = _grants.get(key)
    if value and value.home == home_key():
        discard(key)
    return {'ok': True}


async def enqueue(key, payload):
    value, live = grant_for(key)
    if not live or len(value.pending) >= 4:
        raise RuntimeError('当前回合未获分享授权，请登录后重新发起分享。')
    from tui_gateway import server
    owner = server._sessions.get(value.session) or {}
    # Tools use the durable conversation ID; execution metadata uses the runtime ID.
    session = owner.get('session_key')
    if not session or payload.get('source', {}).get('sessionId') != session:
        raise RuntimeError('产物不属于当前分享回合。')
    request_id = secrets.token_hex(16)
    future = value.loop.create_future()
    value.pending[request_id] = future
    try:
        await value.queue.put({'requestId': request_id, 'payload': payload, 'sessionId': session})
        result = await future
        if result.get('error'):
            raise RuntimeError(result['error'])
        return result
    finally:
        value.pending.pop(request_id, None)


def publish(payload, *, timeout=95):
    from tools.execution_metadata import current_metadata
    key = current_metadata().get('cloud_share')
    value = _grants.get(key)
    if not value or value.home != home_key():
        raise RuntimeError('当前回合未获分享授权，请登录后重新发起分享；不要改用 OSS 或其他上传通道。')
    # Tool handlers execute on a worker thread; the instance HTTP loop owns its queue.
    future = asyncio.run_coroutine_threadsafe(enqueue(key, payload), value.loop)
    try:
        return future.result(timeout=min(timeout, max(.1, value.expires - time.time())))
    finally:
        if not future.done():
            future.cancel()
