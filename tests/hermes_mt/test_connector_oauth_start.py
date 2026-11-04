"""Opening a provider's OAuth page does not wait for a full instance archive.

Starting OAuth only records a pending grant in the instance; users stared at a blank popup for
~8 s (measured 8.38 s) while entry archived the whole instance. The callback's oauth.complete is
the change that must be durable before the user is told the connector is connected.
"""
import asyncio
from types import SimpleNamespace

import pytest

from entry import connector_routes

SPECS = {'eastmoney_mcp': {'auth': 'oauth2', 'fields': []}, 'amap': {'auth': 'api_key', 'fields': ['apiKey']}}


class Request:
    headers = {'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'cloud.example'}
    scheme, host = 'http', 'entry:9400'

    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


@pytest.mark.asyncio
async def test_oauth_start_skips_the_archive_and_the_callback_keeps_it(monkeypatch):
    archived, sent = [], []
    user = SimpleNamespace(user_id='alice', sid='sid')

    async def instance(session, path, data, capability):
        sent.append(data['operation'])
        return {'connectors': [{'id': key, 'configured': False} for key in SPECS],
                'authorizationUrl': 'https://mkcs.dfcfs.com/oauth/authorize?state=grant', 'state': 'grant'}

    async def checkpoint(entry, owner, tenant):
        archived.append(owner)

    monkeypatch.setattr(connector_routes, 'checkpoint', checkpoint)
    monkeypatch.setattr(connector_routes, 'connector_specs', lambda: SPECS)
    entry = SimpleNamespace(
        _require=lambda request: asyncio.sleep(0, user),
        _tenant_for=lambda session: asyncio.sleep(0, 'tenant'),
        share_routes=SimpleNamespace(instance=instance),
        store=SimpleNamespace(get_session=lambda sid: asyncio.sleep(0, user),
                              cipher=SimpleNamespace(encrypt=lambda raw: b'ticket')),
        s=SimpleNamespace(base_path='/hermes', cookie_secure=True))
    routes = connector_routes.ConnectorRoutes(entry)

    started = await routes.handle(Request({'operation': 'authorize', 'profile': 'default', 'id': 'eastmoney_mcp', 'values': {}}))
    assert started.status == 200 and 'mkcs.dfcfs.com' in started.text
    assert sent == ['authorize'] and archived == []

    await routes.execute(user, {'operation': 'oauth.complete', 'profile': 'default', 'id': 'eastmoney_mcp'})
    assert archived == ['alice']
