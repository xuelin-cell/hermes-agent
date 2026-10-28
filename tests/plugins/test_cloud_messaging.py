"""Cloud relay execution receipts and owned gateway startup against real temporary homes."""
import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope, set_multiplex_active, is_multiplex_active
from gateway.config import Platform, load_gateway_config
from gateway.platform_registry import platform_registry
from hermes_cli.plugins import discover_plugins
from plugins.cloud_messaging.ledger import Ledger

REPO = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_profile_owned_plugin_and_interrupted_receipts_a_b_a(tmp_path,monkeypatch):
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    active = is_multiplex_active()
    set_multiplex_active(True)
    try:
        for name in ('a','b','a'):
            home = tmp_path / name
            home.mkdir(exist_ok=True)
            settings = {'enabled':True,'relay_url':'ws://127.0.0.1:1/relay','gateway_id':name+'.1.1',
                'bot_id':'bot-'+name,'upgrade_secret':'scoped-'+name,'revision':1}
            (home/'config.yaml').write_text(json.dumps({'cloud_messaging':settings,'platforms':{'uniagentgate':{'enabled':True}}}))
            token = set_hermes_home_override(home)
            secret = set_secret_scope(build_profile_secret_scope(home),profile_home=str(home))
            try:
                discover_plugins(force=True)
                cfg = load_gateway_config()
                adapter = platform_registry.create_adapter('uniagentgate',cfg.platforms[Platform('uniagentgate')])
                assert adapter is not None
                assert adapter.settings['bot_id'] == 'bot-'+name
                assert adapter.ledger.path.parent == home
                if name=='a' and adapter.ledger.get('delivery'):
                    from gateway.platforms.event import MessageEvent
                    from gateway.session import SessionSource
                    called=[]
                    async def handler(event): called.append(event)
                    adapter.set_message_handler(handler)
                    await adapter._on_inbound(MessageEvent(text='retry',message_id='delivery',source=SessionSource(platform=Platform('uniagentgate'),chat_id='phone')))
                    assert not called and adapter.ledger.get('delivery')['state']=='uncertain'
                    adapter.ledger.complete('delivery','frozen')
                    with pytest.raises(ValueError): adapter.ledger.complete('delivery','changed')
                else:
                    assert adapter.ledger.get('delivery') is None
                    assert adapter.ledger.accept('delivery','phone',1)
            finally:
                reset_secret_scope(secret)
                reset_hermes_home_override(token)
    finally:
        set_multiplex_active(active)


@pytest.mark.asyncio
async def test_forwarder_starts_real_gateway_without_second_cron(tmp_path,monkeypatch):
    spec=importlib.util.spec_from_file_location('mtmessaging',REPO/'deploy/hermes-mt/seed/mtmessaging.py')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    home=tmp_path/'home'
    home.mkdir()
    (home/'config.yaml').write_text(json.dumps({'model':{'default':'fixture','provider':'custom','base_url':'http://127.0.0.1:1/v1'},
        'streaming':{'enabled':True},'mcp_servers':{},'gateway':{'multiplex_profiles':False},'providers':{}}))
    manager=module.Gateway(home,sys.executable)
    connected=asyncio.Event()
    sockets=[]
    async def relay(request):
        assert request.headers['Authorization'].startswith('Bearer ')
        ws=web.WebSocketResponse()
        await ws.prepare(request)
        sockets.append(ws)
        async for message in ws:
            frame=json.loads(message.data)
            if frame['type']=='hello':
                descriptor={'contract_version':1,'platform':'uniagentgate','label':'5G','max_message_length':20000,'supports_draft_streaming':False,
                    'supports_edit':False,'supports_threads':False,'markdown_dialect':'plain','len_unit':'chars','supported_ops':['send']}
                await ws.send_str(json.dumps({'type':'descriptor','descriptor':descriptor})+'\n')
                connected.set()
            elif frame['type']=='going_idle':
                await ws.send_str('{"type":"going_idle_ack"}\n')
        return ws
    app=web.Application()
    app.router.add_get('/relay',relay)
    async with TestServer(app) as server:
        env={key:value for key,value in os.environ.items() if not key.startswith(('HERMES_','OPENAI_','ANTHROPIC_','MT_'))}
        env.update(HERMES_HOME=str(home),HERMES_RUNTIME_DIR=str(tmp_path/'runtime'),PYTHONPATH=str(REPO),OPENAI_API_KEY='fixture-model-key')
        settings={'relay_url':str(server.make_url('/relay')).replace('http://','ws://'),'gateway_id':'a.1.1','upgrade_secret':'local-secret','bot_id':'local-bot','revision':1}
        try:
            result=await manager.start(settings,env)
            try:
                await asyncio.wait_for(connected.wait(),30)
            except TimeoutError:
                pytest.fail((home/'logs/cloud-messaging.log').read_text()[-8000:])
            assert (await manager.start(settings,env))['pid']==result['pid']
            # The browser's streaming preference is not changed by IM setup.
            import yaml
            assert yaml.safe_load((home/'config.yaml').read_text())['streaming']['enabled'] is True
            assert Ledger(home).path.exists()
        finally:
            await manager.stop()
            assert manager.process is None
            for ws in sockets: await ws.close()
