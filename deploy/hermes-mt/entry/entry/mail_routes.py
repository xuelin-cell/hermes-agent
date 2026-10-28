"""Phone identity comes from login proof, never mailbox request parameters."""
import asyncio
import re
from urllib.parse import quote
from weakref import WeakValueDictionary

from aiohttp import web

from .state_checkpoint import checkpoint

PAGE_ACTIONS = {'delete_email', 'download_attachment', 'get_email', 'get_folder_status', 'list_folders', 'mark_email_read', 'search_emails'}
INSTANCE = '/api/plugins/cloud-mail/internal/request'


class MailRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.locks = WeakValueDictionary()

    async def handle(self, request):
        identity = await self.entry._require_maas(request)
        if not re.fullmatch(r'1\d{10}', identity.phone):
            raise web.HTTPForbidden(text='请使用手机号账号登录后开通邮箱。')
        try:
            data = await request.json()
            if not isinstance(data, dict) or data.get('profile', 'default') not in {'default', ''}:
                raise web.HTTPBadRequest(text='云端邮箱只支持当前账号默认档案。')
            operation = data.get('operation')
            if operation not in {'status', 'enable', 'disable', 'action'}:
                raise web.HTTPBadRequest(text='未知邮箱操作。')
            if operation == 'action' and (data.get('action') not in PAGE_ACTIONS or not isinstance(data.get('input'), dict)):
                raise web.HTTPBadRequest(text='未知邮箱操作。')
            lock = self.locks.setdefault(identity.user_id, asyncio.Lock())
            async with lock:
                await self.entry.share_routes.authorize(identity)
                tenant = await self.entry.tenants.ensure_running(identity.user_id)
                body = {'operation': operation, 'owner': identity.user_id, 'phone': identity.phone}
                if operation == 'enable':
                    status = await self.entry.share_routes.instance(identity, INSTANCE, {**body, 'operation': 'status'}, capability='邮箱')
                    if not status.get('hasCredentials'):
                        code = await self.entry.drive_routes.worker.call('mail-code', identity=identity)
                        if not isinstance(code, dict) or not isinstance(code.get('authorizationCode'), str):
                            raise web.HTTPBadGateway(text='邮箱授权暂时不可用。')
                        body['authorizationCode'] = code['authorizationCode']
                if operation == 'action':
                    body.update(action=data['action'], input=data['input'])
                await self.entry.share_routes.authorize(identity)
                result = await self.entry.share_routes.instance(identity, INSTANCE, body, capability='邮箱')
                if operation in {'enable', 'disable'}:
                    try:
                        await checkpoint(self.entry, identity.user_id, tenant)
                    except Exception:
                        raise web.HTTPConflict(text='邮箱设置已变更，但持久化未确认。请重新查看状态后重试开通或停用，不要重复发送邮件。') from None
                await self.entry.share_routes.authorize(identity)
                result.pop('hasCredentials', None)
                file = (result.get('data') or {}).get('file') if isinstance(result.get('data'), dict) else None
                if operation == 'action' and data['action'] == 'download_attachment' and isinstance(file, dict):
                    file_id = file.get('fileId', '')
                    if not isinstance(file_id, str) or not re.fullmatch(r'[a-f0-9]{32}-[^/\\\x00-\x1f]{1,100}', file_id):
                        raise web.HTTPBadGateway(text='附件响应无效。')
                    file['downloadUrl'] = self.entry.s.base_path + '/__hermes_backend/api/plugins/cloud-mail/attachments/' + quote(file_id, safe='')
                return web.json_response(result, headers={'Cache-Control': 'no-store'})
        except web.HTTPException as error:
            return web.json_response({'error': error.text}, status=error.status, headers={'Cache-Control': 'no-store'})
        except (ValueError, TypeError, KeyError):
            return web.json_response({'error': '邮箱请求或响应无效。'}, status=400)
