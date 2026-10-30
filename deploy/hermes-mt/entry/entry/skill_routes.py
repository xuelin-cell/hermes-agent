"""Cloud skill mutations reuse the instance APIs and acknowledge only durable state."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import re
import logging
import time
from urllib.parse import quote

import aiohttp
from aiohttp import web

log = logging.getLogger('entry.skills')

# A business operation, never an arbitrary authenticated proxy.
MUTATIONS = {
    ('POST', 'api/plugins/uniwork-kits/cloud/action'): False,
    ('POST', 'api/skills/market/install'): False,
    ('POST', 'api/skills/hub/install'): True,
    ('POST', 'api/skills/hub/uninstall'): True,
    ('POST', 'api/skills/hub/update'): True,
    ('PUT', 'api/skills/toggle'): False,
}


class SkillRejected(RuntimeError):
    pass


@dataclass
class SkillOperation:
    user: str
    sid: str = field(repr=False)
    method: str
    path: str
    body: dict = field(repr=False)
    phase: str = 'changing'
    result: dict | None = None
    error: str = ''
    tenant: object = None
    task: asyncio.Task | None = None
    created: float = field(default_factory=time.monotonic)


class SkillRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.operations = {}

    @property
    def active_users(self):
        return {op.user for op in self.operations.values() if op.task and not op.task.done()}

    async def handle(self, request):
        session = await self.entry._require(request)
        try:
            data = await request.json()
            key = data['id']
            if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', key):
                raise ValueError()
            action = request.match_info['operation']
            operation = self.operations.get((session.user_id, key))
            if action == 'start':
                method, path, body = data['method'], data['path'], data.get('body', {})
                if (method, path) not in MUTATIONS or not isinstance(body, dict) or len(str(body)) > 20_000:
                    raise ValueError()
                if data.get('profile', 'default') not in (None, '', 'default') or body.get('profile', 'default') not in (None, '', 'default'):
                    raise web.HTTPBadRequest(text='云端技能操作只支持当前用户的默认配置。')
                if operation:
                    if (operation.method, operation.path, operation.body, operation.sid) != (method, path, body, session.sid):
                        raise web.HTTPConflict(text='操作标识已使用，请刷新检查技能状态。')
                else:
                    for old_key, old in list(self.operations.items()):
                        if (not old.task or old.task.done()) and time.monotonic() - old.created > 3600:
                            self.operations.pop(old_key, None)
                    if len(self.active_users) >= 32:
                        raise web.HTTPTooManyRequests(text='技能操作繁忙，请稍后重试。')
                    if len(self.operations) >= 128:
                        for old_key, old in list(self.operations.items()):
                            if old.phase in {'saved', 'unknown', 'failed'} and (not old.task or old.task.done()):
                                self.operations.pop(old_key)
                                break
                    if len(self.operations) >= 128:
                        raise web.HTTPTooManyRequests(text='技能操作记录繁忙，请稍后重试。')
                    if any(op.user == session.user_id and op.phase in {'changing', 'saving', 'save_failed'} for op in self.operations.values()):
                        raise web.HTTPConflict(text='请先完成当前技能操作或重试保存，不要重复安装。')
                    operation = SkillOperation(session.user_id, session.sid, method, path, body)
                    self.operations[(session.user_id, key)] = operation
                    operation.task = asyncio.create_task(self.run(operation, session))
            elif action in {'status', 'retry-save'}:
                if operation is None or operation.sid != session.sid:
                    raise web.HTTPNotFound(text='操作记录不存在或已过期；请先刷新检查，不要盲目重复安装。')
                if action == 'retry-save' and operation.phase == 'save_failed':
                    operation.phase = 'saving'
                    operation.task = asyncio.create_task(self.save(operation))
            else:
                raise web.HTTPNotFound()
            return web.json_response({
                'id': key, 'phase': operation.phase, 'error': operation.error,
                'result': operation.result if operation.phase == 'saved' else None,
            }, headers={'Cache-Control': 'no-store'})
        except (ValueError, KeyError, TypeError):
            raise web.HTTPBadRequest(text='技能操作参数无效。') from None

    async def instance(self, operation, method, path, body=None):
        tenant = operation.tenant
        origin = tenant.origin or f'{tenant.ip}:{self.entry.s.forward_port}'
        headers = {'Host': tenant.host_header or f'127.0.0.1:{self.entry.s.hermes_port}',
                   'X-Hermes-Session-Token': tenant.token}
        if tenant.traffic_token:
            headers['cube-traffic-access-token'] = tenant.traffic_token
        async with self.entry.http.request(method, f'http://{origin}/{path}', headers=headers,
                json=body, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=600)) as response:
            if response.status in {400, 422}:
                raise SkillRejected('技能操作被拒绝，请检查安全扫描结果、是否已安装或参数是否有效。')
            if response.status != 200:
                raise RuntimeError('instance_rejected')
            result = await response.json()
            if not isinstance(result, dict):
                raise RuntimeError('instance_invalid')
            return result

    async def run(self, operation, session):
        try:
            operation.tenant = await self.entry._tenant_for(session)
            await self.entry._touch(operation.user)
            operation.result = await asyncio.wait_for(
                self.instance(operation, operation.method, operation.path, operation.body), 610)
            if MUTATIONS[(operation.method, operation.path)]:
                name = operation.result.get('name')
                if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', name):
                    raise RuntimeError('invalid_action')
                deadline = time.monotonic() + 600
                while True:
                    state = await self.instance(operation, 'GET', f'api/actions/{quote(name, safe="")}/status?lines=20')
                    if state.get('running') is False:
                        if state.get('exit_code') is None:
                            raise RuntimeError('unknown_action')
                        # Preserve the original action response. Its existing UI reads the final exit/log state.
                        break
                    if time.monotonic() >= deadline:
                        raise TimeoutError()
                    await self.entry._touch(operation.user)
                    await asyncio.sleep(1)
            elif operation.result.get('ok') is not True:
                raise RuntimeError('mutation_incomplete')
            operation.phase = 'saving'
            await self.save(operation)
        except SkillRejected as exc:
            operation.phase = 'failed'
            operation.error = str(exc)
        except asyncio.CancelledError:
            operation.phase = 'unknown'
            operation.error = '技能操作结果未确认，请刷新检查，勿盲目重复操作。'
            raise
        except Exception as exc:
            log.warning('skill mutation result unconfirmed (%s)', type(exc).__name__)
            operation.phase = 'unknown'
            operation.error = '技能操作结果未确认，请刷新检查，勿盲目重复操作。'

    async def save(self, operation):
        try:
            from .state_checkpoint import checkpoint
            await checkpoint(self.entry, operation.user, operation.tenant)
            # Docker's entire HERMES_HOME already lives on its persistent named volume.
            operation.phase = 'saved'
            operation.error = ''
        except asyncio.CancelledError:
            operation.phase = 'save_failed'
            raise
        except Exception as exc:
            log.warning('skill checkpoint unconfirmed (%s)', type(exc).__name__)
            operation.phase = 'save_failed'
            operation.error = '技能已变更，但保存未确认。请重试保存，不要重复安装。'

    async def close(self):
        tasks = [op.task for op in self.operations.values() if op.task and not op.task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
