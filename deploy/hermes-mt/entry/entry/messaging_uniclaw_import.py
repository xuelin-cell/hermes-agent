"""Import UniClaw cloud 5G bindings so its users move to this deployment without logging in again.

UniClaw keeps one ``config.users/<uid>.json`` per user with the cloud agent credentials and the
my-plan model catalog in plain text; its user ids are the same SMS-login uids this entry uses.
Imported bindings start disabled and are switched on in batches, because a binding that connects
takes the agent over from whoever holds it (UniClaw must already have stopped reconnecting).

Run inside the entry container (``docker exec -i <project>-entry python -m entry.messaging_uniclaw_import``):

  import SOURCE [--exclude FILE] [--model-origins URL,...] [--dry-run]
      SOURCE is a config.users directory, a tar of it, or ``-`` for a tar on stdin (so the
      plain-text credentials never land on this host's disk). Safe to rerun for late pushes.
  enable  --limit N | --users FILE       switch imported, still-disabled bindings on
  disable --all-5g | --users FILE        rollback: stop this deployment's 5G connections
  status                                 counts by source / enabled / connection state

The report lists user ids and outcomes only; credentials and keys are never printed.
"""
import argparse
import asyncio
import json
import re
import sys
import tarfile
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlsplit

from .cloud_binding_routes import parse_plan
from .config import Settings
from .crypto import CredentialCipher
from .db import Database
from .messaging_credentials import cloud_binding
from .messaging_store import MessagingStore

SOURCE = 'uniclaw-import'
USER_FILE = re.compile(r'^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$', re.I)
MAX_FILE_BYTES = 1 << 20


class _DryRun(Exception):
    pass


def read_source(source):
    """Yield (user_id, raw bytes) for each ``<uuid>.json``; other files (``*.develop.json``) are not users."""
    def wanted(name, size):
        match = USER_FILE.match(Path(name).name)
        return match.group(1) if match and size <= MAX_FILE_BYTES else None
    if source == '-' or Path(source).is_file():
        with tarfile.open(fileobj=sys.stdin.buffer, mode='r|*') if source == '-' else tarfile.open(source) as archive:
            for member in archive:
                user = member.isfile() and wanted(member.name, member.size)
                if user:
                    yield user, archive.extractfile(member).read()
        return
    for path in sorted(Path(source).iterdir()):
        user = path.is_file() and wanted(path.name, path.stat().st_size)
        if user:
            yield user, path.read_bytes()


def convert(raw, gateway_origins, model_origins):
    """UniClaw user config -> (binding, plan) or (None, reason). Raises nothing on bad input."""
    try:
        config = json.loads(raw)
    except ValueError:
        return None, 'unreadable'
    channel = ((config.get('claw') or {}).get('channels') or {}).get('uniagentgate') or {}
    if not channel.get('registered'):
        return None, 'not_bound'
    status, binding = cloud_binding({'ipUrl': channel.get('gateway_url'), 'agentIdCloud': channel.get('agent_id'),
                                     'agentKeyCloud': channel.get('agent_sk')}, set())
    if status != 'available' or len(binding['agent_id']) > 128 or len(binding['gateway']) > 2048:
        return None, 'invalid_credentials'
    if gateway_origins and _origin(binding['gateway']) not in gateway_origins:
        return None, 'gateway_not_allowed'
    models = [{key: value for key, value in model.items() if key != 'api_key'}
              for model in config.get('models') or [] if isinstance(model, dict)]
    if model_origins and any(_origin(model.get('base_url')) not in model_origins for model in models):
        return None, 'model_origin_not_allowed'
    catalog = {'models': models, 'main_model_id': config.get('main_model_id') or ''}
    if config.get('fast_model_id'):
        catalog['fast_model_id'] = config['fast_model_id']
    try:
        plan = parse_plan({'apiKey': config.get('yuanjing_api_key'), 'models': json.dumps(catalog)})
    except (ValueError, TypeError, KeyError):
        return None, 'invalid_plan'
    return (binding, plan), None


def _origin(url):
    parts = urlsplit(str(url or ''))
    return f'{parts.scheme}://{parts.netloc.lower()}'


def _origins(text):
    return {value.strip().rstrip('/') for value in text.split(',') if value.strip()}


async def import_one(database, store, user, binding, plan, *, dry_run=False):
    """One user per transaction. Never touches an existing binding or a newer model config."""
    try:
        async with database.acquire() as db, db.transaction():
            await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'messaging:' + user)
            await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'messaging-bot:uniagentgate:' + binding['agent_id'])
            status = await db.fetchval('SELECT status FROM users WHERE user_id=$1 FOR UPDATE', user)
            if status == 'disabled':
                return 'user_disabled'
            if await db.fetchval("SELECT 1 FROM messaging_bindings WHERE user_id=$1 AND platform='uniagentgate' AND deleted_at IS NULL", user):
                return 'already_bound'
            if await db.fetchval("SELECT 1 FROM messaging_bindings WHERE platform='uniagentgate' AND bot_key=$1 AND deleted_at IS NULL", binding['agent_id']):
                return 'agent_owned_by_other_user'
            if status is None:
                await db.execute('INSERT INTO users(user_id,masked_phone,last_login_at) VALUES($1,NULL,now())', user)
            row = await store._configure(db, user, binding['gateway'], binding['agent_id'], binding['secret'], 'uniagentgate')
            await db.execute('UPDATE messaging_bindings SET source=$2 WHERE id=$1', row['id'], SOURCE)
            # A user who already logged in here has a newer plan from that login; keep it.
            if status is None:
                await store._save_plan(db, user, plan)
            outcome = 'imported' if status is None else 'imported_binding_only'
            if dry_run:
                raise _DryRun(outcome)
            return outcome
    except _DryRun as dry:
        return str(dry)


