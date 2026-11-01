"""Cloud boot seeds real packages, retaining tenant state across later boots."""
import importlib
import importlib.util
import json
import yaml

from tests.plugins.test_uniwork_kits_plugin import (
    PLUGIN_DIR, _zip_dir, kits, profile_env, kit_pkg, expert_pkg,
)


def _boot(root, bundles, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(root))
    if not (root / 'config.yaml').exists():
        root.mkdir(exist_ok=True)
        (root / 'config.yaml').write_text(yaml.safe_dump({
            'cloud_kits': {'enabled': True},
            'uniwork_kits': {'bundled_dir': str(bundles)},
            'model': {'provider': 'yuanjing', 'default': 'fixture'},
        }))
    # Exercise the actual startup entry point, not a test-only seeding path.
    spec = importlib.util.spec_from_file_location('cloud_seed_api_probe', PLUGIN_DIR / 'dashboard/plugin_api.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return importlib.import_module('hermes_plugins.uniwork_kits.cloud_routes').bundled()


def test_boot_seeds_each_tenant_and_retains_disabled_uninstalled_and_expert_state(
    kits, profile_env, kit_pkg, expert_pkg, tmp_path, monkeypatch,
):
    bundles = tmp_path / 'bundled'
    _zip_dir(kit_pkg, bundles / 'plugins/demo-kit.zip')
    _zip_dir(expert_pkg, bundles / 'plugins/demo-expert.zip')
    # Cloud must never run desktop's runtime installer or download dependencies.
    runtime = importlib.import_module('hermes_plugins.uniwork_kits.script_python')
    monkeypatch.setattr(runtime, 'prepare', lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError('runtime install')))
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    roots = [tmp_path / 'tenant-a', tmp_path / 'tenant-b']
    for root in roots:
        result = _boot(root, bundles, monkeypatch)
        assert result['installed'] == 2 and not result['error'] and not result['failed']
        assert not (root / '.mt/kits-active.json').exists()
        expert = cloud.profile_home(root, 'demo-expert')
        config = yaml.safe_load((expert / 'config.yaml').read_text())
        assert config['cloud_kits']['enabled'] and not config['security']['allow_lazy_installs']
        (expert / 'MEMORY.md').write_text(root.name)
    monkeypatch.setenv('HERMES_HOME', str(roots[0]))
    cloud.action({'operation': 'toggle', 'name': 'demo-kit', 'enabled': False})
    before = kits.store.load_index(roots[0])['plugins']['demo-kit']
    assert _boot(roots[0], bundles, monkeypatch)['unchanged'] == 2
    assert kits.store.load_index(roots[0])['plugins']['demo-kit'] == before
    # A changed image updates the kit without enabling it or replacing expert memory.
    manifest = kit_pkg / 'plugin.json'
    raw = json.loads(manifest.read_text())
    raw['version'] = '1.3.0'
    manifest.write_text(json.dumps(raw))
    _zip_dir(kit_pkg, bundles / 'plugins/demo-kit.zip')
    assert _boot(roots[0], bundles, monkeypatch)['installed'] == 1
    entry = kits.store.load_index(roots[0])['plugins']['demo-kit']
    assert entry['version'] == '1.3.0' and not entry['enabled']
    assert (roots[0] / 'profiles/demo-expert/MEMORY.md').read_text() == roots[0].name
    cloud.action({'operation': 'uninstall', 'name': 'demo-expert', 'delete_profile': True})
    assert not _boot(roots[0], bundles, monkeypatch)['error']
    assert 'demo-expert' not in kits.store.load_index(roots[0])['plugins']
    assert _boot(roots[1], bundles, monkeypatch)['installed'] == 1
    assert (roots[1] / 'profiles/demo-expert/MEMORY.md').read_text() == roots[1].name


def test_boot_failure_is_reported_and_manual_uninstall_is_not_resurrected(
    kits, profile_env, kit_pkg, tmp_path, monkeypatch,
):
    bundles = tmp_path / 'bundled'
    _zip_dir(kit_pkg, bundles / 'plugins/demo-kit.zip')
    (profile_env / 'config.yaml').write_text(yaml.safe_dump({
        'cloud_kits': {'enabled': True}, 'uniwork_kits': {'bundled_dir': str(bundles)},
    }))
    cloud = importlib.import_module('hermes_plugins.uniwork_kits.cloud')
    cloud.action({'operation': 'install', 'name': 'demo-kit'})
    cloud.action({'operation': 'uninstall', 'name': 'demo-kit'})
    (bundles / 'plugins/broken.zip').write_bytes(b'invalid archive')
    result = _boot(profile_env, bundles, monkeypatch)
    assert result['ran'] and not result['running'] and result['failed']
    assert 'demo-kit' not in kits.store.load_index(profile_env)['plugins']
    assert not (profile_env / '.mt/kits-active.json').exists()
