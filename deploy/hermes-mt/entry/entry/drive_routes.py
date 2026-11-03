"""Cloud drive operations: browser-bound account credentials, bounded files, scoped tool relay."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import aiohttp
from aiohttp import web

from .drive_worker import DriveWorker

MAX_FILE = 512 * 1024 * 1024
PART = 8 * 1024 * 1024
INSTANCE = '/api/plugins/cloud-drive/internal/'
log = logging.getLogger('entry.drive')


def filename(value):
    if not isinstance(value, str) or not value or len(value) > 255 or value in {'.', '..'} or re.search(r'[\\/:\x00-\x1f\x7f]', value):
        raise web.HTTPBadRequest(text='文件名无效。')
    return value


def failure(code, status='failed'):
    return {'protocol': 'uniwork.drive-result.v1', 'ok': False, 'status': status, 'code': code}


def json_errors(function):
    from functools import wraps
    @wraps(function)
    async def run(self, request):
        try:
            return await function(self, request)
        except web.HTTPException as error:
            return web.json_response({'error': error.text}, status=error.status,
                                     headers={'Cache-Control': 'no-store'})
        except (ValueError, KeyError, TypeError):
            return web.json_response({'error': '网盘参数无效。'}, status=400)
    return run


@dataclass
class Operation:
    identity: object = field(repr=False)
    directory: Path
    expires: float
    progress: dict = field(default_factory=dict)
    result: object = None
    task: asyncio.Task | None = field(default=None, repr=False)
    source: Path | None = None
    expected: int = 0
    written: int = 0
    file: Path | None = None
    delivered: bool = False
    writing: bool = False
    dispatched: bool = False


class DriveRoutes:
    def __init__(self, entry, worker=None):
        self.entry = entry
        self.worker = worker or DriveWorker()
        self.operations: dict[str, Operation] = {}
        self.grants: dict[str, tuple[object, asyncio.Task]] = {}
        self.limit = asyncio.Semaphore(4)
        self.reaper = None
        self.last_purge = 0

    async def identity(self, request):
        identity = await self.entry._require_maas(request)
        if not re.fullmatch(r'1\d{10}', identity.phone):
            raise web.HTTPConflict(text='请退出并重新短信登录一次，以启用个人云盘。')
        return identity

    def reserve(self, operation, size):
        if sum(op.expected for op in self.operations.values() if op is not operation) + size > 2 * 1024 * 1024 * 1024:
            raise web.HTTPTooManyRequests(text='文件传输空间已占满，请等待完成。')
        operation.expected = size

    async def authorize(self, identity):
        await self.entry.share_routes.authorize(identity)

    async def instance(self, identity, path, data=None, *, method='POST', stream=None, params=None):
        await self.authorize(identity)
        tenant = await self.entry._tenant_for(await self.entry.store.get_session(identity.session_sid))
        headers = {'Host': tenant.host_header or f'127.0.0.1:{self.entry.s.hermes_port}',
                   'X-Hermes-Session-Token': tenant.token}
        if tenant.traffic_token:
            headers['cube-traffic-access-token'] = tenant.traffic_token
        origin = tenant.origin or f'{tenant.ip}:{self.entry.s.forward_port}'
        response = await self.entry.http.request(method, f'http://{origin}{INSTANCE}{path}',
            headers=headers, json=data if stream is None else None, data=stream, params=params,
            allow_redirects=False, timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=120))
        if response.status != 200:
            response.release()
            raise web.HTTPConflict(text='实例网盘能力不可用、任务已结束或权限已关闭，请更新模板或检查设置。')
        return response

    async def instance_json(self, identity, path, data):
        async with await self.instance(identity, path, data) as response:
            return await response.json()

    def new(self, identity, key=None):
        if not self.reaper:
            self.reaper = asyncio.create_task(self._reap())
        key = key or secrets.token_hex(24)
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', key) or key in self.operations:
            raise web.HTTPConflict(text='重复或无效的传输标识。')
        if len(self.operations) >= 128 or sum(op.identity.login_id == identity.login_id for op in self.operations.values()) >= 16:
            raise web.HTTPTooManyRequests(text='网盘操作过多，请等待完成。')
        directory = self.worker.root / secrets.token_hex(24)
        directory.mkdir(mode=0o700)
        operation = Operation(identity, directory, min(identity.expires_at / 1000, time.time() + 1800))
        self.operations[key] = operation
        return key, operation

    def owned(self, identity, key):
        operation = self.operations.get(key)
        if not operation or operation.identity.login_id != identity.login_id or operation.identity.user_id != identity.user_id or operation.expires <= time.time():
            raise web.HTTPNotFound(text='操作已失效。')
        return operation

    async def receipt(self, key, operation, result):
        async with self.entry.database.acquire() as connection:
            await connection.execute('''INSERT INTO cloud_drive_operations(operation_id,user_id,login_id,result)
                VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(user_id,operation_id) DO UPDATE
                SET result=EXCLUDED.result,updated_at=now()''', key, operation.identity.user_id,
                operation.identity.login_id, json.dumps(result))

    async def fresh(self, identity, key):
        if key is not None:
            if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', key):
                raise web.HTTPBadRequest(text='操作标识无效。')
            async with self.entry.database.acquire() as connection:
                exists = await connection.fetchval('SELECT 1 FROM cloud_drive_operations WHERE user_id=$1 AND operation_id=$2', identity.user_id, key)
            if exists:
                raise web.HTTPConflict(text='该操作已有记录，请先查询状态并核对结果，不要重复发送。')

    def launch(self, key, operation, action, *, writing=False):
        operation.writing = writing
        async def run():
            try:
                async with self.limit:
                    await self.authorize(operation.identity)
                    # A durable unknown receipt is committed BEFORE any remote write can happen.
                    await self.receipt(key, operation, failure('ENTRY_RESTARTED', 'outcome_unknown'))
                    operation.result = await action()
                    await self.receipt(key, operation, operation.result)
            except asyncio.CancelledError:
                operation.result = failure('CANCELLED', 'outcome_unknown') if writing else {'status': 'cancelled'}
            except Exception:
                operation.result = failure('OPERATION_UNCONFIRMED', 'outcome_unknown')
        operation.task = asyncio.create_task(run())

    @json_errors
    async def handle(self, request):
        identity = await self.identity(request)
        data = await request.json()
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text='网盘参数无效。')
        handlers = {'grant': self.grant, 'ready': self.ready, 'status': self.status,
                    'cancel': self.cancel, 'upload-start': self.upload_start,
                    'upload-finish': self.upload_finish, 'request': self.request,
                    'transfer': self.begin_transfer}
        handler = handlers.get(request.match_info['operation'])
        if handler is None:
            raise web.HTTPNotFound()
        return web.json_response(await handler(identity, data), headers={'Cache-Control': 'no-store'})

    async def ready(self, identity, data):
        value = await self.instance_json(identity, 'ready', {})
        if value['ready'] and data.get('probe'):
            probe = await self.worker.call('request', identity=identity,
                request={'route': '/assets?space_id=personal&parent_asset_id=0&page_no=1&page_size=1'})
            value['ready'] = isinstance(probe, dict) and isinstance(probe.get('items'), list)
        return value

    async def status(self, identity, data):
        key = data['id']
        if key not in self.operations:
            async with self.entry.database.acquire() as connection:
                saved = await connection.fetchval('SELECT result FROM cloud_drive_operations WHERE operation_id=$1 AND user_id=$2', key, identity.user_id)
            if saved:
                return {'result': json.loads(saved), 'done': True}
        operation = self.owned(identity, key)
        done = operation.task is not None and operation.task.done()
        value = {'progress': operation.progress, 'result': operation.result, 'done': done}
        if done and not operation.file:
            shutil.rmtree(operation.directory, ignore_errors=True)
            self.operations.pop(key, None)
        return value

    async def cancel(self, identity, data):
        operation = self.owned(identity, data['id'])
        if operation.task and not operation.task.done():
            operation.result = failure('CANCELLED', 'outcome_unknown') if operation.writing else {'status': 'cancelled'}
            operation.task.cancel()
        elif operation.task is None:
            operation.result = {'status': 'cancelled'}
            operation.expires = 0
        return {'ok': True}

    async def upload_start(self, identity, data):
        name, size = filename(data['name']), data['size']
        if not isinstance(size, int) or not 0 <= size <= MAX_FILE:
            raise web.HTTPBadRequest(text='文件超过上传大小限制。')
        await self.fresh(identity, data['id'])
        key, operation = self.new(identity, data['id'])
        try:
            self.reserve(operation, size)
            operation.source = operation.directory / name
            operation.source.touch(mode=0o600)
        except BaseException:
            self.operations.pop(key, None)
            shutil.rmtree(operation.directory, ignore_errors=True)
            raise
        return {'id': key}

    async def upload_finish(self, identity, data):
        operation = self.owned(identity, data['id'])
        if operation.task or not operation.source or operation.written != operation.expected:
            raise web.HTTPConflict(text='上传内容不完整或已提交。')
        transfer = {'id': data['id'], 'operation': 'upload', 'parentAssetId': data['parentAssetId']}
        self.launch(data['id'], operation, lambda: self.transfer(operation, transfer), writing=True)
        return {'id': data['id']}

    async def request(self, identity, data):
        request = data['request']
        if not isinstance(request, dict) or not isinstance(request.get('route'), str):
            raise web.HTTPBadRequest(text='网盘请求无效。')
        await self.fresh(identity, data.get('id'))
        key, operation = self.new(identity, data.get('id'))
        self.launch(key, operation, lambda: self.worker.call('request', identity=identity,
            request=request, progress=operation.progress.update), writing=request.get('method', 'GET') != 'GET')
        return {'id': key}

    async def begin_transfer(self, identity, data):
        request = data['request']
        if not isinstance(request, dict) or request.get('operation') not in {'upload', 'download', 'preview'}:
            raise web.HTTPBadRequest(text='文件传输请求无效。')
        await self.fresh(identity, data.get('id'))
        key, operation = self.new(identity, data.get('id'))
        self.launch(key, operation, lambda: self.transfer(operation, {**request, 'id': key}), writing=request['operation'] == 'upload')
        return {'id': key}

    @json_errors
    async def part(self, request):
        identity = await self.identity(request)
        operation = self.owned(identity, request.match_info['id'])
        if operation.task or not operation.source or int(request.headers.get('X-Drive-Offset', request.query.get('offset', '-1'))) != operation.written:
            raise web.HTTPConflict(text='上传分片位置不匹配。')
        total = 0
        # Per-operation in-flight lock also prevents duplicate concurrent offsets.
        if operation.progress.get('receiving'):
            raise web.HTTPConflict(text='上传分片正在接收。')
        operation.progress['receiving'] = True
        before = operation.written
        try:
            with operation.source.open('ab') as output:
                async for chunk in request.content.iter_chunked(65536):
                    total += len(chunk)
                    if total > PART or before + total > operation.expected:
                        raise web.HTTPRequestEntityTooLarge(max_size=PART, actual_size=total)
                    output.write(chunk)
            operation.written += total
            return web.json_response({'completed': operation.written})
        except BaseException:
            with operation.source.open('r+b') as output:
                output.truncate(before)
            raise
        finally:
            operation.progress.pop('receiving', None)

    async def export(self, operation, source, grant=None):
        identity = operation.identity
        if source.get('profile', 'default') != 'default' or source.get('connectionId', 'local') != 'local':
            raise web.HTTPBadRequest(text='文件不属于当前云端实例。')
        value = source['value']
        if value.startswith('file:'):
            from urllib.parse import urlsplit, unquote
            parsed = urlsplit(value)
            if parsed.netloc not in {'', 'localhost'} or parsed.query or parsed.fragment:
                raise web.HTTPBadRequest(text='文件引用无效。')
            value = unquote(parsed.path)
        reference = await self.instance_json(identity, 'export', {
            'path': value, **({'grant': grant} if grant else {'sessionId': source['sessionId']})})
        target = operation.directory / filename(reference['name'])
        self.reserve(operation, reference['size'])
        if reference['size'] > MAX_FILE:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE, actual_size=reference['size'])
        total = 0
        async with await self.instance(identity, 'file/' + reference['handle'], method='GET') as response:
            with target.open('xb') as output:
                async for chunk in response.content.iter_chunked(65536):
                    total += len(chunk)
                    if total > MAX_FILE:
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE, actual_size=total)
                    output.write(chunk)
        if total != reference['size']:
            raise web.HTTPConflict(text='实例文件读取不完整。')
        operation.source = target

    async def transfer(self, operation, request, grant=None):
        if request['operation'] == 'upload':
            if 'artifact' in request:
                await self.export(operation, request['artifact'], grant)
            if not operation.source:
                raise web.HTTPBadRequest(text='缺少上传文件。')
            request = {k: v for k, v in request.items() if k != 'artifact'}
            target = operation.source
        else:
            # Entry enforces a per-file limit even if the remote omits a content length.
            name = filename(request['name'])
            target = operation.directory / name
            self.reserve(operation, 20 * 1024 * 1024 if request['operation'] == 'preview' else MAX_FILE)
            if request.get('size') is not None and request['size'] > MAX_FILE:
                return failure('FILE_TOO_LARGE')
        operation.dispatched = True
        result = await self.worker.call('transfer', identity=operation.identity, request=request,
                                       file=str(target), progress=operation.progress.update)
        if result.get('status') != 'succeeded':
            return result
        if result.get('preview'):
            target = Path(result['preview']['path'])
        downloaded_size = target.stat().st_size
        if not target.resolve().is_relative_to(self.worker.root) or downloaded_size > MAX_FILE:
            return failure('FILE_TOO_LARGE')
        if request['operation'] == 'preview' or grant and request['operation'] == 'download':
            async def content():
                with target.open('rb') as source:
                    while chunk := source.read(65536):
                        yield chunk
            try:
                async with await self.instance(operation.identity, 'receive', stream=content(), params={'name': filename(target.name), **({'grant': grant} if grant else {})}) as response:
                    saved = await response.json()
            finally:
                if result.get('workerPreviewOwner') is not None:
                    try:
                        await self.worker.call('release-preview', identity=operation.identity, owner=result['workerPreviewOwner'])
                    except web.HTTPException:
                        log.warning('Drive preview cleanup deferred until worker reset')
            if saved['size'] != downloaded_size:
                return failure('DOWNLOAD_INCOMPLETE')
            target.unlink(missing_ok=True)
            if request['operation'] == 'preview':
                return {'status': 'succeeded', 'name': target.name, 'preview': {'kind': 'file', 'path': saved['path']}}
            return {'ok': True, 'status': 'succeeded', 'path': saved['path'], 'name': target.name, 'size': saved['size']}
        if request['operation'] == 'download':
            operation.file = target
            self.reserve(operation, downloaded_size)
            operation.expires = min(operation.expires, time.time() + 300)
            return {'status': 'succeeded', 'name': target.name, 'readyForBrowser': True}
        return result

    async def download(self, request):
        session = await self.entry._require(request)
        operation = self.operations.get(request.match_info['id'])
        if not operation or operation.identity.session_sid != session.sid or operation.expires <= time.time() or operation.delivered or not operation.file:
            raise web.HTTPNotFound()
        await self.authorize(operation.identity)
        operation.delivered = True
        response = web.StreamResponse(headers={'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'Content-Length': str(operation.file.stat().st_size), 'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': "attachment; filename*=UTF-8''" + quote(operation.file.name, safe='')})
        await response.prepare(request)
        try:
            with operation.file.open('rb') as source:
                checked = 0
                while chunk := source.read(65536):
                    if operation.expires <= time.time():
                        raise ConnectionResetError('Download authorization expired')
                    if time.monotonic() - checked > 1:
                        await self.authorize(operation.identity)
                        checked = time.monotonic()
                    await response.write(chunk)
            await response.write_eof()
        finally:
            operation.file.unlink(missing_ok=True)
            self.operations.pop(request.match_info['id'], None)
            shutil.rmtree(operation.directory, ignore_errors=True)
        return response

    async def grant(self, identity, data):
        if len(self.grants) >= 128 or sum(value[0].login_id == identity.login_id for value in self.grants.values()) >= 8:
            raise web.HTTPTooManyRequests()
        key = secrets.token_hex(24)
        expires = min(time.time() + 900, identity.expires_at / 1000)
        await self.instance_json(identity, 'grant', {'grant': key, 'sessionId': data['sessionId'], 'expires': expires})
        task = asyncio.create_task(self.relay(identity, key, expires))
        self.grants[key] = (identity, task)
        return {'cloud_drive': key}

    async def relay(self, identity, grant, expires):
        async def check():
            await self.authorize(identity)
            await self.instance_json(identity, 'check', {'grant': grant})
        try:
            while time.time() < expires:
                response = await self.instance_json(identity, 'poll', {'grant': grant})
                if response.get('disabled'):
                    return
                if response.get('waiting'):
                    await asyncio.sleep(.4)
                    continue
                await check()
                key, operation = self.new(identity)
                async def execute():
                    name = response['name']
                    operation.writing = name in {'upload', 'make_dir', 'rename_file', 'move_files', 'delete_files', 'restore_files'}
                    args = await self.worker.call('parse', identity=identity, name=name, args=response['args'])
                    if args.get('ok') is False:
                        return args
                    if name == 'upload':
                        return await self.transfer(operation, {'id': key, 'operation': 'upload', 'parentAssetId': args.get('parent_asset_id', '0'),
                            'artifact': {'value': args['source_path']}}, grant)
                    if name == 'download':
                        title = args.get('name') or (await self.worker.call('name', identity=identity, assetId=args['asset_id']))['name']
                        return await self.transfer(operation, {'id': key, 'operation': 'download', 'assetId': args['asset_id'], 'name': filename(title)}, grant)
                    operation.dispatched = True
                    return await self.worker.call('action', identity=identity, name=name, args=args)
                action = asyncio.create_task(execute())
                try:
                    while not action.done():
                        await asyncio.sleep(.5)
                        await check()
                    result = await action
                except asyncio.CancelledError:
                    action.cancel()
                    await asyncio.gather(action, return_exceptions=True)
                    raise
                except Exception:
                    action.cancel()
                    await asyncio.gather(action, return_exceptions=True)
                    result = failure('DRIVE_OPERATION_REJECTED', 'outcome_unknown' if operation.writing and operation.dispatched else 'failed')
                finally:
                    shutil.rmtree(operation.directory, ignore_errors=True)
                    self.operations.pop(key, None)
                await self.instance_json(identity, 'result', {'grant': grant, 'requestId': response['requestId'], 'result': result})
        except (web.HTTPException, aiohttp.ClientError, asyncio.TimeoutError):
            return
        finally:
            self.grants.pop(grant, None)

    async def _reap(self):
        while True:
            await asyncio.sleep(10)
            for key, operation in list(self.operations.items()):
                if operation.expires <= time.time():
                    if operation.task and not operation.task.done():
                        operation.task.cancel()
                        await asyncio.gather(operation.task, return_exceptions=True)
                    shutil.rmtree(operation.directory, ignore_errors=True)
                    self.operations.pop(key, None)
            if time.time() - self.last_purge > 3600:
                self.last_purge = time.time()
                from .db import DatabaseUnavailable
                try:
                    async with self.entry.database.acquire() as connection:
                        await connection.execute("DELETE FROM cloud_drive_operations WHERE updated_at < now() - interval '7 days'")
                except DatabaseUnavailable:
                    log.warning('Drive receipt retention deferred: database unavailable')

    async def logout(self, sid):
        await self.worker.logout(sid)
        for key, (identity, task) in list(self.grants.items()):
            if identity.session_sid == sid:
                task.cancel()
        for operation in self.operations.values():
            if operation.identity.session_sid == sid:
                operation.expires = 0
                if operation.task:
                    operation.task.cancel()

    async def close(self):
        tasks = [op.task for op in self.operations.values() if op.task] + [v[1] for v in self.grants.values()]
        if self.reaper:
            tasks.append(self.reaper)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.worker.close()
