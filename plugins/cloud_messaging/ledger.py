"""Instance execution receipts survive transport loss and instance state restoration."""
from contextlib import contextmanager
import sqlite3
from pathlib import Path


class Ledger:
    def __init__(self, home):
        self.path = Path(home) / 'messaging-executions.db'
        with self.open() as db:
            db.execute('CREATE TABLE IF NOT EXISTS executions(delivery_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,queued INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
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

    def pending(self, revision):
        with self.open() as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM executions WHERE state='completed' AND queued=0 AND revision=? ORDER BY updated_at LIMIT 20",(revision,))]

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

    def accept(self, delivery, chat, revision):
        with self.open() as db:
            cursor = db.execute("INSERT OR IGNORE INTO executions(delivery_id,chat_id,revision,state) VALUES(?,?,?,'accepted')",(delivery,chat,revision))
            return cursor.rowcount == 1

    def complete(self, delivery, content):
        with self.open() as db:
            row = db.execute('SELECT result FROM executions WHERE delivery_id=?',(delivery,)).fetchone()
            if row is None: raise ValueError('No accepted delivery')
            if row[0] is not None:
                if row[0] != content: raise ValueError('Completed output is immutable')
                return
            db.execute("UPDATE executions SET state='completed',result=?,updated_at=CURRENT_TIMESTAMP WHERE delivery_id=?",(content,delivery))
