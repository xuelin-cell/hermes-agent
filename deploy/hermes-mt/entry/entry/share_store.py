"""Durable share lifecycle state, serialized across Entry workers with PG locks."""
from __future__ import annotations

import hashlib
import json
from contextlib import asynccontextmanager


class ShareStore:
    def __init__(self, database):
        self.database = database

    @asynccontextmanager
    async def locked(self, user, kind, key):
        lock = int.from_bytes(hashlib.sha256(json.dumps(['share', user, kind, key]).encode()).digest()[:8], 'big', signed=True)
        async with self.database.acquire() as connection:
            await connection.execute('SELECT pg_advisory_lock($1)', lock)
            try:
                yield ShareSlot(connection, user, kind, key)
            finally:
                await connection.execute('SELECT pg_advisory_unlock($1)', lock)

    async def records(self, user, kind):
        async with self.database.acquire() as connection:
            rows = await connection.fetch('SELECT record FROM cloud_shares WHERE user_id=$1 AND kind=$2 AND record IS NOT NULL', user, kind)
        return [json.loads(row['record']) for row in rows]

    async def expired(self, user, now):
        async with self.database.acquire() as connection:
            rows = await connection.fetch('''SELECT share_key FROM cloud_shares
                WHERE user_id=$1 AND kind='artifact' AND
                COALESCE(pending->>'expiresAt', record->>'expiresAt') <= $2
                AND (pending IS NOT NULL OR record->>'deletedAt' IS NULL) LIMIT 1''', user, now)
        return [row['share_key'] for row in rows]


class ShareSlot:
    def __init__(self, connection, user, kind, key):
        self.connection, self.user, self.kind, self.key = connection, user, kind, key

    async def load(self):
        row = await self.connection.fetchrow('SELECT record,pending,payload FROM cloud_shares WHERE user_id=$1 AND kind=$2 AND share_key=$3', self.user, self.kind, self.key)
        if not row:
            return None, None, None
        return (json.loads(row['record']) if row['record'] else None,
                json.loads(row['pending']) if row['pending'] else None, row['payload'])

    async def prepare(self, pending, payload):
        # Autocommit before external I/O: an uncertain PUT must retain its ID and bytes.
        await self.connection.execute('''INSERT INTO cloud_shares(user_id,kind,share_key,pending,payload)
            VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(user_id,kind,share_key)
            DO UPDATE SET pending=EXCLUDED.pending,payload=EXCLUDED.payload''',
            self.user, self.kind, self.key, json.dumps(pending), payload)

    async def save(self, record):
        await self.connection.execute('''UPDATE cloud_shares SET record=$4::jsonb,pending=NULL,payload=NULL
            WHERE user_id=$1 AND kind=$2 AND share_key=$3''', self.user, self.kind, self.key, json.dumps(record))
