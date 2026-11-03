"""Cloud image source boundaries; compatible with the deployment host's Python 3.6.

Directory entries end in '/'. Keep entries for deleted paths until a base rebuild
so a reused base cannot resurrect them. Only tracked regular files are shipped.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def git(repo, *args):
    return subprocess.check_output(['git'] + list(args), cwd=str(repo))


def entries(repo):
    result = []
    for line in (repo / 'deploy/hermes-mt/overlay.list').read_text().splitlines():
        item = line.split('#', 1)[0].strip()
        if not item:
            continue
        # Limit deletion/replacement to the existing runtime source areas.
        if not re.fullmatch(r'(plugins|tools|gateway|tui_gateway|apps/desktop/assets)/[A-Za-z0-9_./-]+/?', item):
            raise ValueError('Invalid overlay path: ' + item)
        if any(part in ('', '.', '..') for part in item.rstrip('/').split('/')):
            raise ValueError('Invalid overlay path: ' + item)
        if any(item.rstrip('/') == old.rstrip('/') or item.startswith(old.rstrip('/') + '/')
               or old.startswith(item.rstrip('/') + '/') for old in result):
            raise ValueError('Overlapping overlay paths: ' + item)
        result.append(item)
    return sorted(result)


def covered(name, roots):
    return any(name.startswith(root) if root.endswith('/') else name == root for root in roots)


def records(repo):
    rows = git(repo, 'ls-tree', '-rz', 'HEAD').decode().split('\0')
    return [row.split('\t', 1) for row in rows if row]


def base_tag(repo):
    roots = entries(repo)
    digest = hashlib.sha256(('overlay-v1\n' + '\n'.join(roots)).encode())
    for metadata, name in records(repo):
        # Dependency declarations still invalidate the base even inside an overlay.
        dependency = (Path(name).name in ('pyproject.toml', 'uv.lock', 'package.json', 'package-lock.json', '.npmrc')
                      or 'requirements' in Path(name).name and Path(name).suffix in ('.txt', '.in'))
        build_input = name in ('deploy/hermes-mt/scripts/base_seed.py',
                              'deploy/hermes-mt/scripts/image_overlay.py')
        ignored_area = name.split('/')[0] in ('apps', 'deploy', 'docs', 'tests', 'website')
        if build_input or name.startswith('apps/shared/') or (not ignored_area and (dependency or not covered(name, roots))):
            digest.update((metadata + '\t' + name + '\n').encode())
    return 'hermes-custom:src-' + digest.hexdigest()[:12]


def snapshot(repo):
    roots = entries(repo)
    files = {}
    rows = records(repo)
    for metadata, name in rows:
        if not covered(name, roots):
            continue
        mode = metadata.split()[0]
        path = repo / name
        if mode not in ('100644', '100755') or path.is_symlink() or not path.is_file():
            raise ValueError('Overlay requires a tracked regular file: ' + name)
        if any(parent.is_symlink() for parent in path.parents if parent != repo and repo in parent.parents):
            raise ValueError('Overlay parent is a symlink: ' + name)
        files[name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'executable': mode == '100755'}
    for root in roots:
        if not root.endswith('/') and any(name.startswith(root + '/') for _, name in rows):
            raise ValueError('Directory overlay must end in /: ' + root)
    return {'roots': roots, 'files': files}


def stage(repo, out, kits=None):
    manifest = snapshot(repo)
    sources = {name: repo / name for name in manifest['files']}
    if kits is not None:
        bundled = 'plugins/uniwork-kits/bundled/uniwork-bundled/'
        if not covered(bundled, manifest['roots']) or not (kits / bundled).is_dir():
            raise ValueError('Kits resources must exist inside an overlay directory')
        # The config repository is the authoritative package set, including removals.
        sources = {name: path for name, path in sources.items() if not name.startswith(bundled)}
        manifest['files'] = {name: expected for name, expected in manifest['files'].items() if name in sources}
        for path in (kits / bundled).rglob('*'):
            if path.is_symlink():
                raise ValueError('Kits resource is a symlink: ' + str(path))
            if path.is_file():
                name = str(path.relative_to(kits))
                sources[name] = path
                # Archives, avatars and provenance are data, regardless of host checkout mode.
                manifest['files'][name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'executable': False}
    if out.exists():
        shutil.rmtree(str(out))
    out.mkdir(parents=True)
    for name, expected in manifest['files'].items():
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(sources[name]), str(target))
        target.chmod(0o755 if expected['executable'] else 0o644)
    (out / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True) + '\n')


def destination(target, name):
    path = target / name.rstrip('/')
    # Never follow a base image's parent symlink while deleting source.
    for parent in path.parents:
        if parent == target:
            break
        if parent.is_symlink():
            raise ValueError('Overlay destination parent is a symlink: ' + str(parent))
    return path


def verify(target, manifest):
    actual = set()
    for root in manifest['roots']:
        path = destination(target, root)
        if path.is_symlink():
            raise ValueError('Overlay destination is a symlink: ' + root)
        if root.endswith('/'):
            if path.exists() and not path.is_dir():
                raise ValueError('Expected overlay directory: ' + root)
            for parent, directories, names in os.walk(str(path)):
                for name in directories + names:
                    candidate = Path(parent) / name
                    if candidate.is_symlink():
                        raise ValueError('Unexpected overlay symlink: ' + str(candidate))
                actual.update(str((Path(parent) / name).relative_to(target)) for name in names)
        elif path.exists():
            actual.add(root)
    if actual != set(manifest['files']):
        raise ValueError('Overlay file set mismatch: ' + repr(actual.symmetric_difference(manifest['files'])))
    for name, expected in manifest['files'].items():
        path = destination(target, name)
        if (not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']
                or bool(path.stat().st_mode & 0o111) != expected['executable']):
            raise ValueError('Overlay content/mode mismatch: ' + name)


def apply(source, target):
    manifest = json.loads((source / 'manifest.json').read_text())
    verify(source, manifest)
    for root in manifest['roots']:
        path = destination(target, root)
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(str(path))
    for name in manifest['files']:
        path = destination(target, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(source / name), str(path))
    verify(target, manifest)


if __name__ == '__main__':
    command = sys.argv[1]
    root = Path(sys.argv[2]).resolve()
    if command == 'base-tag':
        print(base_tag(root))
    elif command == 'snapshot':
        print(json.dumps(snapshot(root), sort_keys=True))
    elif command == 'stage':
        stage(root, Path(sys.argv[3]), Path(sys.argv[4]) if len(sys.argv) == 5 else None)
    elif command == 'apply':
        apply(root, Path(sys.argv[3]).resolve())
    elif command == 'verify':
        verify(root, json.load(sys.stdin))
    else:
        raise ValueError('Unknown overlay command: ' + command)
