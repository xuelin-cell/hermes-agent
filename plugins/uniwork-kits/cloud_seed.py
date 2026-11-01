"""Seed template bundles before the cloud backend accepts conversations.

Package bytes and script runtimes come from the image. Only account-owned
installation state and expert profiles are written into the persistent home.
"""
from __future__ import annotations

import logging
from pathlib import Path

from . import autoseed, cloud, expert_sync, script_swaps, seed, store

logger = logging.getLogger(__name__)
_states: dict[str, dict] = {}


def status(root: Path) -> dict:
    with cloud._lock:
        state = _states.get(str(root.resolve()), {
            'ran': False, 'running': False, 'name': '', 'done': 0, 'total': 0,
            'installed': 0, 'unchanged': 0, 'failed': [], 'error': '',
        })
        return {**state, 'failed': list(state['failed'])}


def remember(root: Path, names: set[str]) -> None:
    """Keep uninstall intent even for bundles installed manually before auto-seeding."""
    record = store.imported_root(root) / autoseed.SEEDED_NAME
    autoseed._save_seeded(record, autoseed._load_seeded(record) | names)


def initialize(home: Path) -> None:
    root = store.root_home(home).resolve()
    if root != home.resolve():
        return
    state = {**status(root), 'ran': True, 'running': True, 'name': '', 'done': 0,
             'total': 0, 'installed': 0, 'unchanged': 0, 'failed': [], 'error': ''}
    with cloud._lock:
        _states[str(root)] = state
    try:
        with cloud.changing(root), store.scoped_home(root):
            directory = autoseed.bundled_dir(root)
            if directory is None:
                directory = root / '.mt/bundled'
            record = store.imported_root(root) / autoseed.SEEDED_NAME
            seeded = autoseed._load_seeded(record)
            present = set(store.load_index(root)['plugins'])
            # Migrate existing manual installations before making any changes.
            remember(root, present)
            items = seed.seed(root, directory, generate_triggers=False, removed=seeded - present)
            remember(root, {item.name for item in items
                            if item.name and item.status in ('installed', 'unchanged')})
            state.update(total=len(items), done=len(items),
                         installed=sum(item.status == 'installed' for item in items),
                         unchanged=sum(item.status == 'unchanged' for item in items),
                         failed=[f'{item.name or item.path}：{item.detail}' for item in items
                                 if item.status in ('failed', 'unreadable')])
            script_swaps.apply_installed(root)
            for item in items:
                if item.status in ('installed', 'unchanged'):
                    expert_sync.sync_named(root, item.name)
            if not items or all(item.status == 'empty' for item in items):
                state['error'] = '实例缺少套件资源，请更新实例模板。'
    except Exception as exc:
        state['error'] = str(exc)
        logger.warning('[uniwork-kits] cloud bundle initialization failed', exc_info=True)
    finally:
        state['running'] = False
    # Never prepare Python here: the cloud image already owns these dependencies.
    logger.info('[uniwork-kits] cloud bundles: %s', state)
