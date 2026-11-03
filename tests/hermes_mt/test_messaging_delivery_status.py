"""Historical failures stop warning only after a complete newer delivery."""
import pytest

from tests.hermes_mt.test_messaging_media import context


async def newer_reply(entry, binding, epoch, key):
    store = entry.messaging_routes.store
    delivery = await store.ingest(binding['id'], binding['revision'], 'chat', key, {})
    await store.claim('lease-owner')
    async with entry.database.acquire() as db:
        await db.execute("UPDATE messaging_inbox SET state='accepted',instance_epoch=$2 WHERE delivery_id=$1", delivery, epoch)
    outbound = await store.complete(delivery, 'lease-owner', epoch, {'content': 'reply'})
    return delivery, outbound


@pytest.mark.asyncio
@pytest.mark.parametrize('old_state', ['failed', 'unknown'])
async def test_complete_newer_reply_only_clears_confirmed_historical_failure(postgres_database_url, old_state):
    _, _, entry, binding, epoch, delivery = await context(postgres_database_url, 'uniagentgate')
    try:
        old = await entry.messaging_routes.store.complete(delivery, 'lease-owner', epoch, {'content': 'old'})
        async with entry.database.acquire() as db:
            await db.execute("UPDATE messaging_outbox SET state=$2,error_code=$3 WHERE outbound_id=$1",
                             old, old_state, 'gateway_rejected' if old_state == 'failed' else 'outbound_unconfirmed')
        assert (await entry.messaging_routes.view('alice', 'uniagentgate'))['error_code']
        _, reply = await newer_reply(entry, binding, epoch, 'newer')
        async with entry.database.acquire() as db:
            await db.execute("""UPDATE messaging_outbox SET state='sent',
                platform_ack='{"local_completion":true}' WHERE outbound_id=$1""", reply)
        assert (await entry.messaging_routes.view('alice', 'uniagentgate'))['error_code']
        async with entry.database.acquire() as db:
            await db.execute("UPDATE messaging_outbox SET platform_ack='{}' WHERE outbound_id=$1", reply)
        view = await entry.messaging_routes.view('alice', 'uniagentgate')
        assert view['error_code'] == ('' if old_state == 'failed' else 'outbound_unconfirmed')
        async with entry.database.acquire() as db:
            assert await db.fetchval('SELECT state FROM messaging_outbox WHERE outbound_id=$1', old) == old_state
    finally:
        await entry.database.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('attachment_state', ['pending', 'sending', 'failed', 'unknown', 'cancelled'])
async def test_incomplete_newer_reply_does_not_hide_failed_attachment(postgres_database_url, attachment_state):
    _, _, entry, binding, epoch, delivery = await context(postgres_database_url, 'uniagentgate')
    try:
        old = await entry.messaging_routes.store.complete(delivery, 'lease-owner', epoch, {'content': 'old'})
        async with entry.database.acquire() as db:
            await db.execute("UPDATE messaging_outbox SET state='failed',error_code='gateway_rejected' WHERE outbound_id=$1", old)
        newer, reply = await newer_reply(entry, binding, epoch, 'newer')
        async with entry.database.acquire() as db:
            await db.execute("UPDATE messaging_outbox SET state='sent' WHERE outbound_id=$1", reply)
            await db.execute("""INSERT INTO messaging_outbox
                (outbound_id,delivery_id,part_index,binding_revision,payload,state,error_code)
                VALUES('attachment',$1,1,$2,'{"media":{}}',$3,'media_oss_upload_failed')""",
                             newer, binding['revision'], attachment_state)
        assert (await entry.messaging_routes.view('alice', 'uniagentgate'))['error_code']
        assert not (await entry.messaging_routes.view('bob', 'uniagentgate'))['error_code']
        assert not (await entry.messaging_routes.view('alice', 'wecom'))['error_code']
    finally:
        await entry.database.close()
