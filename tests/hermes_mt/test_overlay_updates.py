"""Real Git source snapshots and source replacement, without model/network credentials."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/hermes-mt/scripts/image_overlay.py'


def module():
    spec = importlib.util.spec_from_file_location('image_overlay', SCRIPT)
    overlay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(overlay)
    return overlay


def commit(repo):
    subprocess.run(['git', 'add', '-A'], cwd=repo, check=True)
    subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'source update'], cwd=repo, check=True)


def repository(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
    paths = {
        'deploy/hermes-mt/overlay.list': 'plugins/example/\nplugins/uniwork-kits/\ntools/example.py\n',
        'plugins/example/old.py': 'value = "old"\n',
        'plugins/example/pyproject.toml': '[project]\nname = "example"\n',
        'tools/example.py': 'value = "old tool"\n',
        'pyproject.toml': '[project]\nname = "core"\n',
        'uv.lock': 'version = 1\n',
        'apps/shared/client.ts': 'export const value = 1\n',
        'deploy/hermes-mt/scripts/base_seed.py': '# build recipe\n',
        'deploy/hermes-mt/scripts/image_overlay.py': SCRIPT.read_text(),
    }
    for name, value in paths.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    commit(repo)
    return repo


def test_code_updates_reuse_base_but_dependencies_build_inputs_and_boundaries_do_not(tmp_path):
    overlay, repo = module(), repository(tmp_path)
    original_base = overlay.base_tag(repo)
    original_snapshot = overlay.snapshot(repo)
    (repo / 'plugins/example/old.py').rename(repo / 'plugins/example/new.py')
    (repo / 'plugins/example/new.py').write_text('value = "new"\n')
    (repo / 'tools/example.py').unlink()
    commit(repo)
    assert overlay.base_tag(repo) == original_base
    assert overlay.snapshot(repo) != original_snapshot
    previous = original_base
    for name in ('uv.lock', 'pyproject.toml', 'plugins/example/pyproject.toml',
                 'apps/shared/client.ts', 'deploy/hermes-mt/scripts/base_seed.py'):
        path = repo / name
        path.write_text(path.read_text() + '\n# changed\n')
        commit(repo)
        current = overlay.base_tag(repo)
        assert current != previous, name
        previous = current
    (repo / 'deploy/hermes-mt/overlay.list').write_text('plugins/example/\n')
    commit(repo)
    assert overlay.base_tag(repo) != previous


def test_replacement_removes_deleted_files_and_rejects_stale_corrupt_or_unsafe_sources(tmp_path):
    overlay, repo = module(), repository(tmp_path)
    staged, image = tmp_path / 'staged', tmp_path / 'image'
    resources = tmp_path / 'kits'
    archive = resources / 'plugins/uniwork-kits/bundled/uniwork-bundled/plugins/test.zip'
    archive.parent.mkdir(parents=True)
    archive.write_bytes(b'package v1')
    overlay.stage(repo, staged, resources)
    image.mkdir()
    overlay.apply(staged, image)
    (image / 'other-service.txt').write_text('keep')
    (repo / 'plugins/example/old.py').rename(repo / 'plugins/example/new.py')
    (repo / 'plugins/example/new.py').write_text('value = "new"\n')
    (repo / 'tools/example.py').unlink()
    archive.rename(archive.with_name('new.zip'))
    archive = archive.with_name('new.zip')
    archive.write_bytes(b'package v2')
    commit(repo)
    overlay.stage(repo, staged, resources)
    manifest = json.loads((staged / 'manifest.json').read_text())
    with pytest.raises(ValueError):
        overlay.verify(image, manifest)
    overlay.apply(staged, image)
    overlay.verify(image, manifest)
    assert not (image / 'plugins/example/old.py').exists()
    assert not (image / 'tools/example.py').exists()
    assert (image / 'plugins/example/new.py').read_text() == 'value = "new"\n'
    assert (image / 'other-service.txt').read_text() == 'keep'
    assert not (image / 'plugins/uniwork-kits/bundled/uniwork-bundled/plugins/test.zip').exists()
    assert (image / archive.relative_to(resources)).read_bytes() == b'package v2'
    (image / 'plugins/example/stale.py').write_text('stale')
    with pytest.raises(ValueError, match='file set'):
        overlay.verify(image, manifest)
    (staged / 'plugins/example/new.py').write_text('corrupt')
    with pytest.raises(ValueError, match='content/mode'):
        overlay.apply(staged, image)
    overlay.stage(repo, staged, resources)
    shutil.rmtree(image / 'plugins')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'keep').write_text('keep')
    (image / 'plugins').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='parent is a symlink'):
        overlay.apply(staged, image)
    assert (outside / 'keep').read_text() == 'keep'
