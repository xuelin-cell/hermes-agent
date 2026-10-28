"""Mailbox migration: real Entry/PG, scoped instance HTTP, Node provider host and state archives."""
import asyncio
import json
import socket
import sys
import tarfile
import time
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse
import uvicorn
import yaml

from entry.app import build_app
from entry.config import Settings
from entry.drive_worker import DriveWorker
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_platform.resolver import locate_command
from plugins.cloud_mail.dashboard import plugin_api as mail
from plugins.cloud_mail.runtime import MailRuntime

REPO = Path(__file__).resolve().parents[2]


async def fixture_worker(tmp_path):
    """Only mailbox-provider responses are fake; validation, quota and transport stay real."""
    node = locate_command('node').command[0]
    source, output = tmp_path / 'fixture.ts', tmp_path / 'fixture.mjs'
    source.write_text('''
import { createInterface } from 'node:readline';
import { mailAction, quotaStatus } from REPO_MAIL;
const base = Object.fromEntries(['send_email','list_folders','search_emails','download_attachment','mark_email_read','delete_email'].map(name => ['wo_mail.'+name, async (args, context) => {
  const credential = await context.getCredential('wo_mail');
  if (credential.values.authorizationCode !== 'provider-code') return {ok:false,error:{message:'wrong credential'}};
  if(name==='list_folders') return {ok:true,output:{folders:[{path:'INBOX',name:'Inbox'}]}};
  if(name==='search_emails') return {ok:true,output:{emails:[{uid:1,subject:credential.values.email}],nextBeforeUid:null}};
  if(name==='download_attachment') return {ok:true,output:{file:await context.transitFiles.create(new File(['attachment'], 'report.txt'))}};
  return {ok:true,output:{sent:true,messageId:'mail-id'}};
}]));
for await (const line of createInterface({input:process.stdin})) {
  const input=JSON.parse(line);
  try { if(input.operation==='validate' && input.values.authorizationCode!=='provider-code') throw Error('bad credential');
    const result=input.operation==='quota'?quotaStatus(input.directory,input.values.email):input.operation==='validate'?{valid:true}:await mailAction(input,base);
    process.stdout.write(JSON.stringify({id:input.id,result})+'\\n');
  } catch {process.stdout.write(JSON.stringify({id:input.id,error:'rejected'})+'\\n');}
}
'''.replace('REPO_MAIL', json.dumps(str(REPO / 'apps/desktop/services/open-connector/cloud/mail.ts'))))
    build = "import {build} from 'esbuild'; await build({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:'node',format:'esm',logLevel:'silent',banner:{js:\"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);\"}})"
    process = await asyncio.create_subprocess_exec(node, '--input-type=module', '-e', build, str(source), str(output), cwd=REPO)
    assert await process.wait() == 0
    return output, node


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
async def test_mail_binds_phone_and_credentials_to_tenant_and_restores_state(tmp_path, postgres_database_url, monkeypatch):
    script, node = await fixture_worker(tmp_path)
    app = build_app(Settings(database_url=postgres_database_url, credential_key=Fernet.generate_key().decode(), backend='docker'))
    entry = next(route.handler.__self__ for route in app.router.routes() if route.handler.__name__ == 'login')
    app.on_startup.clear()
    app.on_cleanup.clear()
    homes, services, tenants = {}, {}, {}
    for owner in ('alice', 'bob'):
        home = tmp_path / owner
        workspace = home / 'workspace'
        workspace.mkdir(parents=True)
        (home / 'config.yaml').write_text(f'cloud_mail: {{enabled: true}}\nterminal:\n  cwd: {workspace}\nmcp_servers:\n  Agent-Mail:\n    enabled: false\n    url: http://127.0.0.1/api/plugins/cloud-mail/mcp\n')
        homes[owner] = home
        services[owner] = MailRuntime(home, workspace, script=script, node=node)
        mail._runtimes[home.resolve()] = services[owner]
    instance = FastAPI()
    instance.include_router(mail.router, prefix='/api/plugins/cloud-mail')
    @instance.middleware('http')
    async def scope(request: Request, next):
        assert request.headers.get('Authorization') is None
        owner = request.headers.get('X-Hermes-Session-Token', '').removeprefix('instance-')
        if owner not in homes:
            return JSONResponse({}, status_code=403)
        token = set_hermes_home_override(homes[owner])
        try:
            return await next(request)
        finally:
            reset_hermes_home_override(token)
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    for owner, home in homes.items():
        config = yaml.safe_load((home / 'config.yaml').read_text())
        config['mcp_servers']['Agent-Mail'].update(uniwork_managed='uniwork.cloud.mail.v1',url=f'http://127.0.0.1:{port}/api/plugins/cloud-mail/mcp',
            headers={'X-Hermes-Session-Token':'instance-'+owner})
        (home / 'config.yaml').write_text(yaml.safe_dump(config))
    listener.listen()
    server = uvicorn.Server(uvicorn.Config(instance, log_level='error', lifespan='off'))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    for _ in range(200):
        if server.started: break
        await asyncio.sleep(.01)
    assert server.started
    upstream = web.Application()
    codes = []
    async def code(request):
        body = await request.json()
        assert 'mobile' in body and 'sign' in request.headers
        codes.append(body)
        return web.json_response({'code':'200','data':{'exclusiveCode':'provider-code'}})
    upstream.router.add_post('/openapi/mail/exclusive/set', code)
    async def ensure(owner):
        return SimpleNamespace(user_id=owner, token='instance-'+owner, origin=f'127.0.0.1:{port}', traffic_token='', host_header='', sandbox_id=None)
    entry.tenants = SimpleNamespace(ensure_running=ensure)
    async def warm(owner): pass
    entry._warm = warm
    await entry.database.connect()
    try:
        async with TestServer(upstream) as external, aiohttp.ClientSession() as http:
            entry.http = http
            worker = tmp_path / 'code.mjs'
            worker.write_text('import {startDriveWorker} from ' + json.dumps(str(REPO / 'deploy/hermes-mt/entry/entry/static/cloud-drive-worker.mjs')) + ';startDriveWorker((url,options)=>{const u=new URL(url);if(u.hostname!=="zeus.mail.wo.cn") throw Error("wrong origin");return fetch(' + json.dumps(str(external.make_url('')).rstrip('/')) + '+u.pathname+u.search,options)});')
            await entry.drive_routes.worker.close()
            entry.drive_routes.worker = DriveWorker(worker, node=node)
            async with TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar()) as client:
                auth = {}
                for owner, phone in [('alice','13800001111'),('bob','13800002222')]:
                    login = await entry._finish_login(owner, '', int((time.time()+3600)*1000), maas_token='maas-'+owner, phone=phone)
                    auth[owner] = {'cookies':{name:value.value for name,value in login.cookies.items()}, 'headers':{'Authorization':'Bearer maas-'+owner}}
                async def call(owner, operation, expected=200, **args):
                    response = await client.post('/hermes/__entry/mail', json={'operation':operation,'profile':'default',**args}, **auth[owner])
                    result = await response.json()
                    assert response.status == expected, result
                    return result
                assert not (await call('alice','status'))['status']['enabled']
                for owner, phone in [('alice','13800001111'),('bob','13800002222'),('alice','13800001111')]:
                    enabled = await call(owner,'enable',phone='19999999999',user_id='forged')
                    assert enabled['status']['email'] == phone+'@wo.cn'
                    assert yaml.safe_load((homes[owner]/'config.yaml').read_text())['mcp_servers']['Agent-Mail']['enabled'] is True
                    assert 'provider-code' not in json.dumps(enabled) and 'hasCredentials' not in enabled
                    listing = await call(owner,'action',action='search_emails',input={'folder':'INBOX','limit':10})
                    assert listing['data']['emails'][0]['subject'] == phone+'@wo.cn'
                assert len(codes) == 2
                for owner in ('alice','bob','alice'):
                    def dispatch():
                        from tools.mcp_tool_discovery import discover_mcp_tools
                        from tools.mcp_tool_schema import mcp_prefixed_tool_name
                        from tools.registry import registry
                        scope = set_hermes_home_override(homes[owner])
                        try:
                            discover_mcp_tools(allowed_mcp_names=['Agent-Mail'])
                            return registry.dispatch(mcp_prefixed_tool_name('Agent-Mail','list_folders'), {}, session_id='runtime')
                        finally:
                            reset_hermes_home_override(scope)
                    assert 'INBOX' in str(await asyncio.to_thread(dispatch))
                await call('alice','action',400,action='send_email',input={})
                assert (await client.post('/hermes/__hermes_backend/api/plugins/cloud-mail/internal/request',json={},**auth['alice'])).status == 404
                assert (await client.post('/hermes/__hermes_backend/api/plugins/cloud-mail/mcp',json={},**auth['alice'])).status == 404
                downloaded = await call('alice','action',action='download_attachment',input={'folder':'INBOX','uid':1,'attachmentId':'2'})
                url = downloaded['data']['file']['downloadUrl']
                assert url.startswith('/hermes/__hermes_backend/api/plugins/cloud-mail/attachments/')
                file = downloaded['data']['file']['fileId']
                async with http.get(f'http://127.0.0.1:{port}/api/plugins/cloud-mail/attachments/{file}',headers={'X-Hermes-Session-Token':'instance-alice'}) as response:
                    assert await response.read() == b'attachment'
                async with http.get(f'http://127.0.0.1:{port}/api/plugins/cloud-mail/attachments/{file}',headers={'X-Hermes-Session-Token':'instance-bob'}) as response:
                    assert response.status == 404
                # Real MCP wire path shares the same enabled state and persistent quota.
                async def mcp(owner, name):
                    async with http.post(f'http://127.0.0.1:{port}/api/plugins/cloud-mail/mcp',headers={'X-Hermes-Session-Token':'instance-'+owner},json={
                        'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':{'to':['to@example.org'],'subject':'Hi','text':'Body'}}}) as response:
                        return await response.json()
                assert not (await mcp('alice','send_email'))['result'].get('isError')
                assert (await call('alice','status'))['status']['todaySent'] == 1
                # A project change and worker replacement cannot reset the account quota.
                config = yaml.safe_load((homes['alice']/'config.yaml').read_text())
                config['terminal']['cwd'] = str(homes['alice']/'workspace'/'other-project')
                (homes['alice']/'config.yaml').write_text(yaml.safe_dump(config))
                await services['alice'].close()
                mail._runtimes.pop(homes['alice'].resolve())
                scope = set_hermes_home_override(homes['alice'])
                try:
                    replacement_service = mail.runtime()
                    assert replacement_service.workspace == homes['alice']/'workspace'
                    replacement_service.node, replacement_service.script = node, script
                    from hermes_cli.web_models import MCPEnabledToggle
                    from hermes_cli.web_routers.mcp import set_mcp_server_enabled
                    await set_mcp_server_enabled('Agent-Mail',MCPEnabledToggle(enabled=False))
                finally:
                    reset_hermes_home_override(scope)
                assert (await mcp('alice','send_email'))['result']['isError']
                assert (await call('alice','status'))['status']['todaySent'] == 1
                assert not (await call('alice','status'))['status']['enabled']
                await call('alice','enable')
                await call('alice','disable')
                assert yaml.safe_load((homes['alice']/'config.yaml').read_text())['mcp_servers']['Agent-Mail']['enabled'] is False
                assert (await mcp('alice','send_email'))['result']['isError']
                assert (await call('bob','status'))['status']['enabled']
                sys.path.insert(0,str(REPO/'deploy/hermes-mt/seed'))
                import mtstate
                from entry.tenants import TenantManager
                for owner, enabled in [('alice',False),('bob',True)]:
                    mtstate.patch_config_file(homes[owner]/'config.yaml', {'mcp_servers': TenantManager._drive_mcp()})
                    assert yaml.safe_load((homes[owner]/'config.yaml').read_text())['mcp_servers']['Agent-Mail']['enabled'] is enabled
                archive, manifest = mtstate.build_archive(homes['alice'],tmp_path/'archive','sandbox',1,'')
                restored = tmp_path/'restored'
                restored.mkdir()
                with tarfile.open(archive) as tar:
                    assert 'agent-mail/state.enc' in tar.getnames() and 'agent-mail/key' in tar.getnames()
                    tar.extractall(restored,filter='data')
                replacement = MailRuntime(restored,services['alice'].workspace,script=script,node=node)
                assert replacement.read()['enabled'] is False
                assert replacement.read()['authorizationCode'] == 'provider-code'
                assert (await replacement.status())['todaySent'] == 1
                assert b'provider-code' not in (homes['alice']/'agent-mail/state.enc').read_bytes()
                await replacement.close()
    finally:
        server.should_exit = True
        await serving
        await mail.shutdown()
        await entry.drive_routes.close()
        for task in entry._bg: await task
        await entry.database.close()
