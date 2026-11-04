"""Cookie-bound fixed connector operations. No MaaS token or caller-selected upstream."""
import asyncio
from weakref import WeakValueDictionary

from aiohttp import web

from .state_checkpoint import checkpoint
from .connector_contract import connector_specs
from .connector_oauth import ConnectorOAuth, callback_base
from .connector_wecom_qr import WecomQrError, WecomQrSessions

QR_OPERATIONS = {'qr.start', 'qr.poll', 'qr.cancel'}
BROWSER_OPERATIONS = {'authorize', 'authorize.poll', 'authorize.cancel'}


def public_rows(rows, specs):
    """Only known state fields, never tokens, ports or provider responses."""
    if not isinstance(rows, list) or len(rows) != len(specs) or {row.get('id') for row in rows if isinstance(row, dict)} != set(specs):
        raise web.HTTPBadGateway(text='连接器状态无效。')
    return [{'id': row['id'], **{key: row.get(key) is True for key in ('connected', 'configured', 'enabled')}} for row in rows]


class ConnectorRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.locks = WeakValueDictionary()
        self.oauth = ConnectorOAuth(self)
        self.wecom_qr = WecomQrSessions(entry)

    async def handle(self, request):
        session = await self.entry._require(request)
        try:
            data = await request.json()
            if not isinstance(data, dict) or set(data) - {'operation', 'profile', 'id', 'values', 'sessionId'}:
                raise ValueError()
            operation = data.get('operation')
            specs = connector_specs()
            profile = data.get('profile', 'default')
            if not isinstance(profile, str) or not profile or profile.startswith('.') or '/' in profile or '\\' in profile or len(profile) > 160:
                raise ValueError()
            if operation in QR_OPERATIONS and data.get('id') == 'wecom_bot' and 'wecom_bot' in specs:
                return await self.wecom_qr_operation(session, operation, profile, data.get('sessionId'), specs)
            if operation in BROWSER_OPERATIONS and specs.get(data.get('id'), {}).get('auth') == 'browser_poll':
                return await self.browser_operation(session, operation, profile, data, specs)
            if 'sessionId' in data:
                raise ValueError()
            if operation not in {'list', 'connect', 'enable', 'disable', 'disconnect', 'save', 'authorize'}:
                raise ValueError()
            if operation != 'list' and data.get('id') not in specs:
                raise ValueError()
            if operation == 'connect':
                values = data.get('values')
                if not isinstance(values, dict) or set(values) != set(specs[data['id']]['fields']) or any(not isinstance(value, str) or not value.strip() or len(value) > 16384 for value in values.values()):
                    raise ValueError()
            if operation == 'connect' and specs[data['id']]['auth'] in {'oauth2', 'browser_poll'}:
                raise ValueError()
            if operation == 'authorize':
                if specs[data['id']]['auth'] != 'oauth2':
                    raise ValueError()
                fields = set(specs[data['id']]['fields'])
                values = data.get('values') or {}
                if not isinstance(values, dict) or set(values) != fields or any(not isinstance(value, str) or not value.strip() or len(value) > 16384 for value in values.values()):
                    raise ValueError()
                data['origin'] = callback_base(self.entry, request, data['id'])
            result = await self.execute(session, data)
            payload = {'connectors': public_rows(result.get('connectors'), specs)}
            if operation == 'authorize':
                payload['authorizationUrl'] = result['authorizationUrl']
            response = web.json_response(payload, headers={'Cache-Control': 'no-store'})
            if operation == 'authorize':
                self.oauth.started(request, session, data['id'], result, response, profile)
            return response
        except web.HTTPException as error:
            return web.json_response({'error': error.text}, status=error.status, headers={'Cache-Control': 'no-store'})
        except (ValueError, TypeError, KeyError):
            return web.json_response({'error': '请检查当前云端支持的连接器、专家档案和授权字段。'}, status=400, headers={'Cache-Control': 'no-store'})
        except FileNotFoundError:
            return web.json_response({'error': '连接器运行产物缺失，请更新入口镜像和实例模板。'}, status=503)

    async def wecom_qr_operation(self, session, operation, profile, session_id, specs):
        """Polls stay entry-local (no instance call, no state checkpoint); only the confirmed
        scan saves the bot through the normal connect path, which persists like a manual save."""
        no_store = {'Cache-Control': 'no-store'}
        try:
            if operation == 'qr.cancel':
                self.wecom_qr.cancel(session.user_id)
                return web.json_response({'connectors': []}, headers=no_store)
            if operation == 'qr.start':
                return web.json_response({'connectors': [], **await self.wecom_qr.start(session.user_id, profile)},
                                         headers=no_store)
            if not isinstance(session_id, str) or not 0 < len(session_id) <= 64:
                raise ValueError()
            result, values = await self.wecom_qr.poll(session.user_id, profile, session_id)
        except WecomQrError as error:
            return web.json_response({'error': str(error)}, status=502, headers=no_store)
        payload = {'connectors': [], **result}
        if values:
            connected = await self.execute(session, {'operation': 'connect', 'profile': profile,
                                                     'id': 'wecom_bot', 'values': values})
            payload['connectors'] = public_rows(connected.get('connectors'), specs)
        return web.json_response(payload, headers=no_store)

    async def browser_operation(self, session, operation, profile, data, specs):
        """Provider-page authorization (WPS). Starting and polling only read session state; the
        poll that reports the connection is the one that changed the instance, so only it persists."""
        if set(data) - {'operation', 'profile', 'id', 'sessionId'} or (
                operation != 'authorize' and not (isinstance(data.get('sessionId'), str) and 0 < len(data['sessionId']) <= 128)):
            raise ValueError()
        request = {key: data[key] for key in ('operation', 'id', 'sessionId') if key in data}
        result = await self.execute(session, {**request, 'profile': profile},
                                    persist=lambda result: operation == 'authorize.poll' and result.get('status') == 'connected')
        payload = {'connectors': public_rows(result.get('connectors'), specs),
                   **{key: result[key] for key in ('sessionId', 'status', 'message', 'expiresAt')
                      if isinstance(result.get(key), str)}}
        if operation == 'authorize':
            payload['authorizationUrl'] = result['authorizationUrl']
        return web.json_response(payload, headers={'Cache-Control': 'no-store'})

    async def execute(self, session, data, persist=None):
        operation = data['operation']
        lock = self.locks.setdefault(session.user_id, asyncio.Lock())
        async with lock:
            current = await self.entry.store.get_session(session.sid)
            if not current or current.user_id != session.user_id:
                raise web.HTTPUnauthorized(text='登录已失效。')
            tenant = await self.entry._tenant_for(session)
            result = await self.entry.share_routes.instance(session, '/__mt/connectors', data, capability='连接器')
            changed = operation != 'list' if persist is None else persist(result)
            if changed:
                try:
                    await checkpoint(self.entry, session.user_id, tenant)
                except Exception:
                    raise web.HTTPConflict(text='连接器设置已变更，但持久化未确认。请查询状态后重试保存，勿自动重放工具调用。') from None
            current = await self.entry.store.get_session(session.sid)
            if not current or current.user_id != session.user_id:
                raise web.HTTPUnauthorized(text='登录已失效。')
            return result
