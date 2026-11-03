"""Instance-local, persistent artifact provenance; no browser assertion can grant origin."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

MAX_BYTES = 2 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compose(content):
    import re
    if re.search(r'<html[\s>]|<!doctype\s+html', content, re.I):
        return content
    return '\n'.join(['<!doctype html>', '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        '<style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>', content, '</body></html>'])


class Origins:
    def __init__(self, home):
        self.home = Path(home).resolve()
        self.path = self.home / 'cloud-artifact-origins.db'
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS origins(session TEXT PRIMARY KEY, record TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS revision(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)')
        self.path.chmod(0o600)

    @contextmanager
    def db(self):
        with sqlite3.connect(self.path, timeout=5) as db:
            yield db

    def revision(self):
        with self.db() as db:
            row = db.execute('SELECT value FROM revision WHERE id=1').fetchone()
            return row[0] if row else 0

    def read(self, db, sid):
        if not isinstance(sid, str) or not sid or len(sid) > 512:
            raise ValueError('产物会话标识无效。')
        row = db.execute('SELECT record FROM origins WHERE session=?', (sid,)).fetchone()
        return json.loads(row[0]) if row else {'verified': False, 'hasUploads': False, 'parent': None, 'files': {}, 'inline': []}

    def write(self, db, sid, record):
        db.execute('INSERT INTO origins VALUES(?,?) ON CONFLICT(session) DO UPDATE SET record=excluded.record',
                   (sid, json.dumps(record, ensure_ascii=False)))
        db.execute('INSERT INTO revision VALUES(1,1) ON CONFLICT(id) DO UPDATE SET value=value+1')

    def record(self, event):
        if Path(event['profileHome']).resolve() != self.home:
            raise ValueError('产物来源不属于当前实例配置。')
        sid = event['sessionId']
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            record = self.read(db, sid)
            parent = event.get('parentSessionId')
            if parent and parent != sid:
                record['parent'] = record['parent'] or parent
            inherited = self.read(db, record['parent']) if record['parent'] else None
            if inherited and inherited['verified']:
                record['verified'] = True
                record['files'] = {**inherited['files'], **record['files']}
                record['inline'] = list(dict.fromkeys(inherited['inline'] + record['inline']))[-256:]
            if event['type'] == 'context':
                record['verified'] |= event.get('fresh') is True and not inherited
                record['hasUploads'] |= event.get('hasUploads') is True
            elif record['verified']:
                for file in event.get('files', [])[:128]:
                    path = Path(file['path']).resolve(strict=True)
                    if not path.is_file() or path.stat().st_size > MAX_BYTES:
                        continue
                    data = path.read_bytes()
                    previous = record['files'].get(str(path))
                    if sha(data) != file['hash'] or not file.get('replace') and not previous:
                        continue
                    record['files'][str(path)] = {'hash': file['hash'], 'upload': record['hasUploads'] or bool(previous and previous['upload'])}
                for content in event.get('contents', [])[-24:]:
                    if isinstance(content, str) and len(content.encode()) <= MAX_BYTES:
                        record['inline'] = list(dict.fromkeys(record['inline'] + [sha(content.encode())]))[-256:]
            self.write(db, sid, record)

    def mark_uploaded(self, sid):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            record = self.read(db, sid)
            record['hasUploads'] = True
            self.write(db, sid, record)

    def reason(self, db, sid, seen=None):
        seen = set() if seen is None else seen
        if sid in seen or len(seen) >= 16:
            return 'unknown_origin'
        seen.add(sid)
        record = self.read(db, sid)
        if record['hasUploads']:
            return 'user_upload'
        if not record['verified']:
            return 'unknown_origin'
        return self.reason(db, record['parent'], seen) if record['parent'] else None

    def eligibility(self, source):
        with self.db() as db:
            reason = self.reason(db, source.get('sessionId'))
            record = self.read(db, source['sessionId'])
        if reason:
            return {'publishable': False, 'reason': reason}
        if source.get('path'):
            try:
                path = Path(source['path']).resolve(strict=True)
                origin = record['files'].get(str(path))
                if not origin or origin['upload']:
                    return {'publishable': False, 'reason': 'unknown_origin'}
                valid = path.is_file() and path.stat().st_size <= MAX_BYTES and sha(path.read_bytes()) == origin['hash']
                valid &= not source.get('hash') or source['hash'] == origin['hash']
            except (FileNotFoundError, OSError):
                valid = False
            return {'publishable': bool(valid), 'reason': None if valid else 'content_changed'}
        content = source.get('content')
        valid = isinstance(content, str) and sha(content.encode()) in record['inline']
        return {'publishable': valid, 'reason': None if valid else 'unknown_origin'}

    def verify(self, source, html):
        result = self.eligibility(source)
        if not result['publishable']:
            return result
        if source.get('path'):
            path = Path(source['path']).resolve(strict=True)
            data = path.read_bytes()
            fingerprint = sha(data)
            valid = source.get('hash') == fingerprint
            if path.suffix.lower() in {'.htm', '.html'}:
                valid &= sha(html.encode()) == fingerprint
            if not valid:
                return {'publishable': False, 'reason': 'content_changed'}
            return {**result, 'sourceHash': fingerprint}
        return result if html == compose(source['content']) else {'publishable': False, 'reason': 'content_changed'}


def current():
    from hermes_constants import get_hermes_home
    return Origins(get_hermes_home())
