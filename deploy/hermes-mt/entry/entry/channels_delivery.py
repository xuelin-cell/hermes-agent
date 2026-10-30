"""Lease-bound dispatch and receipt reconciliation. Never rerun an ambiguous execution."""
import asyncio
import json
import logging

import aiohttp

log = logging.getLogger(__name__)


class UnverifiableExecution(RuntimeError):
    pass


async def wake(service, delivery):
    url = service.config['entry_url'].rstrip('/') + service.s.base_path + '/__entry/messaging/wake'
    async with service.http.post(url, json={'delivery_id': delivery['delivery_id'], 'owner': service.owner},
            headers={'Authorization': 'Bearer '+service.s.channels_key}, timeout=aiohttp.ClientTimeout(total=240)) as response:
        if response.status != 200: raise RuntimeError('Wake rejected; verify Entry and instance template capabilities')
        return await response.json()


def socket_for(service, delivery, ready):
    socket = service.sockets.get(delivery['user_id'])
    if not socket or socket[0] != ready['epoch'] or socket[2] != delivery['binding_revision']:
        raise RuntimeError('Relay generation changed')
    ws = socket[1]
    if ws.closed or ws.binding_id != delivery['binding_id'] or ws.worker_id != ready['worker_id']:
        raise RuntimeError('Relay context changed')
    return ws


async def probe(service, ws, delivery):
    future = asyncio.get_running_loop().create_future()
    ws.probes[delivery] = future
    try:
        await service.send_frame(ws, {'type': 'execution_probe', 'delivery_id': delivery})
        return await asyncio.wait_for(future, 10)
    finally:
        ws.probes.pop(delivery, None)


async def deliver(service, delivery):
    error_code = 'dispatch_unconfirmed'
    heartbeat = asyncio.create_task(service.maintain_lease(delivery['delivery_id']))
    try:
        async with asyncio.timeout(1800):
            ready = await wake(service, delivery)
            while not heartbeat.done():
                try:
                    ws = socket_for(service, delivery, ready)
                except RuntimeError:
                    await asyncio.sleep(1)
                    ready = await wake(service, delivery)
                    ws = socket_for(service, delivery, ready)
                async with service.database.acquire() as db:
                    row = await db.fetchrow('SELECT * FROM messaging_inbox WHERE delivery_id=$1', delivery['delivery_id'])
                if row['state'] == 'completed': return
                if row['state'] != 'dispatching':
                    # Missing records are retryable ONLY on the very same live worker,
                    # not merely a restored instance with the same home or epoch.
                    status = await probe(service, ws, row['delivery_id'])
                    if status == 'uncertain': raise UnverifiableExecution('Worker restarted during execution')
                    same_worker = row['instance_epoch'] == ready['epoch'] and row['execution_ref'] == ready['worker_id']
                    if status != 'completed' and not same_worker:
                        raise UnverifiableExecution('Original execution cannot be proven')
                    if status not in {'missing', 'accepted', 'running', 'completed'}:
                        raise RuntimeError('Unknown execution receipt')
                    async with service.database.acquire() as db:
                        changed = await db.fetchval("""UPDATE messaging_inbox SET state=$4,instance_epoch=$3,
                            execution_ref=$5,error_code='',updated_at=now() WHERE delivery_id=$1 AND lease_owner=$2
                            AND state IN('accepted','running','uncertain') AND lease_until>now() RETURNING delivery_id""",
                            row['delivery_id'],service.owner,ready['epoch'],
                            'running' if status=='running' else 'accepted',ready['worker_id'])
                    if not changed: raise RuntimeError('Reconciliation lease lost')
                    if status != 'missing':
                        await asyncio.sleep(1)
                        continue  # The worker replays results; never inject a second turn.
                else:
                    async with service.database.acquire() as db:
                        changed = await db.fetchval("""UPDATE messaging_inbox SET state='accepted',instance_epoch=$3,
                            execution_ref=$4 WHERE delivery_id=$1 AND lease_owner=$2 AND state='dispatching'
                            AND lease_until>now() RETURNING delivery_id""",row['delivery_id'],service.owner,ready['epoch'],ready['worker_id'])
                    if not changed: raise RuntimeError('Lease lost before dispatch')
                # accepted is a durable dispatch reservation, NOT execution proof.
                # Only the worker ledger and inbound_ack prove instance admission.
                payload = json.loads(row['payload'])
                if row['platform'] != 'uniagentgate': event = payload['event']
                else:
                    request = service.protocol.parse_agent_request(payload)
                    event = payload.get('_media_event') or {'text': request.text, 'source': {
                        'platform': 'uniagentgate', 'chat_id': request.phone_number, 'user_id': request.phone_number, 'chat_type': 'dm'}}
                event['message_id'] = row['delivery_id']
                event['source']['scope_id'] = row['user_id']
                await service.send_frame(ws, {'type': 'inbound', 'bufferId': row['delivery_id'], 'event': event})
                await asyncio.sleep(1)
            await heartbeat
    except asyncio.CancelledError:
        raise
    except UnverifiableExecution:
        error_code = 'execution_unverifiable'
    except Exception as error:
        log.warning('Delivery requires reconciliation: %s', type(error).__name__)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        async with service.database.acquire() as db:
            # Nothing was sent while dispatching; all later failures are ambiguous.
            await db.execute("""UPDATE messaging_inbox SET
                lease_owner=CASE WHEN state='dispatching' THEN NULL ELSE lease_owner END,
                instance_epoch=CASE WHEN state='dispatching' THEN NULL ELSE instance_epoch END,
                state=CASE WHEN state='dispatching' THEN 'queued' ELSE 'uncertain' END,
                error_code=$3,next_at=now()+LEAST(300,GREATEST(1,attempts)*30)*interval '1 second',lease_until=NULL,updated_at=now()
                WHERE delivery_id=$1 AND lease_owner=$2 AND state IN('dispatching','accepted','running','uncertain')""",
                delivery['delivery_id'],service.owner,error_code)
