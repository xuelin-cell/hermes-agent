"""Durable business-turn checkpoints, scoped by the outbox account and profile database."""

from contextlib import contextmanager
import json
import time

from .outbox import RETENTION
from .protocol import encode


class TurnJournal:
    def __init__(self, db, account):
        self.db, self.account = db, account
        db.executescript("""
            CREATE TABLE IF NOT EXISTS turn_journal (
                account TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL,
                execution_id TEXT, state TEXT NOT NULL, current INTEGER NOT NULL,
                snapshot TEXT NOT NULL, updated REAL NOT NULL, PRIMARY KEY(account,id));
            CREATE UNIQUE INDEX IF NOT EXISTS turn_journal_head
                ON turn_journal(account,session) WHERE current=1;
        """)
        self.prune()

    def prune(self):
        with self.db:
            self.db.execute("DELETE FROM turn_journal WHERE updated < ?", (time.time() - RETENTION,))
            self.db.execute("DELETE FROM turn_journal WHERE rowid IN "
                            "(SELECT rowid FROM turn_journal ORDER BY updated DESC LIMIT -1 OFFSET 10000)")

    @contextmanager
    def transaction(self):
        # A checkpoint and its frozen events must either both commit or both roll back.
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            yield

    def invalidate(self, session):
        self.db.execute("UPDATE turn_journal SET current=0 WHERE account=? AND session=?",
                        (self.account, session))

    def start(self, turn):
        if self.db.execute("SELECT 1 FROM turn_journal WHERE account=? AND id=?",
                           (self.account, turn.logical_id)).fetchone():
            return False
        self.invalidate(turn.session)
        self.db.execute("INSERT INTO turn_journal VALUES (?,?,?,?,?,1,?,?)",
                        (self.account, turn.logical_id, turn.session, turn.execution_id, turn.state,
                         encode(turn.snapshot()), time.time()))
        return True

    def resume(self, session, execution_id):
        if not execution_id:
            return None
        row = self.db.execute(
            "SELECT state,snapshot FROM turn_journal WHERE account=? AND session=? "
            "AND execution_id=? AND current=1", (self.account, session, execution_id)).fetchone()
        if not row or row[0] not in {"running", "interrupted"}:
            return None
        return row[0], json.loads(row[1])

    def save(self, turn):
        self.db.execute("UPDATE turn_journal SET execution_id=?,state=?,snapshot=?,updated=? "
                        "WHERE account=? AND id=?",
                        (turn.execution_id, turn.state, encode(turn.snapshot()), time.time(),
                         self.account, turn.logical_id))
