"""Read-only view of installed kits and experts for the desktop page.

Secret values stay in ``.env``. This module returns which keys are missing,
never what they are set to.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from . import installer, store


def _config_home(home: Path, entry: Dict[str, Any]) -> Path:
    if entry.get("kind") == "expert" and not entry.get("self"):
        from hermes_cli.profiles import get_profile_dir, profile_exists

        profile = str(entry.get("profile") or "")
        if profile and profile_exists(profile):
            return Path(get_profile_dir(profile))
    return home


def _oauth_servers(target: Path, entry: Dict[str, Any]) -> List[Dict[str, str]]:
    keys = [str(key) for key in (entry.get("mcp_keys") or [])]
    if not keys:
        return []
    with store.scoped_home(target):
        from hermes_cli.config import load_config

        servers = (load_config() or {}).get("mcp_servers")
    if not isinstance(servers, dict):
        return []
    out: List[Dict[str, str]] = []
    for key in keys:
        server = servers.get(key)
        if isinstance(server, dict) and server.get("auth") == "oauth":
            out.append({"key": key})
    return out


def _missing(target: Path, entry: Dict[str, Any]) -> List[str]:
    missing: List[str] = []
    for field in entry.get("user_config") or []:
        if not isinstance(field, dict) or not field.get("required"):
            continue
        env = str(field.get("env") or "")
        if env and not installer._env_file_value(target, env):
            missing.append(env)
    return missing


def _row(home: Path, name: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    target = _config_home(home, entry)
    state = entry.get("trigger_state") if isinstance(entry.get("trigger_state"), dict) else {}
    kind = str(entry.get("kind") or "")
    return {
        "name": name,
        "kind": kind,
        "display_name": str(entry.get("display_name") or name),
        "version": str(entry.get("version") or ""),
        "enabled": None if kind == "expert" else bool(entry.get("enabled", True)),
        "profile": str(entry.get("profile") or ""),
        "self": bool(entry.get("self")),
        "market_id": str(entry.get("market_id") or ""),
        "skill_count": len(entry.get("skill_names") or []),
        "agent_count": len(entry.get("agent_skill_names") or []),
        "mcp_count": len(entry.get("mcp_keys") or []),
        "user_config": list(entry.get("user_config") or []),
        "missing_secrets": _missing(target, entry),
        "oauth_servers": _oauth_servers(target, entry),
        "pending_triggers": len((state or {}).get("pending") or []),
        "unverified_triggers": len((state or {}).get("unverified") or []),
    }


def describe(home: Path) -> Dict[str, Any]:
    plugins = [_row(home, name, entry) for name, entry in installer.list_entries(home)]
    return {"plugins": plugins}


def receipt_text(home: Path, name: str) -> Optional[str]:
    entry = (store.load_index(home).get("plugins") or {}).get(name)
    if not isinstance(entry, dict):
        return None
    path = store.receipt_path(_config_home(home, entry), name)
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
