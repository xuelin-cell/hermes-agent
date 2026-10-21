"""Read-only view of installed kits and experts for the desktop page.

Secret values stay in ``.env``. This module returns which keys are missing,
never what they are set to.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import installer, store


def _config_home(home: Path, entry: Dict[str, Any]) -> Path:
    """这个包的配置写在哪个 home：专家写在它自己的档案里，套件和专家本身的那份写在当前 home。"""
    if entry.get("kind") == "expert" and not entry.get("self"):
        from hermes_cli.profiles import get_profile_dir, profile_exists

        profile = str(entry.get("profile") or "")
        if profile and profile_exists(profile):
            return Path(get_profile_dir(profile))
    return home


def _oauth_servers(target: Path, entry: Dict[str, Any]) -> List[Dict[str, str]]:
    """这个包带的 MCP 里哪些要走 OAuth 登录，套件页据此显示「登录」按钮。"""
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
    """必填的用户配置里，哪些还没在 .env 里填值。"""
    missing: List[str] = []
    for field in entry.get("user_config") or []:
        if not isinstance(field, dict) or not field.get("required"):
            continue
        env = str(field.get("env") or "")
        if env and not installer._env_file_value(target, env):
            missing.append(env)
    return missing


_MANIFEST_SPOTS = ("plugin.json", ".codebuddy-plugin/plugin.json", ".claude-plugin/plugin.json")


def _description(home: Path, entry: Dict[str, Any]) -> str:
    """卡片上「这个包做什么」：优先用专家的介绍，否则用包清单自己的一句话。

    记录描述之前装的旧条目，从保留的原包副本里读。
    """
    intro = entry.get("intro") if isinstance(entry.get("intro"), dict) else {}
    text = str(intro.get("description") or entry.get("description") or "")
    if text or not entry.get("source_dir"):
        return text
    from .host_rules import localized

    source = home / str(entry["source_dir"])
    for spot in _MANIFEST_SPOTS:
        try:
            manifest = json.loads((source / spot).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(manifest, dict):
            return localized(manifest.get("description"))
    return ""


_CARD_PHRASES = 8


def _phrases(entry: Dict[str, Any]) -> List[str]:
    """取几条这个包的中文触发词，告诉用户可以怎么说来用它。"""
    out: List[str] = []
    table = entry.get("triggers") if isinstance(entry.get("triggers"), dict) else {}
    for phrases in table.values():
        for phrase in phrases if isinstance(phrases, list) else []:
            text = str(phrase).strip()
            if text and text not in out:
                out.append(text)
            if len(out) >= _CARD_PHRASES:
                return out
    return out


def _display_name(name: str, entry: Dict[str, Any]) -> str:
    """包自己没有中文名时，卡片标题用内置的中文名。

    已存的名字和包名不同就保留：专家是特意改过名的，包里声明的显示名也不能被覆盖。
    """
    from .package import DISPLAY_TITLES

    stored = str(entry.get("display_name") or "").strip()
    titled = DISPLAY_TITLES.get(name, "")
    if titled and stored in {"", name}:
        return titled
    return stored or name


def _row(home: Path, name: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    """把索引里的一条整理成套件页卡片需要的字段。"""
    target = _config_home(home, entry)
    state = entry.get("trigger_state") if isinstance(entry.get("trigger_state"), dict) else {}
    kind = str(entry.get("kind") or "")
    return {
        "name": name,
        "kind": kind,
        "display_name": _display_name(name, entry),
        "profession": str(entry.get("profession") or ""),
        "description": _description(home, entry),
        "phrases": _phrases(entry),
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
    """套件页的全部卡片：已装的套件和专家。"""
    plugins = [_row(home, name, entry) for name, entry in installer.list_entries(home)]
    return {"plugins": plugins}


def receipt_text(home: Path, name: str) -> Optional[str]:
    """某个包最近一次安装记录的全文；没装或没有记录时返回 None。"""
    entry = (store.load_index(home).get("plugins") or {}).get(name)
    if not isinstance(entry, dict):
        return None
    path = store.receipt_path(_config_home(home, entry), name)
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
