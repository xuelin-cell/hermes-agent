"""Coordinate public Wikimedia traffic across PPT subprocesses on this machine.

The shared state contains only host names, reservation times and cooldowns;
it deliberately contains no profile data, queries, credentials or images.
"""
from __future__ import annotations

import email.utils
from contextlib import contextmanager
import sqlite3
import tempfile
import time
from pathlib import Path


class CoolingDown(OSError):
    def __init__(self, seconds):
        self.retry_after_seconds = max(1, int(seconds + 0.999))
        super().__init__(f"Wikimedia cooling down; retry after {self.retry_after_seconds}s or use another reliable source")


def retry_delay(value, *, now=None, fallback=60):
    now = time.time() if now is None else now
    if value:
        try:
            return max(5, float(value))
        except ValueError:
            try:
                return max(5, email.utils.parsedate_to_datetime(value).timestamp() - now)
            except (ValueError, TypeError, OverflowError):
                pass
    return fallback


class TrafficGate:
    def __init__(self, path=None, interval=7):
        # Public transport policy is shared across task/profile boundaries because
        # those subprocesses usually share the same unauthenticated network exit.
        self.path = Path(path) if path else Path(tempfile.gettempdir()) / "uniwork-ppt-commons" / "traffic.sqlite3"
        self.interval = interval

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute("CREATE TABLE IF NOT EXISTS traffic (host TEXT PRIMARY KEY, next_at REAL, cool_until REAL)")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def acquire(self, host):
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT next_at,cool_until FROM traffic WHERE host=?", (host,)).fetchone() or (0, 0)
            if row[1] > now:
                raise CoolingDown(row[1] - now)
            slot = max(now, row[0])
            db.execute("INSERT OR REPLACE INTO traffic VALUES (?,?,?)", (host, slot + self.interval, row[1]))
        if slot > now:
            time.sleep(slot - now)
        # A different subprocess can receive 429 while this one waits for its slot.
        with self.connect() as db:
            until = db.execute("SELECT cool_until FROM traffic WHERE host=?", (host,)).fetchone()[0]
        if until > time.time():
            raise CoolingDown(until - time.time())

    def cooldown(self, host, seconds):
        until = time.time() + seconds
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO traffic VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET "
                       "cool_until=MAX(cool_until,excluded.cool_until), next_at=MAX(next_at,excluded.next_at)",
                       (host, until, until))
        return seconds
