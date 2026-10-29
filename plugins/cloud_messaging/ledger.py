"""Instance execution receipts survive transport loss and instance state restoration."""
from contextlib import contextmanager
import json
import sqlite3
from pathlib import Path


class Ledger:
    def __init__(self, home):
        self.path = Path(home) / 'messaging-executions.db'
        with self.open() as db:
            db.execute('CREATE TABLE IF NOT EXISTS executions(delivery_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,queued INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
            db.execute('CREATE TABLE IF NOT EXISTS media_receipts(delivery_id TEXT NOT NULL,media_id TEXT NOT NULL,payload TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(delivery_id,media_id))')
            if 'binding_id' not in {r[1] for r in db.execute('PRAGMA table_info(executions)')}:
                db.execute("ALTER TABLE executions ADD COLUMN binding_id TEXT NOT NULL DEFAULT ''")
            # A restarted process cannot know whether a tool already performed its side effect.
            db.execute("UPDATE executions SET state='uncertain' WHERE state IN('accepted','running')")

    @contextmanager
    def open(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def pending(self, revision, binding=""):
        with self.open() as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM executions WHERE state='completed' AND queued=0 AND revision=? AND binding_id=? ORDER BY updated_at LIMIT 20",(revision,binding))]

    def queued(self, delivery):
        with self.open() as db:
            db.execute('UPDATE executions SET queued=1 WHERE delivery_id=?',(delivery,))

    def running(self, delivery):
        with self.open() as db:
            db.execute("UPDATE executions SET state='running' WHERE delivery_id=? AND state='accepted'",(delivery,))

    def get(self, delivery):
        with self.open() as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM executions WHERE delivery_id=?',(delivery,)).fetchone()
            return dict(row) if row else None

    def accept(self, delivery, chat, revision, binding=""):
        with self.open() as db:
            cursor = db.execute("INSERT OR IGNORE INTO executions(delivery_id,chat_id,revision,state,binding_id) VALUES(?,?,?,'accepted',?)",(delivery,chat,revision,binding))
            return cursor.rowcount == 1

    def complete(self, delivery, content):
        with self.open() as db:
            row = db.execute('SELECT result FROM executions WHERE delivery_id=?',(delivery,)).fetchone()
            if row is None: raise ValueError('No accepted delivery')
            if row[0] is not None:
                if row[0] != content: raise ValueError('Completed output is immutable')
                return
            db.execute("UPDATE executions SET state='completed',result=?,updated_at=CURRENT_TIMESTAMP WHERE delivery_id=?",(content,delivery))

    def media_accept(self, delivery, media):
        with self.open() as db:
            if not db.execute('SELECT 1 FROM executions WHERE delivery_id=?',(delivery,)).fetchone(): raise ValueError('Unknown execution')
            db.execute('INSERT OR IGNORE INTO media_receipts(delivery_id,media_id,payload) VALUES(?,?,?)',(delivery,media['id'],json.dumps(media)))

    def media_queued(self, delivery, media_id):
        with self.open() as db:
            db.execute('UPDATE media_receipts SET queued=1 WHERE delivery_id=? AND media_id=?',(delivery,media_id))

    def media_pending(self, revision, binding):
        with self.open() as db:
            db.row_factory=sqlite3.Row
            return [dict(row) for row in db.execute('SELECT m.*,e.chat_id FROM media_receipts m JOIN executions e USING(delivery_id) WHERE m.queued=0 AND e.revision=? AND e.binding_id=? ORDER BY e.updated_at LIMIT 20',(revision,binding))]

    def delivered_media(self, delivery):
        with self.open() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM media_receipts WHERE delivery_id=? AND queued=1',(delivery,))]
