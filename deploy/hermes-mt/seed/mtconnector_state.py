"""Connector state entry keeps in its database, so a connector change is durable without
archiving the whole instance.

A profile's state is its connector keys, its encrypted credential store and which connectors it
has switched on. Entry stores the snapshot taken after each change and sends it back at bootstrap.
The instance may have changed the store since (an OAuth token refresh caught by a later archive),
so bootstrap keeps whichever is newer: the snapshot, or the newest credential write in the
restored store. Both clocks are instance clocks.
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Run logs, idempotency records and in-flight OAuth grants: never needed after a restore, and
# the run log is what would make the snapshot grow.
TRANSIENT_TABLES = ('runs', 'idempotency_records', 'oauth_states')
CREDENTIAL_TABLES = ('connections', 'oauth_client_configs')


def _now() -> str:
    # Same shape as the runtime's Date.toISOString(), so the two compare as strings.
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _tables(connection) -> set[str]:
    return {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}


def _connector_entries(scope) -> dict[str, bool]:
    _, _, config = scope.config()
    entries = {}
    for name, saved in config.get('mcp_servers', {}).items():
        if (isinstance(saved, dict) and name == f"connector_{saved.get('cloud_connector')}"
                and saved.get('cloud_connector_profile', 'default') == scope.profile):
            entries[saved['cloud_connector']] = saved.get('enabled') is True
    return entries


def snapshot(scope) -> dict:
    directory = scope.home / 'open-connector'
    taken_at = _now()
    with tempfile.TemporaryDirectory() as temporary:
        copy = Path(temporary) / 'connect.sqlite'
        source, target = sqlite3.connect(directory / 'connect.sqlite'), sqlite3.connect(copy)
        try:
            source.backup(target)
            present = _tables(target)
            for table in TRANSIENT_TABLES:
                if table in present:
                    target.execute(f'delete from {table}')
            target.commit()
            target.execute('pragma journal_mode = delete')
            target.execute('vacuum')
        finally:
            source.close()
            target.close()
        database = copy.read_bytes()
    return {'taken_at': taken_at, 'keys': json.loads((directory / 'secrets.json').read_text()),
            'database': base64.b64encode(database).decode(), 'enabled': _connector_entries(scope)}


def last_change(database: Path) -> str:
    """The newest credential write in a local store; '' when there is no readable store."""
    if not database.is_file():
        return ''
    connection = sqlite3.connect(database)
    try:
        present = _tables(connection)
        stamps = [connection.execute(f'select max(updated_at) from {table}').fetchone()[0]
                  for table in CREDENTIAL_TABLES if table in present]
    except sqlite3.DatabaseError:
        return ''
    finally:
        connection.close()
    return max((stamp for stamp in stamps if isinstance(stamp, str)), default='')


def _write(file: Path, data: bytes) -> None:
    fd, temporary = tempfile.mkstemp(dir=file.parent, prefix='.connector-')
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def adopt(scope, state: dict, specs) -> bool:
    """Install a snapshot unless the local store has a newer credential write. Runs before the
    connector runtime opens the store."""
    taken_at, keys, enabled = state['taken_at'], state['keys'], state['enabled']
    if not (isinstance(taken_at, str) and isinstance(keys, dict) and isinstance(enabled, dict)
            and set(enabled) <= set(specs) and all(isinstance(value, bool) for value in enabled.values())):
        raise ValueError('Invalid connector snapshot')
    directory = scope.home / 'open-connector'
    if directory.is_symlink():
        raise ValueError('Invalid connector directory')
    if taken_at <= last_change(directory / 'connect.sqlite'):
        return False
    database = base64.b64decode(state['database'], validate=True)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    # A restored write-ahead log belongs to the store being replaced.
    for suffix in ('-wal', '-shm'):
        (directory / f'connect.sqlite{suffix}').unlink(missing_ok=True)
    _write(directory / 'connect.sqlite', database)
    _write(directory / 'secrets.json', json.dumps(keys).encode())
    scope.values = scope.credentials()
    for id in set(_connector_entries(scope)) - set(enabled):
        scope.update(id, False, remove=True)
    for id, on in enabled.items():
        scope.update(id, on)
    return True
