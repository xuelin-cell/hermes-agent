"""Manual crash recovery for cloud GUI turns, scoped to each owning home."""
import json
import time
from pathlib import Path
from threading import RLock

WINDOW_MS = 15 * 60 * 1000
_LOCK = RLock()


def _read(path):
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError('Recovery state cannot be a symlink')
    if not path.exists():
        return {}
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('Recovery state too large')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('Invalid recovery state')
    return value


def _save(path, value):
    from utils import atomic_json_write
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError('Invalid recovery path')
    atomic_json_write(path, value, mode=0o600)


def claim(home, now=None):
    from tui_gateway.turn_marker import marker_writer_state
    now = int(time.time() * 1000) if now is None else now
    marker = Path(home) / 'desktop/interrupted_turns.json'
    saved = Path(home) / 'desktop/uniwork-interrupted-turns.json'
    with _LOCK:
        entries = _read(marker)
        records = {key: item for key, item in _read(saved).items()
                   if isinstance(item, dict) and isinstance(item.get('prompt'), str)
                   and isinstance(item.get('detectedAt'), (int, float)) and 0 <= now - item['detectedAt'] < WINDOW_MS}
        moved = []
        for session, item in entries.items():
            if not isinstance(item, dict) or item.get('auto_continue') is False or marker_writer_state(item) != 'dead':
                continue
            prompt = item.get('prompt')
            if isinstance(prompt, str) and prompt.strip() and len(session) <= 512:
                records[session] = {'prompt': prompt[:64000], 'detectedAt': now}
                moved.append(session)
        if moved:
            _save(saved, records)
            _save(marker, {key: value for key, value in entries.items() if key not in moved})
        return [{'sessionId': key, **value} for key, value in records.items()]


def claim_all(root):
    """Run before serve starts, so native resume cannot race the manual recovery claim."""
    from hermes_cli.config import read_user_config_raw, save_config
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    root = Path(root)
    homes = [root]
    profiles = root / 'profiles'
    if profiles.is_dir() and not profiles.is_symlink():
        homes += [home for home in profiles.iterdir() if home.is_dir() and not home.is_symlink() and (home / 'config.yaml').is_file()]
    for home in homes:
        claim(home)
        token = set_hermes_home_override(home)
        try:
            config = read_user_config_raw()
            config.setdefault('desktop', {}).setdefault('auto_continue', {})['enabled'] = False
            save_config(config)
        finally:
            reset_hermes_home_override(token)


def dismiss(home, session):
    with _LOCK:
        path = Path(home) / 'desktop/uniwork-interrupted-turns.json'
        records = _read(path)
        if session in records:
            records.pop(session)
            _save(path, records)
