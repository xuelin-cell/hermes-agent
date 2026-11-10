"""SQLite outbox adapted from UniClaw usage_uploader; transport is Electron-owned.

The writer and sender use separate connections. No disk or network work runs in hooks.
"""

import math
import time
from contextlib import nullcontext

from .protocol import MAX_BODY_BYTES, encode

RETENTION = 29 * 86400


class Outbox:
    def __init__(self, db, account, client):
        self.db, self.account, self.client = db, account, client
        db.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
                created REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                error TEXT, PRIMARY KEY(account,id));
            CREATE TABLE IF NOT EXISTS receipts (
                account TEXT NOT NULL, id TEXT NOT NULL, created REAL NOT NULL,
                PRIMARY KEY(account,id));
            CREATE TABLE IF NOT EXISTS sessions (
                account TEXT NOT NULL, alias TEXT NOT NULL, root TEXT NOT NULL, created REAL NOT NULL,
                PRIMARY KEY(account,alias));
        """)
        self.prune()

    def prune(self):
        with self.db:
            for table in ("events", "receipts", "sessions"):
                self.db.execute(f"DELETE FROM {table} WHERE created < ?", (time.time() - RETENTION,))
                self.db.execute(f"DELETE FROM {table} WHERE rowid IN "
                                f"(SELECT rowid FROM {table} ORDER BY created DESC LIMIT -1 OFFSET 10000)")

    def session_for(self, session, task):
        """Compression rotates session IDs while the desktop's task/session key stays bound."""
        aliases = ["session:" + session] + (["task:" + task] if task else [])
        root = session
        for alias in aliases:
            row = self.db.execute("SELECT root FROM sessions WHERE account=? AND alias=?",
                                  (self.account, alias)).fetchone()
            if row:
                root = row[0]
                break
        with nullcontext() if self.db.in_transaction else self.db:
            for alias in aliases:
                self.db.execute("INSERT OR IGNORE INTO sessions VALUES (?,?,?,?)",
                                (self.account, alias, root, time.time()))
        return root

    def write(self, receipt, events):
        """First occurrence wins, including the timestamp of a plugin's first use."""
        with nullcontext() if self.db.in_transaction else self.db:
            if self.db.execute("SELECT 1 FROM receipts WHERE account=? AND id=?",
                               (self.account, receipt)).fetchone():
                return
            for event in events:
                payload = encode(event)
                if len(payload.encode("utf-8")) > MAX_BODY_BYTES - 1024:
                    raise ValueError("event too large")
                self.db.execute("INSERT OR IGNORE INTO events(account,id,payload,created) VALUES (?,?,?,?)",
                                (self.account, event["eventId"], payload, time.time()))
            self.db.execute("INSERT INTO receipts VALUES (?,?,?)", (self.account, receipt, time.time()))

    def batch(self, limit=50):
        rows = self.db.execute("SELECT id,payload FROM events WHERE account=? AND state='pending' "
                               "ORDER BY created,rowid LIMIT ?", (self.account, limit)).fetchall()
        prefix = '{"client":' + encode(self.client) + ',"events":['
        selected, parts = [], []
        size = len((prefix + ']}').encode("utf-8"))
        for identifier, payload in rows:
            extra = len(payload.encode("utf-8")) + bool(parts)
            if size + extra > MAX_BODY_BYTES:
                break
            selected.append(identifier)
            parts.append(payload)
            size += extra
        return selected, (prefix + ','.join(parts) + ']}').encode("utf-8")

    def acknowledge(self, rows):
        with self.db:
            self.db.executemany("UPDATE events SET state=?,error=? WHERE account=? AND id=?",
                                [(state, error, self.account, identifier) for identifier, state, error in rows])

    def status(self):
        return dict(self.db.execute("SELECT state,count(*) FROM events WHERE account=? GROUP BY state",
                                    (self.account,)).fetchall())


class Sender:
    def __init__(self, outbox, transport):
        self.outbox, self.transport = outbox, transport
        self.limit = 50
        self.retry_at = 0.0
        self.failures = 0
        self.paused_revision = None
        self.format_paused = False
        self.last_code = None

    def backoff(self, seconds=None):
        self.failures += 1
        self.retry_at = time.monotonic() + (seconds if seconds is not None else 2 ** min(self.failures, 8))

    def send_once(self, context):
        if (not context or context.get("account") != self.outbox.account
                or not context.get("enabled") or self.format_paused
                or context.get("revision") == self.paused_revision or time.monotonic() < self.retry_at):
            return False
        identifiers, body = self.outbox.batch(self.limit)
        if not identifiers:
            return False
        try:
            # Bridge checks the account again and forwards the original UTF-8 bytes (int64 safe).
            response = self.transport(body, self.outbox.account)
            code = response["status"]
            data = response.get("body")
            if code == 200:
                code = data.get("code") if isinstance(data, dict) else None
            self.last_code = code
            if code in (401, 403):
                self.paused_revision = context.get("revision")
                return False
            if code in (400, 415):
                self.format_paused = True
                return False
            if code == 413:
                if len(identifiers) == 1:
                    self.outbox.acknowledge([(identifiers[0], "rejected", "PAYLOAD_TOO_LARGE")])
                else:
                    self.limit = max(1, len(identifiers) // 2)
                self.backoff(1)
                return False
            if code == 429:
                try:
                    delay = float(response.get("retryAfter") or 60)
                    delay = max(1, delay) if math.isfinite(delay) else 60
                except (ValueError, TypeError):
                    delay = 60
                self.backoff(delay)
                return False
            if type(code) is not int or code != 200:
                self.backoff()
                return False
            results = data["data"]["results"]
            if not isinstance(results, list) or len(results) != len(identifiers):
                raise ValueError("incomplete receipt")
            seen, acknowledgements = set(), []
            for result in results:
                index, status = result["index"], result["status"]
                if type(index) is not int or not 0 <= index < len(identifiers) or index in seen:
                    raise ValueError("invalid receipt index")
                seen.add(index)
                if status in ("accepted", "duplicate"):
                    acknowledgements.append((identifiers[index], "sent", None))
                elif status == "rejected" and result.get("retryable") is False:
                    acknowledgements.append((identifiers[index], "rejected", str(result.get("errorCode", "UNKNOWN"))[:64]))
                elif status != "rejected" or result.get("retryable") is not True:
                    raise ValueError("invalid receipt outcome")
            # Validate the WHOLE response before acknowledging any item.
            self.outbox.acknowledge(acknowledgements)
            if len(acknowledgements) != len(identifiers):
                self.backoff()
            else:
                self.failures, self.retry_at = 0, 0
                return len(identifiers) == self.limit
        except Exception:
            self.last_code = "transport_or_receipt_error"
            self.backoff()
        return False
