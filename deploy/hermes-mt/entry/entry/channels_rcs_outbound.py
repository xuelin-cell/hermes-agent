"""One final RCS text/media frame, backed by the existing per-part outbox receipts."""
import json

from .messaging_oss import OssUploadFailed
from .messaging_rcs import prepare


async def _claim(service, row):
    async with service.database.acquire() as db, db.transaction():
        binding = await db.fetchrow("""SELECT b.* FROM messaging_bindings b JOIN users u USING(user_id)
            WHERE b.id=$1 AND u.status='active' FOR UPDATE OF b""", row['binding_id'])
        if not binding or not binding['enabled'] or binding['deleted_at'] or binding['revision'] != row['binding_revision']:
            return None
        inbox = await db.fetchrow('SELECT * FROM messaging_inbox WHERE delivery_id=$1 AND binding_id=$2 FOR UPDATE',
                                  row['delivery_id'], row['binding_id'])
        if not inbox or inbox['state'] != 'completed' or inbox['binding_revision'] != binding['revision']:
            return None
        parts = await db.fetch('SELECT * FROM messaging_outbox WHERE delivery_id=$1 ORDER BY part_index FOR UPDATE', row['delivery_id'])
        # Never pair a new send with a frame whose acceptance is ambiguous.
        if not any(part['part_index'] == 0 for part in parts) or any(part['state'] in {'sending', 'unknown'} for part in parts):
            return None
        pending = [part for part in parts if part['state'] == 'pending']
        if not pending:
            return None
        message_id = 'msg_cms_' + pending[0]['outbound_id']
        ids = [part['outbound_id'] for part in pending]
        await db.execute("""UPDATE messaging_outbox SET state='sending',attempts=attempts+1,
            platform_message_id=$2,updated_at=now() WHERE outbound_id=ANY($1::text[])""", ids, message_id)
        previous_failure = any(part['part_index'] > 0 and part['state'] == 'failed' for part in parts)
        return inbox, pending, message_id, previous_failure


async def _finish(service, row, results):
    async with service.database.acquire() as db, db.transaction():
        # Match claim/disable/credential rotation: binding before outbox rows.
        await db.execute('SELECT id FROM messaging_bindings WHERE id=$1 FOR UPDATE', row['binding_id'])
        for identifier, (state, code, receipt) in results.items():
            await db.execute("""UPDATE messaging_outbox SET state=$2,error_code=$3,platform_ack=$4::jsonb,
                updated_at=now() WHERE outbound_id=$1 AND state='sending'""",
                             identifier, state, code, json.dumps(receipt))


async def send_final(service, row):
    client = service.clients.get(row['binding_id'])
    if not client or client[0] != row['binding_revision'] or client[1].health.state != 'running':
        return
    claim = await _claim(service, row)
    if claim is None:
        return
    inbox, parts, message_id, previous_failure = claim
    results, ready, media, texts = {}, [], [], []
    # The caller's pending rows are immutable. A lost process is recovered as
    # unknown for the entire claimed bundle, never replayed as independent parts.
    for part in parts:
        identifier = part['outbound_id']
        content = json.loads(part['payload'])
        if 'media' not in content:
            if content.get('content'):
                texts.append(content['content'])
            ready.append(identifier)
            continue
        try:
            try:
                item, native = await prepare(content['media'])
            except Exception:
                results[identifier] = ('failed', 'media_preparation_failed', {'ok': False})
                continue
            url = await service.oss.public_url(row['user_id'], item)
            if native:
                media.append({'url': url, 'kind': item['kind'], 'mime_type': item['mime'], 'file_name': item['name']})
                if item.get('caption') and not texts:
                    texts.append(item['caption'])
            else:
                texts.append('📎 ' + item['name'] + ' 下载链接：' + url)
            ready.append(identifier)
        except OssUploadFailed:
            results[identifier] = ('failed', 'media_oss_upload_failed', {'ok': False})
    if results or previous_failure:
        texts.append('⚠️ 部分附件未能发送：附件处理或 OSS 上传失败，请在网页会话中查看。')
    text = '\n\n'.join(dict.fromkeys(texts))
    if media and not text:
        text = '附件已生成，请查看。'
    receipt = {'ok': True, 'bundled_outbound_ids': [part['outbound_id'] for part in parts]}
    state, code = 'sent', ''
    try:
        if text or media:
            # Uploads may take time. Recheck ownership and use the current upstream
            # connection, including one replaced by a manual reconnect meanwhile.
            async with service.database.acquire() as db:
                permitted = await db.fetchval("""SELECT 1 FROM messaging_bindings b JOIN users u USING(user_id)
                    WHERE b.id=$1 AND b.revision=$2 AND b.enabled AND b.deleted_at IS NULL AND u.status='active'""",
                                              row['binding_id'], row['binding_revision'])
            if not permitted:
                await _finish(service, row, {part['outbound_id']: ('cancelled', 'binding_changed', None) for part in parts})
                return
            client = service.clients.get(row['binding_id'])
            if not client or client[0] != row['binding_revision'] or client[1].health.state != 'running':
                # No downlink attempted: reconnect may safely retry the prepared send.
                results.update({identifier: ('pending', '', None) for identifier in ready})
                await _finish(service, row, results)
                return
            request = service.protocol.parse_agent_request(json.loads(inbox['payload']))
            _, ack = await client[1].send_channel_message(
                phone_number=request.phone_number, text=text, media=media,
                session_id=request.session_id, turn_id=request.turn_id, message_id=message_id)
            receipt['downlink_msg_ids'] = ack.downlink_msg_ids
        else:
            receipt['local_completion'] = True
    except service.stream.DownlinkRejected:
        state, code, receipt = 'failed', 'gateway_rejected', {'ok': False}
    except Exception:
        state, code, receipt = 'unknown', 'outbound_unconfirmed', None
    for identifier in ready:
        results[identifier] = (state, code, receipt)
    # A media failure stays failed even when its explanatory text was accepted.
    for identifier, (part_state, part_code, part_receipt) in list(results.items()):
        if identifier not in ready and part_receipt is not None:
            results[identifier] = (part_state, part_code, {**part_receipt, 'failure_notice': state,
                                                        'notice_downlink_msg_ids': (receipt or {}).get('downlink_msg_ids', [])})
    await _finish(service, row, results)
