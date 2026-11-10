"""UniClaw cloud users move here with their 5G binding and plan, over real PG and real files."""
import json
import tarfile
import uuid

import pytest

from entry.messaging_uniclaw_import import run_enable, run_import
from tests.hermes_mt.test_cloud_binding import setup


def uniclaw_user(agent, *, key='sk-yuanjing', model_origin='https://maas.test', registered=True):
    """The shape UniClaw stores in config.users/<uid>.json (credentials in plain text)."""
    return {'claw': {'channels': {'uniagentgate': {'gateway_url': 'https://gateway.test', 'agent_id': agent,
                                                   'agent_sk': 'agent-secret-' + agent, 'registered': registered}}},
            'models': [{'id': 'main', 'model': 'main-model', 'provider': 'yuanjing', 'api_key': 'per-model-key-' + agent,
                        'base_url': model_origin, 'context_window': 64000, 'supported_modalities': ['text']}],
            'main_model_id': 'main', 'yuanjing_api_key': key, 'config_source': 'remote'}


@pytest.mark.asyncio
async def test_import_moves_users_once_never_overrides_newer_state_and_enables_in_batches(tmp_path, postgres_database_url):
    """Imported bindings start disabled so they cannot take the agent from UniClaw early. A user who
    already logged in here keeps their newer plan, an agent never gets two owners, and a rerun for
    late pushes changes nothing already imported."""
    app, entry = await setup(postgres_database_url)
    store = entry.messaging_routes.store
    # Files are read in name order; the first holder of a shared agent keeps it.
    fresh, logged_in, test_model, excluded, unbound, duplicate = sorted(str(uuid.uuid4()) for _ in range(6))
    await entry.store.finish_login(user_id=logged_in, phone='', api_key='sk-from-login', endpoint=None, catalog=None,
                                   ttl_s=3600, upstream_expires_at_ms=None, login_method='sms')
    users = tmp_path / 'config.users'
    users.mkdir()
    files = {fresh: uniclaw_user('agent-fresh'), logged_in: uniclaw_user('agent-logged-in'),
             duplicate: uniclaw_user('agent-fresh'), test_model: uniclaw_user('agent-test', model_origin='https://test-model.test'),
             excluded: uniclaw_user('agent-excluded'), unbound: uniclaw_user('agent-unbound', registered=False)}
    for user, config in files.items():
        (users / f'{user}.json').write_text(json.dumps(config))
    (users / f'{fresh}.develop.json').write_text('{}')
    options = dict(exclude={excluded}, model_origins={'https://maas.test'})
    try:
        dry = await run_import(entry.database, store, entry.s, str(users), dry_run=True, **options)
        assert await store.binding(fresh) is None
        async with entry.database.acquire() as db:
            assert await db.fetchval('SELECT count(*) FROM users WHERE user_id=$1', fresh) == 0

        report = await run_import(entry.database, store, entry.s, str(users), **options)
        assert report['counts'] == {'imported': 1, 'imported_binding_only': 1, 'agent_owned_by_other_user': 1,
                                    'model_origin_not_allowed': 1, 'excluded': 1, 'not_bound': 1}
        assert dry['counts'] == report['counts']
        assert report['users']['agent_owned_by_other_user'] == [duplicate]
        assert 'agent-secret' not in json.dumps(report) and 'sk-' not in json.dumps(report)

        imported = await store.binding(fresh)
        assert imported['source'] == 'uniclaw-import' and not imported['enabled']
        assert store.cipher.decrypt(imported['secret_enc']) == 'agent-secret-agent-fresh'
        context = await entry.store.get_tenant_context(fresh)
        assert context.api_key == 'sk-yuanjing' and context.endpoint == ('https://maas.test/v1', 'main-model')
        async with entry.database.acquire() as db:
            catalog = await db.fetchval('SELECT model_catalog::text FROM tenant_model_config WHERE user_id=$1', fresh)
        assert 'per-model-key' not in catalog
        assert (await entry.store.get_tenant_context(logged_in)).api_key == 'sk-from-login'
        assert not (await store.binding(logged_in))['enabled']

        # Rerun from a tar of the same directory, as for pushes UniClaw received after the first copy.
        archive = tmp_path / 'users.tar'
        with tarfile.open(archive, 'w') as tar:
            tar.add(users, arcname='config.users')
        again = await run_import(entry.database, store, entry.s, str(archive), **options)
        assert again['counts']['already_bound'] == 2 and 'imported' not in again['counts']
        assert (await store.binding(fresh))['revision'] == imported['revision']

        assert (await run_enable(entry.database, store, limit=1))['enabled'] == 1
        assert sum(bool((await store.binding(user))['enabled']) for user in (fresh, logged_in)) == 1
        assert (await run_enable(entry.database, store, users=[fresh, logged_in]))['enabled'] == 1
        assert all((await store.binding(user))['enabled'] for user in (fresh, logged_in))
    finally:
        await entry.database.close()
