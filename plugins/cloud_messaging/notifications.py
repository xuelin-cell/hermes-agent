"""Durable standalone sends for cron; Entry owns platform credentials and final ACKs."""
from contextlib import contextmanager
import asyncio
import json
import mimetypes
import secrets
import sqlite3
import time
from pathlib import Path

from .media import pack, MAX_MEDIA_BYTES, MAX_MESSAGE_BYTES

PLATFORMS = {'uniagentgate': '5G 消息', 'dingtalk': '钉钉', 'feishu': '飞书', 'weixin': '微信', 'wecom': '企业微信'}


def root_home(home):
    from hermes_constants import named_profile_home
    named = named_profile_home(Path(home))
    return named.parent.parent if named else Path(home)


class Notifications:
    def __init__(self, home):
        self.directory = root_home(home) / 'cloud-messaging-notifications'
        self.path = self.directory / 'outbox.sqlite3'

    @contextmanager
    def connect(self):
        if self.directory.is_symlink() or self.path.is_symlink():
            raise ValueError('Invalid notification store')
        self.directory.mkdir(mode=0o700, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        self.path.chmod(0o600)
        db.execute('CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL)')
        try:
            with db:
                yield db
        finally:
            db.close()

    def enqueue(self, platform, chat, content, media):
        if platform not in PLATFORMS or not isinstance(chat, str) or not 0 < len(chat) <= 512 or len(content) > 20000:
            raise ValueError('Invalid notification target')
        identifier = secrets.token_hex(16)
        with self.connect() as db:
            if db.execute("SELECT COUNT(*) FROM notifications WHERE state IN('pending','queued')").fetchone()[0] >= 32:
                raise ValueError('Notification queue full')
            db.execute("DELETE FROM notifications WHERE state NOT IN('pending','queued') AND created<?", (time.time()-86400,))
            db.execute('INSERT INTO notifications VALUES(?,?,?,?)', (identifier, json.dumps({
                'id': identifier, 'platform': platform, 'chat': chat, 'content': content, 'media': media}), 'pending', time.time()))
        return identifier

    def pending(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT payload FROM notifications WHERE state IN('pending','queued') ORDER BY created LIMIT 1")]

    def status(self, identifier):
        with self.connect() as db:
            row = db.execute('SELECT state FROM notifications WHERE id=?', (identifier,)).fetchone()
            return row[0] if row else 'unknown'

    def acknowledge(self, identifier, state):
        if state not in {'queued', 'sent', 'failed', 'unknown', 'cancelled'}:
            raise ValueError('Invalid notification receipt')
        with self.connect() as db:
            db.execute("UPDATE notifications SET state=? WHERE id=? AND state IN('pending','queued')", (state, identifier))


async def send_notification(platform, pconfig, chat_id, message, *, media_files=None, **kwargs):
    from hermes_constants import get_hermes_home
    from gateway.platforms.base import validate_media_delivery_path
    media, total = [], 0
    for path, voice in media_files or []:
        safe = validate_media_delivery_path(path)
        if not safe: return {'error': 'Notification attachment path unavailable'}
        with Path(safe).open('rb') as file:
            raw = file.read(MAX_MEDIA_BYTES+1)
        total += len(raw)
        if total > MAX_MESSAGE_BYTES: return {'error': 'Notification attachments exceed limit'}
        mime = mimetypes.guess_type(safe)[0] or 'application/octet-stream'
        kind = 'audio' if voice else mime.split('/')[0] if mime.startswith(('image/', 'audio/', 'video/')) else 'file'
        media.append(pack(raw, Path(safe).name, kind))
    store = Notifications(get_hermes_home())
    identifier = await asyncio.to_thread(store.enqueue, platform, str(chat_id), message, media)
    deadline = time.monotonic()+75
    while time.monotonic() < deadline:
        state = await asyncio.to_thread(store.status, identifier)
        if state == 'sent': return {'success': True, 'message_id': identifier, 'media_delivered': bool(media)}
        if state in {'failed', 'unknown', 'cancelled'}:
            return {'error': 'Notification delivery '+state+'; check the original task before resending'}
        await asyncio.sleep(.25)
    return {'error': 'Notification queued but delivery not confirmed; do not resend blindly'}
