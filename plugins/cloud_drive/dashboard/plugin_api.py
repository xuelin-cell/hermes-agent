"""Instance-local MCP and Entry-pulled requests; no account credentials enter the instance."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

router = APIRouter()
MAX_FILE = 512 * 1024 * 1024
TOOLS = json.loads((Path(__file__).parents[1] / 'tools.json').read_text())


def config():
    from hermes_cli.config import load_config
    value = load_config()
    if not value.get('cloud_drive', {}).get('enabled'):
        raise HTTPException(404, 'Cloud drive is not enabled')
    return value


def allowed():
    entry = config().get('mcp_servers', {}).get('UniWork-Drive', {})
    return entry.get('uniwork_managed') == 'uniwork.desktop.drive.v1' and str(entry.get('enabled', True)).lower() not in {'false', '0', 'off', 'no'}


def home_key():
    from hermes_constants import get_hermes_home
    return str(get_hermes_home().resolve())


@dataclass
class Grant:
    session: str
    expires: float
    home: str
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=4))
    pending: dict = field(default_factory=dict)
    started: bool = False


@dataclass
class Pending:
    future: asyncio.Future
    writing: bool


def reject_pending(value, code):
    for pending in value.pending.values():
        if not pending.future.done():
            pending.future.set_result({'ok': False, 'status': 'outcome_unknown' if pending.writing else 'failed', 'code': code})


_grants: dict[str, Grant] = {}
_exports: dict[str, tuple[str, Path, float, int]] = {}


@router.post('/internal/ready')
async def ready():
    return {'ready': allowed()}


def grant_for(key):
    from tools.execution_metadata import active_for, completed_for
    _expire()
    value = _grants.get(key)
    if not value or value.home != home_key():
        raise HTTPException(403, 'Invalid execution capability')
    live = active_for(key, value.session)
    if live:
        value.started = True
    if not live and (value.started or completed_for(key, value.session)):
        reject_pending(value, 'AUTH_REQUIRED')
        _grants.pop(key, None)
        raise HTTPException(410, 'Execution finished')
    return value, live


def _expire():
    import shutil
    for key, (_, target, expires, _) in list(_exports.items()):
        if expires <= time.time():
            shutil.rmtree(target.parent, ignore_errors=True)
            _exports.pop(key, None)
    for item, value in list(_grants.items()):
        if value.expires <= time.time():
            reject_pending(value, 'AUTH_REQUIRED')
            _grants.pop(item, None)



@router.post('/internal/grant')
async def prepare(request: Request):
    config()
    _expire()
    data = await request.json()
    key, session = data['grant'], data['sessionId']
    if not isinstance(key, str) or len(key) != 48 or not isinstance(session, str) or len(session) > 160:
        raise HTTPException(400, 'Invalid grant')
    from tui_gateway import server
    value = server._sessions.get(session)
    if (not value or value.get('profile_name', 'default') not in {'', 'default', None}
            or value.get('profile_home') and str(Path(value['profile_home']).resolve()) != home_key()):
        raise HTTPException(404, 'Session not found')
    if len(_grants) >= 128:
        raise HTTPException(429, 'Too many grants')
    _grants[key] = Grant(session, min(float(data['expires']), time.time() + 900), home_key())
    return {'ok': True}


@router.post('/internal/poll')
async def poll(request: Request):
    data = await request.json()
    value, live = grant_for(data['grant'])
    if not allowed():
        reject_pending(value, 'DRIVE_ACCESS_DISABLED')
        return {'disabled': True}
    if not live:
        return {'waiting': True}
    try:
        return await asyncio.wait_for(value.queue.get(), 2)
    except asyncio.TimeoutError:
        return {'waiting': True}


@router.post('/internal/check')
async def check(request: Request):
    value, live = grant_for((await request.json())['grant'])
    if not live or not allowed():
        raise HTTPException(403, 'DRIVE_ACCESS_DISABLED')
    return {'ok': True}


@router.post('/internal/result')
async def finish(request: Request):
    data = await request.json()
    value, _ = grant_for(data['grant'])
    pending = value.pending.pop(data['requestId'], None)
    if pending and not pending.future.done():
        pending.future.set_result(data['result'])
    return {'ok': True}


@router.post('/mcp')
async def mcp(request: Request):
    config()
    if int(request.headers.get('content-length', '0')) > 256 * 1024:
        raise HTTPException(413)
    data = await request.json()
    if not isinstance(data, dict) or data.get('jsonrpc') != '2.0':
        raise HTTPException(400, 'Invalid MCP request')
    if 'id' not in data:
        from fastapi.responses import Response
        return Response(status_code=202)
    method, params = data.get('method'), data.get('params') or {}
    result = {}
    if method == 'initialize':
        result = {'protocolVersion': params.get('protocolVersion', '2025-03-26'),
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'UniWork-Drive', 'version': '1.0.0'}}
    elif method == 'tools/list':
        result = {'tools': TOOLS if allowed() else []}
    elif method == 'tools/call':
        key = (params.get('_meta') or {}).get('hermes.execution', {}).get('cloud_drive', '')
        name, args = params.get('name'), params.get('arguments', {})
        try:
            value, live = grant_for(key)
            if not live or not allowed():
                raise HTTPException(403, 'DRIVE_ACCESS_DISABLED')
            schema = next((tool for tool in TOOLS if tool['name'] == name), None)
            if not schema or not isinstance(args, dict) or len(value.pending) >= 4:
                raise HTTPException(400, 'Invalid tool arguments')
            request_id = secrets.token_hex(16)
            future = asyncio.get_running_loop().create_future()
            value.pending[request_id] = Pending(future, schema.get('annotations', {}).get('readOnlyHint') is not True)
            try:
                await value.queue.put({'requestId': request_id, 'name': name, 'args': args})
                reply = await asyncio.wait_for(future, min(720, value.expires - time.time()))
            finally:
                value.pending.pop(request_id, None)
        except (HTTPException, asyncio.TimeoutError) as error:
            reply = {'ok': False, 'status': 'outcome_unknown' if isinstance(error, asyncio.TimeoutError) else 'failed',
                     'code': 'DRIVE_ACCESS_DISABLED' if not allowed() else 'INVALID_ARGUMENT' if getattr(error, 'status_code', None) == 400 else 'AUTH_REQUIRED',
                     'message': '请重新发起任务；如未授权，请在设置 → 安全 → 审批开启允许智能体操控资料库。手动管理仍可用；不要通过其他 MCP、HTTP 或终端绕过此权限。百度网盘等其他连接器不受影响。'}
        result = {'content': [{'type': 'text', 'text': json.dumps(reply, ensure_ascii=False)}],
                  'isError': isinstance(reply, dict) and reply.get('ok') is False and reply.get('status') != 'outcome_unknown'}
    elif method != 'ping':
        return {'jsonrpc': '2.0', 'id': data['id'], 'error': {'code': -32601, 'message': 'Unknown method'}}
    return {'jsonrpc': '2.0', 'id': data['id'], 'result': result}


def workspace():
    return Path(config().get('terminal', {}).get('cwd', '')).resolve(strict=True)


def safe_name(name):
    if not isinstance(name, str) or not name or len(name) > 255 or name in {'.', '..'} or any(c in name for c in '/\\:') or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise HTTPException(400, 'Invalid filename')
    return name


@router.post('/internal/export')
async def export(request: Request):
    data = await request.json()
    config()
    # Page artifacts carry a durable session; tool sources use the live grant session.
    if data.get('grant'):
        value, _ = grant_for(data['grant'])
        if not allowed():
            raise HTTPException(403, 'DRIVE_ACCESS_DISABLED')
    elif data.get('sessionId'):
        from hermes_cli.web_routers.sessions import get_session_detail
        await get_session_detail(data['sessionId'], None)
    else:
        raise HTTPException(400, 'Session required')
    _expire()
    if len(_exports) >= 8:
        raise HTTPException(429, 'Too many file exports')
    root = workspace()
    source = Path(data['path'])
    source = (source if source.is_absolute() else root / source).resolve(strict=True)
    from hermes_cli.web_routers.files import _is_sensitive_path
    if not source.is_relative_to(root) or _is_sensitive_path(source) or not source.is_file() or source.stat().st_size > MAX_FILE:
        raise HTTPException(403, 'File unavailable')
    expected = source.stat().st_size
    if sum(value[3] for value in _exports.values()) + expected > MAX_FILE:
        raise HTTPException(429, 'Export space full')
    import tempfile
    directory = Path(tempfile.mkdtemp(prefix='cloud-drive-export-'))
    target = directory / safe_name(source.name)
    key = secrets.token_hex(24)
    _exports[key] = (home_key(), target, time.time() + 300, expected)
    asyncio.get_running_loop().call_later(301, _expire)
    def snapshot():
        import shutil
        import stat
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = source.relative_to(root).parts
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        finally:
            os.close(descriptor)
        with os.fdopen(fd, 'rb') as original, target.open('xb') as output:
            if not stat.S_ISREG(os.fstat(original.fileno()).st_mode):
                raise HTTPException(403, 'Not a regular file')
            before = os.fstat(original.fileno())
            total = 0
            while chunk := original.read(65536):
                total += len(chunk)
                if total > MAX_FILE:
                    raise HTTPException(413)
                output.write(chunk)
            after = os.fstat(original.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise HTTPException(409, 'File changed')
    try:
        await asyncio.to_thread(snapshot)
    except BaseException:
        import shutil
        _exports.pop(key, None)
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return {'handle': key, 'name': source.name, 'size': target.stat().st_size}


@router.get('/internal/file/{handle}')
async def exported(handle: str):
    config()
    record = _exports.pop(handle, None)
    if not record or record[0] != home_key() or record[2] <= time.time():
        raise HTTPException(404)
    from starlette.background import BackgroundTask
    import shutil
    return FileResponse(record[1], background=BackgroundTask(shutil.rmtree, record[1].parent, True))


@router.post('/internal/receive')
async def receive(request: Request, name: str, grant: str | None = None):
    config()
    owner = None
    if grant:
        owner, live = grant_for(grant)
        if not live or not allowed():
            raise HTTPException(403)
    import tempfile
    from hermes_cli.web_routers.files import _is_sensitive_filename
    safe_name(name)
    if _is_sensitive_filename(name):
        raise HTTPException(403, 'File unavailable')
    root = workspace()
    directory = Path(tempfile.mkdtemp(prefix='cloud-drive-', dir=root))
    temporary = directory / '.partial'
    total = 0
    try:
        with temporary.open('xb') as output:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_FILE:
                    raise HTTPException(413)
                await asyncio.to_thread(output.write, chunk)
        declared = request.headers.get('content-length')
        if declared and total != int(declared):
            raise HTTPException(409, 'Incomplete file')
        target = directory / name
        if grant:
            _, live = grant_for(grant)
            if not live or not allowed():
                raise HTTPException(403)
        await asyncio.to_thread(temporary.rename, target)
        if owner:
            from tui_gateway import server
            from plugins.conversation_share.origins import current
            session = server._sessions.get(owner.session) or {}
            if session.get('session_key'):
                current().mark_uploaded(session['session_key'])
        return {'path': str(target), 'size': total}
    except BaseException:
        import shutil
        shutil.rmtree(directory, ignore_errors=True)
        raise
