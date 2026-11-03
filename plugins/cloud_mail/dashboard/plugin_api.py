"""Entry provisions a phone-bound mailbox; the page and Agent share one provider."""
import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from plugins.cloud_mail.runtime import MailRuntime

router = APIRouter()
TOOLS = json.loads((Path(__file__).parents[1] / 'tools.json').read_text())
PAGE_ACTIONS = {'delete_email', 'download_attachment', 'get_email', 'get_folder_status', 'list_folders', 'mark_email_read', 'search_emails', 'stage_attachment'}
_runtimes = {}


def runtime():
    from hermes_cli.config import load_config
    from hermes_constants import get_hermes_home
    config = load_config()
    if not config.get('cloud_mail', {}).get('enabled'):
        raise HTTPException(404, 'Cloud mail is not enabled')
    home = get_hermes_home().resolve()
    # Mail quota and attachments follow the account volume, never a mutable project cwd.
    workspace = (home / 'workspace').resolve()
    if home not in _runtimes:
        if len(_runtimes) >= 16:
            raise HTTPException(503, 'Too many mailbox runtimes')
        _runtimes[home] = MailRuntime(home, workspace)
    return _runtimes[home]


def mail_enabled(state):
    from hermes_cli.config import load_config
    server = load_config().get('mcp_servers', {}).get('Agent-Mail', {})
    return bool(state.get('enabled')) and server.get('uniwork_managed') == 'uniwork.cloud.mail.v1' and server.get('enabled', True) is not False


async def status(service, state):
    result = await service.status(state)
    result['enabled'] = mail_enabled(state)
    return result


@router.on_event('shutdown')
async def shutdown():
    await asyncio.gather(*(value.close() for value in _runtimes.values()))
    _runtimes.clear()


@router.post('/internal/request')
async def page(request: Request):
    data = await request.json()
    service = runtime()
    owner, phone, operation = data.get('owner'), data.get('phone', ''), data.get('operation')
    if not isinstance(owner, str) or not owner or not isinstance(phone, str) or not re.fullmatch(r'1\d{10}', phone):
        raise HTTPException(403, '请使用手机号账号登录。')
    email = phone + '@wo.cn'
    async with service.lock:
        state = service.read()
        if state and (state.get('owner') != owner or state.get('email') != email):
            raise HTTPException(403, '邮箱不属于当前账号。')
        if operation == 'enable':
            from hermes_cli.config import load_config
            server = load_config().get('mcp_servers', {}).get('Agent-Mail', {})
            if server.get('uniwork_managed') != 'uniwork.cloud.mail.v1':
                raise HTTPException(409, 'Agent-Mail 名称已由其他 MCP 配置使用，请先处理同名配置。')
            code = data.get('authorizationCode') or state.get('authorizationCode')
            if not isinstance(code, str) or not code or len(code) > 4096:
                raise HTTPException(400, '邮箱授权未完成。')
            candidate = {'owner': owner, 'email': email, 'authorizationCode': code, 'enabled': True}
            # Reuse desktop validation for both IMAP and SMTP before saving credentials.
            await service.call('validate', candidate)
            service.save(candidate)
            from hermes_cli.web_models import MCPEnabledToggle
            from hermes_cli.web_routers.mcp import set_mcp_server_enabled
            await set_mcp_server_enabled('Agent-Mail', MCPEnabledToggle(enabled=True))
            state = candidate
        elif operation == 'disable':
            if state:
                state['enabled'] = False
                service.save(state)
                from hermes_cli.web_models import MCPEnabledToggle
                from hermes_cli.web_routers.mcp import set_mcp_server_enabled
                await set_mcp_server_enabled('Agent-Mail', MCPEnabledToggle(enabled=False))
        elif operation == 'action':
            if not mail_enabled(state) or data.get('action') not in PAGE_ACTIONS:
                raise HTTPException(403, '请先开通邮箱或检查操作。')
            stage = data['action'] == 'stage_attachment'
            result = await service.call('action', state, name='download_attachment' if stage else data['action'], args=data.get('input', {}))
            if stage:
                file = result.get('file') if isinstance(result, dict) else None
                file_id = file.get('fileId') if isinstance(file, dict) else None
                if not isinstance(file_id, str) or not re.fullmatch(r'[a-f0-9]{32}-[^/\\\x00-\x1f]{1,100}', file_id):
                    raise HTTPException(502, '附件响应无效。')
                target = service.workspace / 'uploads/mail-attachments' / file_id
                if target.is_symlink() or not target.resolve().is_relative_to(service.workspace) or not target.is_file():
                    raise HTTPException(502, '附件暂存失败。')
                result = {'file': {'name': file.get('name') or file_id[33:], 'path': str(target)}}
            return {'status': await status(service, state), 'data': result}
        elif operation != 'status':
            raise HTTPException(400, 'Unknown mailbox operation')
        return {'status': await status(service, state), 'hasCredentials': bool(state.get('authorizationCode'))}


@router.post('/mcp')
async def mcp(request: Request):
    data = await request.json()
    service = runtime()
    if data.get('jsonrpc') != '2.0':
        raise HTTPException(400, 'Invalid MCP request')
    if 'id' not in data:
        return Response(status_code=202)
    method, params = data.get('method'), data.get('params') or {}
    result = {}
    if method == 'initialize':
        result = {'protocolVersion': params.get('protocolVersion', '2025-03-26'), 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'Agent-Mail', 'version': '1.0.0'}}
    elif method == 'tools/list':
        result = {'tools': TOOLS if mail_enabled(service.read()) else []}
    elif method == 'tools/call':
        async with service.lock:
            state = service.read()
            try:
                if not mail_enabled(state):
                    raise HTTPException(403, '请先在「我的邮箱」开通邮箱；不要使用其他通道绕过停用状态。')
                output = await service.call('action', state, name=params.get('name'), args=params.get('arguments', {}))
                if params.get('name') == 'download_attachment' and isinstance(output, dict) and isinstance(output.get('file'), dict):
                    output['file']['localPath'] = str(service.workspace / 'uploads/mail-attachments' / output['file']['fileId'])
                result = {'content': [{'type': 'text', 'text': json.dumps(output, ensure_ascii=False)}]}
            except HTTPException as error:
                result = {'content': [{'type': 'text', 'text': str(error.detail)}], 'isError': True}
    elif method != 'ping':
        return {'jsonrpc': '2.0', 'id': data['id'], 'error': {'code': -32601, 'message': 'Unknown method'}}
    return {'jsonrpc': '2.0', 'id': data['id'], 'result': result}


@router.get('/attachments/{file}')
async def attachment(file: str):
    service = runtime()
    if not mail_enabled(service.read()) or not re.fullmatch(r'[a-f0-9]{32}-[^/\\\x00-\x1f]{1,100}', file):
        raise HTTPException(404)
    target = service.workspace / 'uploads/mail-attachments' / file
    if not target.resolve().is_relative_to(service.workspace) or target.is_symlink() or not target.is_file():
        raise HTTPException(404)
    return FileResponse(target, media_type='application/octet-stream', filename=file[33:], headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})
