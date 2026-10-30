"""Read cloud expert portraits before installation, without modifying account state."""
import base64
from pathlib import Path

from . import autoseed, experts, installer, package, seed, store

_MIME = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'}


def image(path: Path, root: Path) -> str:
    mime = _MIME.get(path.suffix.lower())
    if not mime or not store.is_within(root,path) or not path.is_file(): return ''
    limit = installer.SVG_AVATAR_MAX_BYTES if path.suffix.lower()=='.svg' else installer.AVATAR_MAX_BYTES
    with path.open('rb') as stream: data = stream.read(limit+1)
    if not data or len(data)>limit: return ''
    return f'data:{mime};base64,'+base64.b64encode(data).decode('ascii')


def installed_avatar(root: Path, name: str) -> str:
    row = store.load_index(root)['plugins'].get(name)
    if not isinstance(row,dict) or row.get('kind')!='expert' or row.get('self'): return ''
    profile = str(row.get('profile') or '')
    if not profile or profile.startswith('.') or any(c in profile for c in ('/','\\','\x00')): return ''
    target = root/'profiles'/profile
    if (root/'profiles').is_symlink() or target.is_symlink() or not store.is_within(root/'profiles',target): return ''
    # Preserve the installed identity, including a user-selected portrait.
    files = [target/'profile.yaml',*[target/'assets'/('avatar'+suffix) for suffix in _MIME]]
    for file in files:
        if file.exists() and (not store.is_within(target,file) or file.stat().st_size>installer.AVATAR_MAX_BYTES): return ''
    return experts.profile_avatar_data_url(target)


def avatar(root: Path, name: str) -> str:
    if not name or name in {'.','..'} or any(c in name for c in ('/','\\','\x00')): return ''
    found = installed_avatar(root,name)
    if found: return found
    directory = autoseed.bundled_dir(root)
    if directory is None and (root/'.mt/bundled').is_dir(): directory = root/'.mt/bundled'
    if directory is None: return ''
    portraits = directory/'avatars'
    for suffix in _MIME:
        found = image(portraits/(name+suffix),portraits)
        if found: return found
    # Some experts carry their icon inside the package rather than the shared portraits directory.
    for archive in seed.iter_archives(directory):
        if archive.stem != name: continue
        with package.open_package(archive) as (pristine, work, digest):
            plan = package.build_plan(pristine,work,digest)
            if plan.name != name or plan.kind!='expert': return ''
            source,_ = installer._avatar_source(plan,None)
            return image(source,pristine) if source else ''
    return ''
