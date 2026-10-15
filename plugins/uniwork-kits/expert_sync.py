"""Installed experts follow the default profile's model, keys and UniAI toolkit.

An expert is its own profile, created as a copy of what the default profile
had at install time: the ``model`` section and the ``.env`` keys. The desktop
account build (``desktop-mt``) rewrites three things in the default profile on
every login, and only there — the 套餐 provider (``providers.desktop-mt-maas-*``),
its key (``DESKTOP_MT_MAAS_API_KEY``) and the UniAI toolkit
(``mcp_servers.UniAI-Toolkit``). Experts kept the stale copy: a rotated key or a
dropped 套餐 model broke them silently, and none of them could generate or
search a picture.

So the default profile pushes these across, and nothing else:

* ``.env``: keys the expert already has get the default's new value; keys the
  synced providers or the toolkit reference are added. The expert's own keys
  (its package's userConfig, e.g. ``WECHAT_APPID``) are never touched, and an
  unrelated new key in the default (a bot token) is not spread to every expert.
* ``providers``: the managed 套餐 entries are mirrored, and dropped again when
  the default drops them.
* ``model``: follows the default unless the user picked another model for this
  expert since the last sync.
* the UniAI toolkit entry: mirrored, keeping the expert's own ``enabled`` flag
  and tool filter; removed again when the default no longer has it.

Hermes keeps profiles independent on purpose; this touches only profiles this
plugin installed as experts, and only these fields. It runs when the default
profile's process loads the plugin — the desktop starts that backend right
after login, before any expert backend — and on ``hermes kit sync``.
"""

from __future__ import annotations

import copy
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple

from . import media_slot, store

logger = logging.getLogger(__name__)

MANAGED_PROVIDER_PREFIX = "desktop-mt-maas-"
_ENV_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_KEY_FIELDS = ("key_env", "api_key_env")
_KEEP_FROM_EXPERT = ("enabled", "tools")


def _read(home: Path) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """``(raw config, .env)`` of *home*, exactly as written."""
    with store.scoped_home(home):
        from hermes_cli.config import load_env, read_user_config_raw

        raw = read_user_config_raw() or {}
        env = load_env() or {}
    return (raw if isinstance(raw, dict) else {}), dict(env)


def _managed_providers(raw: Mapping[str, Any]) -> Dict[str, Any]:
    providers = raw.get("providers")
    if not isinstance(providers, Mapping):
        return {}
    return {str(k): v for k, v in providers.items() if str(k).startswith(MANAGED_PROVIDER_PREFIX)}


def _referenced_keys(providers: Mapping[str, Any], mcp_entry: Optional[Mapping[str, Any]]) -> Set[str]:
    keys: Set[str] = set()
    for entry in providers.values():
        if isinstance(entry, Mapping):
            keys |= {str(entry[f]) for f in _KEY_FIELDS if isinstance(entry.get(f), str) and entry.get(f)}
    if mcp_entry:
        keys |= set(_ENV_REF_RE.findall(repr(dict(mcp_entry))))
    return keys


def _own_keys(entry: Mapping[str, Any]) -> Set[str]:
    own = {str(k) for k in entry.get("env_keys") or []}
    for field in entry.get("user_config") or []:
        if isinstance(field, Mapping) and field.get("env"):
            own.add(str(field["env"]))
    return own


def _expert_homes(default_home: Path) -> List[Tuple[str, Path]]:
    from hermes_cli.profiles import get_profile_dir, profile_exists

    out: List[Tuple[str, Path]] = []
    for name, entry in sorted((store.load_index(default_home).get("plugins") or {}).items()):
        if not isinstance(entry, dict) or entry.get("kind") != "expert" or entry.get("self"):
            continue
        profile = str(entry.get("profile") or "")
        if profile and profile_exists(profile):
            out.append((name, Path(get_profile_dir(profile))))
    return out


