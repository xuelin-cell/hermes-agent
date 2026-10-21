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
* the 东方财富 connector (the desktop's OpenConnector ``connector_eastmoney_mcp``),
  and only onto the nine Eastmoney experts: same mirror rules, but stored under
  ``eastmoney_slot.MIRROR_NAME`` without ``desktop_connector`` — the desktop
  rewrites entries carrying that marker to the expert's own, unauthorized
  connector before the expert's backend starts. An expert the user authorized
  on its own keeps its own entry. Until the default profile has the connector,
  nothing here is copied and those experts keep the package's own scripts.

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

from . import eastmoney_slot, media_slot, store

logger = logging.getLogger(__name__)

MANAGED_PROVIDER_PREFIX = "desktop-mt-maas-"
_ENV_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_KEY_FIELDS = ("key_env", "api_key_env")
_KEEP_FROM_EXPERT = ("enabled", "tools")


def _read(home: Path) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """原样读出 home 的配置和 .env，不合并默认值。"""
    with store.scoped_home(home):
        from hermes_cli.config import load_env, read_user_config_raw

        raw = read_user_config_raw() or {}
        env = load_env() or {}
    return (raw if isinstance(raw, dict) else {}), dict(env)


def _managed_providers(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """配置里由桌面统一管理的模型提供方（名字带固定前缀的那些）。"""
    providers = raw.get("providers")
    if not isinstance(providers, Mapping):
        return {}
    return {str(k): v for k, v in providers.items() if str(k).startswith(MANAGED_PROVIDER_PREFIX)}


def _referenced_keys(providers: Mapping[str, Any], mcp_entry: Optional[Mapping[str, Any]]) -> Set[str]:
    """模型提供方和 MCP 配置里引用到的环境变量名，同步时这些密钥要一起带过去。"""
    keys: Set[str] = set()
    for entry in providers.values():
        if isinstance(entry, Mapping):
            keys |= {str(entry[f]) for f in _KEY_FIELDS if isinstance(entry.get(f), str) and entry.get(f)}
    if mcp_entry:
        keys |= set(_ENV_REF_RE.findall(repr(dict(mcp_entry))))
    return keys


def _own_keys(entry: Mapping[str, Any]) -> Set[str]:
    """专家自己的密钥名（包声明的和用户配置项），同步时不能被默认档案覆盖。"""
    own = {str(k) for k in entry.get("env_keys") or []}
    for field in entry.get("user_config") or []:
        if isinstance(field, Mapping) and field.get("env"):
            own.add(str(field["env"]))
    return own


def _expert_homes(default_home: Path) -> List[Tuple[str, Path]]:
    """已装、并且档案还存在的专家：（包名, 档案 home）列表。"""
    from hermes_cli.profiles import get_profile_dir, profile_exists

    out: List[Tuple[str, Path]] = []
    for name, entry in sorted((store.load_index(default_home).get("plugins") or {}).items()):
        if not isinstance(entry, dict) or entry.get("kind") != "expert" or entry.get("self"):
            continue
        profile = str(entry.get("profile") or "")
        if profile and profile_exists(profile):
            out.append((name, Path(get_profile_dir(profile))))
    return out


def _mcp_to_follow(
    plugin: str,
    default_servers: Mapping[str, Any],
    expert_servers: Mapping[str, Any],
    previous: List[str],
) -> List[Tuple[str, str, str]]:
    """默认档案里这个专家要跟上的 MCP，每项是（默认档案里的键, 专家档案里的键, 说明）。

    东方财富连接器在专家档案里用 eastmoney_slot.MIRROR_NAME 这个键（原因见 eastmoney_slot 模块说明）；
    专家档案里有用户自己授权、仍在启用的那条（不是以前同步过去的）时，就用它，不再同步。
    """
    followed: List[Tuple[str, str, str]] = []
    uniai = media_slot.uniai_server(default_servers)
    if uniai:
        followed.append((uniai, uniai, "生图 / 搜图"))
    if plugin in eastmoney_slot.EXPERTS:
        own = [
            str(name) for name, entry in expert_servers.items()
            if isinstance(entry, Mapping) and eastmoney_slot.owned_by_desktop(entry)
            and str(name) not in previous and eastmoney_slot.server_name({name: entry})
        ]
        found = eastmoney_slot.server_name(default_servers)
        if found and found != uniai and not own:
            followed.append((found, eastmoney_slot.MIRROR_NAME, "东方财富连接器"))
    return followed


def _mirror_mcp_entry(
    servers: Dict[str, Any],
    default_servers: Mapping[str, Any],
    source: str,
    target: str,
    label: str,
    changes: List[str],
) -> None:
    """把默认档案的一条 MCP 抄进专家档案，保留专家自己的 enabled 和 tools。

    去掉 desktop_connector：专家后端启动前，桌面会把带这个标记的条目改写成专家自己那份连接器的地址。
    """
    mirrored = copy.deepcopy(dict(default_servers[source]))
    mirrored.pop("desktop_connector", None)
    mine = servers.get(target) if isinstance(servers.get(target), Mapping) else {}
    for field in _KEEP_FROM_EXPERT:
        if field in mine:
            mirrored[field] = copy.deepcopy(mine[field])
    if mine != mirrored:
        servers[target] = mirrored
        changes.append(f"同步 {target}（{label}）")


def _plan_config(
    expert_raw: Dict[str, Any],
    default_raw: Mapping[str, Any],
    record: Mapping[str, Any],
    plugin: str,
) -> Tuple[Dict[str, Any], Dict[str, Any], List[str]]:
    """算出一位专家同步后的配置、新的同步记录，以及改了哪些（只计算，不写文件）。"""
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
    previous = [str(n) for n in record.get("synced_mcp") or []]
    wanted = _mcp_to_follow(plugin, default_servers, servers, previous)
    wanted_names = [target for _source, target, _label in wanted]
    for stale in [n for n in previous if n not in wanted_names and n in servers]:
        servers.pop(stale, None)
        changes.append(f"移除 {stale}（默认配置档案已经没有，或已改用新的键名）")
    for source, target, label in wanted:
        _mirror_mcp_entry(servers, default_servers, source, target, label, changes)
    if servers:
        raw["mcp_servers"] = servers
    else:
        raw.pop("mcp_servers", None)
    new_record["synced_mcp"] = wanted_names
    return raw, new_record, changes


def sync_expert(default_home: Path, expert_home: Path) -> List[str]:
    """让一位专家跟上默认档案（模型、密钥、要跟随的 MCP），返回改了哪些。"""
    default_raw, default_env = _read(default_home)
    expert_raw, expert_env = _read(expert_home)
    index = store.load_index(expert_home)
    found = store.self_expert(index)
    if not found:
        return []
    plugin, entry = found
    record = entry.get("sync") if isinstance(entry.get("sync"), dict) else {}
    new_raw, new_record, changes = _plan_config(expert_raw, default_raw, record, plugin)

    servers = new_raw.get("mcp_servers") if isinstance(new_raw.get("mcp_servers"), Mapping) else {}
    referenced = _referenced_keys(_managed_providers(new_raw), None)
    for mcp_name in new_record.get("synced_mcp") or []:
        mcp_entry = servers.get(mcp_name)
        if isinstance(mcp_entry, Mapping):
            referenced |= _referenced_keys({}, mcp_entry)
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
    """同步全部已装专家，每个有变化的专家一行说明。"""
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
    """插件加载时同步一次，每个进程只做一次。

    默认档案的后端同步全部已装专家；专家自己的后端只从默认档案拉一次自己那份。东方财富连接器的端口每次开桌面
    都会变，专家后端可能比默认档案的同步先启动；插件在 MCP 读配置之前加载，自己拉一次就不怕启动先后。
    """
    key = str(home)
    if key in _synced_homes:
        return
    _synced_homes.add(key)
    try:
        root = store.root_home(Path(home))
        if root.resolve() != Path(home).resolve():
            if store.self_expert(store.load_index(Path(home))):
                for line in sync_expert(root, Path(home)):
                    logger.info("[uniwork-kits] %s", line)
            return
        if not _expert_homes(home):
            return
        for line in sync_all(home):
            logger.info("[uniwork-kits] %s", line)
    except Exception:
        logger.warning("[uniwork-kits] expert sync failed", exc_info=True)
