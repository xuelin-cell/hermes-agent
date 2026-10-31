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
@pytest.mark.parametrize('secondary',['dingtalk','weixin','wecom','feishu'])
async def test_profile_owned_plugin_and_interrupted_receipts_a_b_a(tmp_path,monkeypatch,secondary):
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    active = is_multiplex_active()
    set_multiplex_active(True)
    try:
        for name in ('a','b','a'):
            home = tmp_path / name
            home.mkdir(exist_ok=True)
            channel=secondary if name=='b' else 'uniagentgate'
            settings = {'platform':channel,'enabled':True,'relay_url':'ws://127.0.0.1:1/relay','gateway_id':name+'.1.1',
                'bot_id':'bot-'+name,'upgrade_secret':'scoped-'+name,'revision':1}
            (home/'config.yaml').write_text(json.dumps({'cloud_messaging':settings,'platforms':{channel:{'enabled':True}}}))
            token = set_hermes_home_override(home)
            secret = set_secret_scope(build_profile_secret_scope(home),profile_home=str(home))
            try:
                discover_plugins(force=True)
                cfg = load_gateway_config()
                adapter = platform_registry.create_adapter(channel,cfg.platforms[Platform(channel)])
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
