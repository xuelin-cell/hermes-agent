"""Cloud kit management uses the existing installer and tenant-owned expert profiles."""
from __future__ import annotations

import os
import json
import threading
from contextlib import contextmanager
from pathlib import Path

from . import autoseed, catalog, expert_sync, experts, installer, package, seed, store

_lock = threading.RLock()


def home() -> Path:
    from hermes_constants import get_hermes_home
    from hermes_cli.config import load_config_readonly

    root = store.root_home(Path(get_hermes_home())).resolve()
    with store.scoped_home(root):
        if not (load_config_readonly().get('cloud_kits') or {}).get('enabled'):
            raise installer.KitError('当前实例尚未启用云端套件，请更新实例模板。')
    return root


def resources(root: Path) -> dict:
    directory = autoseed.bundled_dir(root)
    if directory is None and (root / '.mt/bundled').is_dir():
        directory = root / '.mt/bundled'
    if directory is None:
        raise installer.KitError('实例缺少套件资源，请更新实例模板。')
    result = {}
    for archive in seed.iter_archives(directory):
        with package.open_package(archive) as (pristine, work, digest):
            plan = package.build_plan(pristine, work, digest)
            if plan.name in result:
                raise installer.KitError('内置套件存在重名资源。')
            result[plan.name] = (archive, plan)
    return result


def profile_home(root: Path, name: str) -> Path:
    if name == 'default':
        return root
    if not isinstance(name, str) or not name or '/' in name or '\\' in name or name.startswith('.'):
        raise installer.KitError('无效的专家档案。')
    target = root / 'profiles' / name
    if (root / 'profiles').is_symlink() or target.is_symlink() or not target.is_dir() or not store.is_within(root / 'profiles', target):
        raise installer.KitError('专家档案不存在。')
    match = [(key, value) for key, value in store.load_index(root)['plugins'].items()
             if value.get('kind') == 'expert' and not value.get('self') and value.get('profile') == name]
    own = store.self_expert(store.load_index(target))
    if len(match) != 1 or not own or own[0] != match[0][0] or not match[0][1].get('enabled', True):
        raise installer.KitError('该专家未安装、已停用或不属于当前账号。')
    return target


def busy(root: Path) -> bool:
    from tui_gateway import server

    try:
        activity = json.loads((root / '.mt/connectors-active.json').read_text())
        if activity.get('active', 0) > 0:
            os.kill(int(activity['pid']), 0)
            return True
    except FileNotFoundError:
        pass
    except ProcessLookupError:
        pass
    except (OSError, ValueError, KeyError, TypeError):
        return True
    return any(value.get('running', False) or (value.get('agent_ready') is not None and not value['agent_ready'].is_set())
               for value in list(server._sessions.values())
               if store.is_within(root, Path(value.get('profile_home') or root)))


@contextmanager
def changing(root: Path):
    """Publish activity before checking the drain fence, matching the connector protocol."""
    marker = root / '.mt/kits-active.json'
    from utils import atomic_json_write

    with _lock:
        install_lock = store.imported_root(root) / autoseed.LOCK_NAME
        if not autoseed._acquire(install_lock):
            raise installer.KitError('另一个窗口正在修改套件，请完成后重试。')
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            atomic_json_write(marker, {'pid': os.getpid(), 'running': True})
            if (root / '.mt/connectors-draining').exists():
                raise installer.KitError('实例正在排空，请稍后重试。')
            if busy(root):
                raise installer.KitError('存在正在执行的对话，请结束后再修改套件或专家。')
            yield
        finally:
            try:
                marker.unlink(missing_ok=True)
            finally:
                autoseed._release(install_lock)


def describe(root: Path) -> dict:
    installed = {row['name']: row for row in catalog.describe(root)['plugins']}
    rows = []
    for name, (_, plan) in resources(root).items():
        row = installed.pop(name, None)
        if row is None:
            row = {'name': name, 'kind': plan.kind, 'display_name': plan.display_name(),
                   'description': plan.manifest.description, 'version': plan.version,
                   'enabled': False, 'profile': '', 'self': False, 'market_id': '',
                   'profession': '', 'phrases': [], 'skill_count': 0, 'agent_count': 0,
                   'mcp_count': 0, 'user_config': [], 'missing_secrets': [],
                   'oauth_servers': [], 'pending_triggers': 0, 'unverified_triggers': 0}
        else:
            row['enabled'] = store.load_index(root)['plugins'][name].get('enabled', True)
        row['installed'] = name in store.load_index(root)['plugins']
        rows.append(row)
    rows.extend({**row, 'installed': True} for row in installed.values())
    return {'plugins': rows}


def directory(root: Path) -> dict:
    result = experts.directory(root)
    result['experts'] = [row for row in result['experts']
                         if store.load_index(root)['plugins'][row['name']].get('enabled', True)]
    return result


def action(data: dict) -> dict:
    root = home()
    operation, name = data.get('operation'), data.get('name')
    result = {'ok': True}
    if not isinstance(name, str) or len(name) > 256:
        raise installer.KitError('请指定套件或专家。')
    with changing(root), store.scoped_home(root):
        if operation == 'install':
            resource = resources(root).get(name)
            if resource is None:
                raise installer.KitError('只能安装当前模板内置的套件。')
            receipt = installer.install(resource[0], root, triggers=installer.bundled_triggers(),
                                        avatars_dir=seed.avatars_beside(resource[0]), generate_triggers=False)
            if not receipt.ok:
                raise installer.KitError(receipt.error)
            expert_sync.sync_named(root, name)
        elif operation == 'toggle':
            if not isinstance(data.get('enabled'), bool):
                raise installer.KitError('请指定启用状态。')
            installer.set_enabled(root, name, data['enabled'])
        elif operation == 'uninstall':
            index = store.load_index(root)
            entry = index['plugins'].get(name, {})
            if entry.get('kind') == 'expert' and not entry.get('self'):
                if data.get('delete_profile') is not True:
                    raise installer.KitError('卸载专家会删除对话和记忆，请明确确认删除档案。')
                # One cloud backend serves several profiles. CLI profile deletion uses
                # the launch home, so delete only the already verified owned directory.
                target = profile_home(root, entry.get('profile', ''))
                store.safe_rmtree(target, root)
                index['plugins'].pop(name)
                store.save_index(root, index)
            else:
                installer.uninstall(root, name, delete_profile=data.get('delete_profile') is True)
        elif operation == 'config':
            values = data.get('values')
            if not isinstance(values, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in values.items()):
                raise installer.KitError('配置字段无效。')
            entry = store.load_index(root)['plugins'].get(name, {})
            target = profile_home(root, entry.get('profile', '')) if entry.get('kind') == 'expert' and not entry.get('self') else root
            installer.set_config(target, name, list(values.items()))
        elif operation == 'sync':
            expert_sync.sync_named(root, name)
        elif operation == 'recent':
            result['recent'] = experts.record_recent(root, name)
        else:
            raise installer.KitError('不支持的云端套件操作。')
    return result
