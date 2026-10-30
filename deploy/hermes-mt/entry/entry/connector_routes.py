"""Cookie-bound fixed connector operations. No MaaS token or caller-selected upstream."""
import asyncio
from weakref import WeakValueDictionary

from aiohttp import web

from .state_checkpoint import checkpoint
from .connector_contract import connector_specs
from .connector_oauth import ConnectorOAuth, callback_base


class ConnectorRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.locks = WeakValueDictionary()
        self.oauth = ConnectorOAuth(self)

    async def handle(self, request):
        session = await self.entry._require(request)
        try:
            data = await request.json()
            if not isinstance(data, dict) or set(data) - {'operation', 'profile', 'id', 'values'}:
                raise ValueError()
            operation = data.get('operation')
            specs = connector_specs()
            if data.get('profile', 'default') != 'default' or operation not in {'list', 'connect', 'enable', 'disable', 'disconnect', 'save', 'authorize'}:
                raise ValueError()
            if operation != 'list' and data.get('id') not in specs:
                raise ValueError()
            if operation == 'connect':
                values = data.get('values')
                if not isinstance(values, dict) or set(values) != set(specs[data['id']]['fields']) or any(not isinstance(value, str) or not value.strip() or len(value) > 16384 for value in values.values()):
                    raise ValueError()
            if operation == 'connect' and specs[data['id']]['auth'] == 'oauth2':
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
            # Return only known state fields, never tokens, ports or provider responses.
            rows = result.get('connectors')
            if not isinstance(rows, list) or len(rows) != len(specs) or {row.get('id') for row in rows if isinstance(row, dict)} != set(specs):
                raise web.HTTPBadGateway(text='连接器状态无效。')
            payload = {'connectors': [{
                'id': row['id'], **{key: row.get(key) is True for key in ('connected', 'configured', 'enabled')}
            } for row in rows]}
            if operation == 'authorize':
                payload['authorizationUrl'] = result['authorizationUrl']
            response = web.json_response(payload, headers={'Cache-Control': 'no-store'})
            if operation == 'authorize':
                self.oauth.started(request, session, data['id'], result, response)
            return response
        except web.HTTPException as error:
            return web.json_response({'error': error.text}, status=error.status, headers={'Cache-Control': 'no-store'})
        except (ValueError, TypeError, KeyError):
            return web.json_response({'error': '请检查当前云端支持的连接器、默认档案和授权字段。'}, status=400, headers={'Cache-Control': 'no-store'})
        except FileNotFoundError:
            return web.json_response({'error': '连接器运行产物缺失，请更新入口镜像和实例模板。'}, status=503)

    async def execute(self, session, data):
        operation = data['operation']
        lock = self.locks.setdefault(session.user_id, asyncio.Lock())
        async with lock:
            current = await self.entry.store.get_session(session.sid)
            if not current or current.user_id != session.user_id:
                raise web.HTTPUnauthorized(text='登录已失效。')
            tenant = await self.entry._tenant_for(session)
            result = await self.entry.share_routes.instance(session, '/__mt/connectors', data, capability='连接器')
            if operation != 'list':
                try:
                    await checkpoint(self.entry, session.user_id, tenant)
                except Exception:
                    raise web.HTTPConflict(text='连接器设置已变更，但持久化未确认。请查询状态后重试保存，勿自动重放工具调用。') from None
            current = await self.entry.store.get_session(session.sid)
            if not current or current.user_id != session.user_id:
                raise web.HTTPUnauthorized(text='登录已失效。')
            return result
