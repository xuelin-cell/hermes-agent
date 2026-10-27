"""Cloud implementations of the existing desktop share contracts."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timezone

from aiohttp import web

MAX_BYTES = 2 * 1024 * 1024
DIGEST = re.compile(r'^[a-f0-9]{64}$')
CSP = "default-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def iso(moment=None):
    return datetime.fromtimestamp(time.time() if moment is None else moment, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def fail(message):
    raise web.HTTPConflict(text=message)


def text(value, limit=2048):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise web.HTTPBadRequest(text='分享参数无效。')
    return value


def html_bytes(html, static=False):
    text(html, MAX_BYTES)
    if static:
        if not re.match(r'^<!doctype html>\s*<html[^>]*>\s*<head>', html, re.I) or re.search(r'<(?:script|iframe|frame|object|embed|form|base)\b|<meta\b[^>]*http-equiv', html, re.I):
            fail('分享页面不是完整的静态文档。')
        html = re.sub('<head>', f'<head><meta http-equiv="Content-Security-Policy" content="{CSP}">', html, count=1, flags=re.I)
    payload = html.encode('utf-8')
    if len(payload) > MAX_BYTES:
        fail('分享页面超过 2 MB，未发布截断内容。')
    return payload


def deadline(days):
    if type(days) is not int or not 1 <= days <= 7:
        raise web.HTTPBadRequest(text='有效期必须为 1～7 天的整数。')
    return iso(time.time() + days * 86400)


def active(record):
    return record and not record.get('deletedAt') and (not record.get('expiresAt') or record['expiresAt'] > iso())


class Shares:
    def __init__(self, store, gateway, instance, authorize):
        self.store, self.gateway, self.instance = store, gateway, instance
        self.tickets = {}
        self.authorize = authorize

    async def upload(self, identity, share_id, payload):
        await self.authorize(identity)
        return await self.gateway.upload(identity.token, share_id, payload)

    async def delete(self, identity, share_id):
        await self.authorize(identity)
        return await self.gateway.delete(identity.token, share_id)

    async def dispatch(self, identity, kind, operation, data):
        handlers = {
            'conversation': {'prepare': self.prepare, 'image': self.image, 'cancel': self.cancel,
                             'publish': self.publish_conversation, 'list': self.list_conversations, 'revoke': self.revoke_conversation},
            'artifact': {'eligibility': self.eligibility, 'revision': self.revision, 'mark-uploaded': self.mark_uploaded,
                         'inspect': self.inspect, 'publish': self.publish_artifact,
                         'expiration': self.expiration, 'revoke': self.revoke_artifact},
        }
        handler = handlers.get(kind, {}).get(operation)
        if handler is None:
            raise web.HTTPNotFound()
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text='分享参数无效。')
        if operation in {'inspect', 'list'}:
            await self.cleanup(identity)
        return await handler(identity, data)

    def owner(self, data):
        owner = data.get('owner') or {}
        if not isinstance(owner, dict) or owner.get('connectionId') not in (None, '', 'local') or owner.get('profile') not in (None, '', 'default'):
            fail('云端分享仅支持当前用户的默认实例。')
        return {'connectionId': 'local', 'profile': 'default'}

    def ticket(self, identity, data):
        ticket = self.tickets.get(data.get('ticket'))
        if not ticket or ticket['user'] != identity.user_id or ticket['login'] != identity.login_id or ticket['until'] <= time.time() or ticket['cancelled']:
            fail('分享准备已失效，请重新打开分享窗口。')
        return ticket

    async def snapshot(self, identity, source):
        text(source.get('sessionId'), 256)
        if source.get('scope') not in ('session', 'response'):
            raise web.HTTPBadRequest(text='分享范围无效。')
        result = await self.instance(identity, '/api/plugins/conversation-share/snapshot', source)
        document = result.get('document', {})
        if not DIGEST.fullmatch(str(document.get('snapshotId', ''))) or not DIGEST.fullmatch(str(result.get('revision', ''))) or document.get('schemaVersion') != 1 or document.get('scope') != source['scope'] or not isinstance(document.get('messages'), list):
            fail('实例未返回可信的完整快照。')
        return result

    async def prepare(self, identity, data):
        owner = self.owner(data)
        source = data.get('request')
        if not isinstance(source, dict):
            raise web.HTTPBadRequest(text='分享参数无效。')
        snapshot = await self.snapshot(identity, source)
        self.tickets = {key: item for key, item in self.tickets.items() if item['until'] > time.time() and not item['cancelled']}
        size = len(json.dumps(snapshot, ensure_ascii=False).encode())
        if len(self.tickets) >= 1024 or size + sum(t['bytes'] for t in self.tickets.values()) > 32 * MAX_BYTES or sum(t['user'] == identity.user_id for t in self.tickets.values()) >= 8:
            fail('同时准备的分享过多，请关闭其他分享窗口后重试。')
        ticket = secrets.token_hex(24)
        self.tickets[ticket] = {'user': identity.user_id, 'login': identity.login_id,
            'until': min(time.time() + 600, identity.expires_at / 1000), 'owner': owner,
            'source': source, 'snapshot': snapshot, 'bytes': size, 'cancelled': False}
        return {'ticket': ticket, 'document': snapshot['document']}

    async def image(self, identity, data):
        ticket = self.ticket(identity, data)
        asset = next((item for item in ticket['snapshot']['document'].get('assets', []) if item['reference'] == data.get('reference')), None)
        if asset is None:
            fail('图片未在可信快照中登记。')
        result = await self.instance(identity, '/api/fs/read-data-url', {
            'session_id': ticket['snapshot']['sessionId'], 'path': asset['path']})
        data_url = result.get('dataUrl', '')
        if not isinstance(data_url, str) or len(data_url) > MAX_BYTES * 1.4:
            fail('图片超过大小限制。')
        match = re.fullmatch(r'data:image/(?:png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/=]+)', data_url)
        if not match:
            fail('图片格式不受支持。')
        try:
            valid = digest(base64.b64decode(match[1], validate=True)) == asset['hash']
        except ValueError:
            valid = False
        if not valid:
            fail('图片内容已变化，请重新准备分享。')
        self.ticket(identity, data)
        return data_url

    async def cancel(self, identity, data):
        ticket = self.tickets.get(data.get('ticket'))
        if ticket and ticket['user'] == identity.user_id and ticket['login'] == identity.login_id:
            ticket['cancelled'] = True
            self.tickets.pop(data['ticket'], None)
        return None

    async def publish_conversation(self, identity, data):
        ticket = self.ticket(identity, data)
        snapshot = ticket['snapshot']
        key = digest(json.dumps([identity.user_id, ticket['owner'], ticket['source']['sessionId'],
            ticket['source']['scope'], snapshot['document']['snapshotId']], sort_keys=True).encode())
        async with self.store.locked(identity.user_id, 'conversation', key) as slot:
            latest = await self.snapshot(identity, ticket['source'])
            if latest['revision'] != snapshot['revision'] or latest['document']['snapshotId'] != snapshot['document']['snapshotId']:
                fail('会话在准备期间发生变化，请重新分享。')
            self.ticket(identity, data)
            record, pending, payload = await slot.load()
            if record and record.get('state') == 'published':
                return record
            if not pending:
                payload = html_bytes(data.get('html'), static=True)
                pending = {'key': key, 'shareId': secrets.token_hex(24), 'snapshotId': snapshot['document']['snapshotId'],
                    'scope': ticket['source']['scope'], 'title': snapshot['document']['title'], 'createdAt': iso(),
                    'state': 'pending', 'owner': ticket['owner'], 'sessionId': ticket['source']['sessionId']}
                await slot.prepare(pending, payload)
            url = await self.upload(identity, pending['shareId'], payload)
            self.ticket(identity, data)
            record = {**pending, 'state': 'published', 'url': url}
            await slot.save(record)
            return record

    async def list_conversations(self, identity, data):
        self.owner(data)
        session_id = text(data.get('sessionId'), 256)
        records = await self.store.records(identity.user_id, 'conversation')
        return sorted((r for r in records if r['sessionId'] == session_id), key=lambda r: r['createdAt'], reverse=True)

    async def revoke_conversation(self, identity, data):
        key = text(data.get('key'))
        async with self.store.locked(identity.user_id, 'conversation', key) as slot:
            record, pending, _ = await slot.load()
            candidate = pending or record
            if candidate and candidate.get('state') != 'revoked':
                await self.delete(identity, candidate['shareId'])
                await slot.save({**candidate, 'state': 'revoked'})
        return None

    async def artifact(self, identity, operation, data):
        return await self.instance(identity, '/api/plugins/conversation-share/artifact/' + operation, data)

    async def revision(self, identity, data):
        return await self.artifact(identity, 'revision', {})

    async def eligibility(self, identity, data):
        return await self.artifact(identity, 'eligibility', data.get('source', {}))

    async def mark_uploaded(self, identity, data):
        await self.artifact(identity, 'mark-uploaded', {'sessionId': text(data.get('sessionId'), 256)})
        return None

    async def inspect(self, identity, data):
        query = data.get('query')
        records = await self.store.records(identity.user_id, 'artifact')
        if isinstance(query, str):
            return next((r for r in records if r['key'] == query), None)
        if isinstance(query, dict):
            return next((r for r in records if r['shareId'] == query.get('shareId')), None)
        raise web.HTTPBadRequest(text='分享标识无效。')

    async def publish_artifact(self, identity, data):
        key = text(data.get('key'))
        payload = html_bytes(data.get('html'))
        title = text(data.get('title'), 2048)[:200]
        async with self.store.locked(identity.user_id, 'artifact', key) as slot:
            # This is a fresh instance-side check of actual bytes and persisted provenance.
            result = await self.artifact(identity, 'verify', {'source': data.get('source'), 'html': data['html']})
            if not result.get('publishable'):
                fail('只能分享来源已确认的模型产物。')
            source_hash = result.get('sourceHash')
            record, pending, frozen = await slot.load()
            if pending and not active(pending):
                await self.delete(identity, pending['shareId'])
                record = {**pending, 'url': '', 'deletedAt': iso()}
                await slot.save(record)
                pending = None
            if active(record) and not pending and data.get('ttlDays') is None and (record['hash'] == digest(payload) or source_hash and record.get('sourceHash') == source_hash):
                return record
            if not pending and record and not active(record) and not record.get('deletedAt'):
                await self.delete(identity, record['shareId'])
                record = {**record, 'deletedAt': iso()}
                await slot.save(record)
            if pending:
                if pending['hash'] != digest(payload):
                    fail('上次上传结果待确认，请先重试原内容或取消分享。')
                payload = frozen
            else:
                share_id = record['shareId'] if active(record) else secrets.token_urlsafe(24)
                pending = {'key': key, 'shareId': share_id, 'title': title, 'hash': digest(payload),
                    'version': (record['version'] if active(record) else 0) + 1, 'updatedAt': iso(),
                    'expiresAt': deadline(data['ttlDays']) if 'ttlDays' in data else (record.get('expiresAt') if active(record) else deadline(1))}
                if source_hash:
                    pending['sourceHash'] = source_hash
                await slot.prepare(pending, payload)
            url = await self.upload(identity, pending['shareId'], payload)
            record = {**pending, 'url': url}
            await slot.save(record)
            return record

    async def expiration(self, identity, data):
        key = text(data.get('key'))
        expires = deadline(data.get('ttlDays'))
        async with self.store.locked(identity.user_id, 'artifact', key) as slot:
            record, pending, _ = await slot.load()
            if pending or not record or record.get('deletedAt') or record['shareId'] != data.get('shareId'):
                fail('分享状态已变化，请重新确认。')
            record = {**record, 'expiresAt': expires, 'updatedAt': iso()}
            await slot.save(record)
            return record

    async def revoke_artifact(self, identity, data):
        key = text(data.get('key'))
        async with self.store.locked(identity.user_id, 'artifact', key) as slot:
            record, pending, _ = await slot.load()
            candidate = pending or record
            if not candidate:
                return None
            if data.get('shareId') and candidate['shareId'] != data['shareId']:
                fail('分享状态已变化，请重新确认。')
            if not candidate.get('deletedAt'):
                await self.delete(identity, candidate['shareId'])
            await slot.save({**candidate, 'deletedAt': iso()})
        return None

    async def cleanup(self, identity):
        # No credentials are cached. Cleanup resumes when this owner next returns with a token.
        for key in await self.store.expired(identity.user_id, iso()):
            async with self.store.locked(identity.user_id, 'artifact', key) as slot:
                record, pending, _ = await slot.load()
                candidate = pending or record
                if not candidate or active(candidate) or candidate.get('deletedAt'):
                    continue
                try:
                    await self.delete(identity, candidate['shareId'])
                except web.HTTPBadGateway:
                    continue  # Keep the durable record for the next authenticated visit.
                await slot.save({**candidate, 'deletedAt': iso()})