def _plan_config(
    expert_raw: Dict[str, Any],
    default_raw: Mapping[str, Any],
    record: Mapping[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any], List[str]]:
    """``(new raw config, new sync record, what changed)`` for one expert."""
    raw = copy.deepcopy(expert_raw)
    changes: List[str] = []
    new_record: Dict[str, Any] = {}

    providers = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
    wanted = _managed_providers(default_raw)
    for key in [k for k in providers if k.startswith(MANAGED_PROVIDER_PREFIX) and k not in wanted]:
        providers.pop(key)
        changes.append(f"移除套餐提供方 {key}")
    for key, value in wanted.items():
        if providers.get(key) != value:
            providers[key] = copy.deepcopy(value)
            changes.append(f"同步套餐提供方 {key}")
    if providers:
        raw["providers"] = providers
    else:
        raw.pop("providers", None)

    default_model = default_raw.get("model")
    if isinstance(default_model, Mapping):
        current = raw.get("model")
        last = record.get("synced_model")
        follows = last is None or current == last or current is None
        if follows and current != default_model:
            raw["model"] = copy.deepcopy(dict(default_model))
            changes.append("模型跟随默认配置档案")
        new_record["synced_model"] = copy.deepcopy(raw.get("model")) if follows else last

    servers = raw.get("mcp_servers") if isinstance(raw.get("mcp_servers"), dict) else {}
    default_servers = default_raw.get("mcp_servers") if isinstance(default_raw.get("mcp_servers"), Mapping) else {}
    name = media_slot.uniai_server(default_servers)
    previous = [str(n) for n in record.get("synced_mcp") or []]
    for stale in [n for n in previous if n != name and n in servers]:
        servers.pop(stale)
        changes.append(f"移除 {stale}（默认配置档案已经没有）")
    if name:
        mirrored = copy.deepcopy(dict(default_servers[name]))
        mine = servers.get(name) if isinstance(servers.get(name), Mapping) else {}
        for field in _KEEP_FROM_EXPERT:
            if field in mine:
                mirrored[field] = mine[field]
        if mine != mirrored:
            servers[name] = mirrored
            changes.append(f"同步 {name}（生图 / 搜图）")
    if servers:
        raw["mcp_servers"] = servers
    else:
        raw.pop("mcp_servers", None)
    new_record["synced_mcp"] = [name] if name else []
    return raw, new_record, changes


def sync_expert(default_home: Path, expert_home: Path) -> List[str]:
    """Bring one expert in line with *default_home*. Returns what changed."""
    default_raw, default_env = _read(default_home)
    expert_raw, expert_env = _read(expert_home)
    index = store.load_index(expert_home)
    found = store.self_expert(index)
    if not found:
        return []
    plugin, entry = found
    record = entry.get("sync") if isinstance(entry.get("sync"), dict) else {}
    new_raw, new_record, changes = _plan_config(expert_raw, default_raw, record)

    servers = new_raw.get("mcp_servers") if isinstance(new_raw.get("mcp_servers"), Mapping) else {}
    name = media_slot.uniai_server(servers)
    referenced = _referenced_keys(_managed_providers(new_raw), servers.get(name) if name else None)
    own = _own_keys(entry)
    env_updates: Dict[str, str] = {}
    for key, value in default_env.items():
        if key in own:
            continue
        if (key in expert_env and expert_env[key] != value) or (key in referenced and key not in expert_env):
            env_updates[key] = value

    with store.scoped_home(expert_home):
        from hermes_cli.config import save_config, save_env_value

        if new_raw != expert_raw:
            save_config(new_raw)
        for key, value in env_updates.items():
            save_env_value(key, value)
    if env_updates:
        changes.append("更新密钥 " + "、".join(sorted(env_updates)))
    if new_record != record:
        entry["sync"] = new_record
        index["plugins"][plugin] = entry
        store.save_index(expert_home, index)
    return changes


def sync_all(default_home: Path) -> List[str]:
    """Sync every installed expert. One line per expert that changed."""
    lines: List[str] = []
    for name, home in _expert_homes(default_home):
        try:
            changes = sync_expert(default_home, home)
        except Exception as exc:  # one broken profile must not stop the rest
            logger.warning("[uniwork-kits] syncing expert %s failed: %s", name, exc)
            lines.append(f"{name}：同步失败（{exc}）")
            continue
        if changes:
            lines.append(f"{name}：" + "；".join(changes))
    return lines


_synced_homes: Set[str] = set()


def sync_on_load(home: Path) -> None:
    """Once per process, when *home* is a default profile that lists experts."""
    key = str(home)
    if key in _synced_homes:
        return
    _synced_homes.add(key)
    try:
        if not _expert_homes(home):
            return
        for line in sync_all(home):
            logger.info("[uniwork-kits] %s", line)
    except Exception:
        logger.warning("[uniwork-kits] expert sync failed", exc_info=True)