async def run_import(database, store, settings, source, *, exclude=(), model_origins=(), dry_run=False):
    outcomes, users = Counter(), defaultdict(list)
    gateway_origins = _origins(settings.channels_gateway_origins)
    # Agents taken earlier in this run: a dry run rolls each user back, so the database alone
    # would not show two files sharing one agent.
    claimed = set()
    for user, raw in read_source(source):
        if user in exclude:
            outcome = 'excluded'
        else:
            converted, outcome = convert(raw, gateway_origins, set(model_origins))
            if converted and converted[0]['agent_id'] in claimed:
                outcome = 'agent_owned_by_other_user'
            elif converted:
                outcome = await import_one(database, store, user, *converted, dry_run=dry_run)
                if outcome.startswith('imported'):
                    claimed.add(converted[0]['agent_id'])
        outcomes[outcome] += 1
        if outcome not in {'imported', 'not_bound'}:
            users[outcome].append(user)
    return {'dry_run': dry_run, 'counts': dict(outcomes), 'users': dict(users)}


async def run_enable(database, store, *, limit=None, users=None):
    async with database.acquire() as db:
        rows = await db.fetch("""SELECT b.user_id FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id
            WHERE b.platform='uniagentgate' AND b.source=$1 AND NOT b.enabled AND b.deleted_at IS NULL AND u.status='active'
            AND ($2::text[] IS NULL OR b.user_id=ANY($2)) ORDER BY b.user_id LIMIT $3""", SOURCE, users, limit)
    for row in rows:
        await store.set_enabled(row['user_id'], True)
    return {'enabled': len(rows), 'users': [row['user_id'] for row in rows]}


async def run_disable(database, store, *, users=None):
    async with database.acquire() as db:
        rows = await db.fetch("""SELECT user_id FROM messaging_bindings WHERE platform='uniagentgate' AND enabled
            AND deleted_at IS NULL AND ($1::text[] IS NULL OR user_id=ANY($1)) ORDER BY user_id""", users)
    for row in rows:
        await store.set_enabled(row['user_id'], False)
    return {'disabled': len(rows)}


async def run_status(database):
    async with database.acquire() as db:
        rows = await db.fetch("""SELECT source, enabled, connection_state, count(*) AS n FROM messaging_bindings
            WHERE platform='uniagentgate' AND deleted_at IS NULL GROUP BY 1,2,3 ORDER BY 1,2,3""")
    return {'bindings': [dict(row) for row in rows]}


def _user_list(path):
    lines = Path(path).read_text().splitlines()
    return [line.split('#', 1)[0].strip() for line in lines if line.split('#', 1)[0].strip()]


COMMANDS = {
    'import': lambda database, store, settings, args: run_import(database, store, settings, args.source,
        exclude=set(_user_list(args.exclude)) if args.exclude else set(),
        model_origins=_origins(args.model_origins), dry_run=args.dry_run),
    'enable': lambda database, store, settings, args: run_enable(database, store, limit=args.limit,
        users=_user_list(args.users) if args.users else None),
    'disable': lambda database, store, settings, args: run_disable(database, store,
        users=_user_list(args.users) if args.users else None),
    'status': lambda database, store, settings, args: run_status(database),
}


async def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m entry.messaging_uniclaw_import', description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    imported = commands.add_parser('import')
    imported.add_argument('source')
    imported.add_argument('--exclude', help='file with one user_id per line (# comments allowed)')
    imported.add_argument('--model-origins', default='', help='comma-separated allowed model origins, e.g. https://maas-api.ai-yuanjing.com')
    imported.add_argument('--dry-run', action='store_true')
    enable = commands.add_parser('enable')
    enable_target = enable.add_mutually_exclusive_group(required=True)
    enable_target.add_argument('--limit', type=int)
    enable_target.add_argument('--users')
    disable = commands.add_parser('disable')
    disable_target = disable.add_mutually_exclusive_group(required=True)
    disable_target.add_argument('--all-5g', action='store_true')
    disable_target.add_argument('--users')
    commands.add_parser('status')
    args = parser.parse_args(argv)

    settings = Settings()
    database = Database(settings.database_url)
    await database.connect()
    store = MessagingStore(database, CredentialCipher(settings.credential_key))
    try:
        report = await COMMANDS[args.command](database, store, settings, args)
    finally:
        await database.close()
    print(json.dumps(report, ensure_ascii=False, indent=1, default=str))


if __name__ == '__main__':
    asyncio.run(main())
