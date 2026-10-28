"""Cloud folder creation uses the real forwarder and tenant volume, without Electron."""
import asyncio
import importlib.util
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import aiohttp
import pytest

SEED = Path(__file__).resolve().parents[2] / 'deploy/hermes-mt/seed'
if str(SEED) not in sys.path:
    sys.path.insert(0, str(SEED))
from mtfolders import ConversationFolders


@pytest.mark.platforms('posix')
def test_unique_folders_and_cleanup_preserve_existing_files_links_and_other_tenants(tmp_path):
    roots, managers = {}, {}
    for owner in ('alice', 'bob'):
        root = tmp_path / owner
        root.mkdir()
        roots[owner] = root
        link = tmp_path / f'{owner}-workspace'
        link.symlink_to(root, target_is_directory=True)
        managers[owner] = ConversationFolders(link, now=lambda: datetime(2026, 10, 28, 12))
    alice, bob = managers['alice'], managers['bob']
    assert alice.create(str(roots['bob'])) is None
    with ThreadPoolExecutor(max_workers=4) as pool:
        folders = list(pool.map(alice.create, [str(roots['alice'])] * 4))
    assert len(set(folders)) == 4
    assert all((Path(folder) / '.tmp').is_dir() for folder in folders)
    for owner in ('alice', 'bob', 'alice'):
        folder = managers[owner].create(str(roots[owner]))
        managers['bob' if owner == 'alice' else 'alice'].discard(folder)
        assert Path(folder).exists()
        managers[owner].discard(folder)
        assert not Path(folder).exists()
    preexisting = roots['alice'] / 'existing'
    preexisting.mkdir()
    alice.discard(str(preexisting))
    assert preexisting.exists()
    file = Path(folders[0]) / '报告.md'
    file.write_text('keep')
    alice.discard(folders[0])
    assert file.read_text() == 'keep'
    scratch = Path(folders[1]) / '.tmp' / 'draft.py'
    scratch.write_text('keep')
    alice.discard(folders[1])
    assert scratch.read_text() == 'keep'
    replaced = Path(folders[2])
    replaced.rename(replaced.with_name('moved'))
    replaced.symlink_to(roots['bob'], target_is_directory=True)
    alice.discard(folders[2])
    assert replaced.is_symlink() and roots['bob'].is_dir()
    folder = alice.create(str(roots['alice']))
    # Receipts belong to the creating process; restarting cannot authorize old cleanup.
    ConversationFolders(alice.workspace).discard(folder)
    assert Path(folder).exists()


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
async def test_forwarder_requires_auth_and_json_and_creates_only_in_its_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_DASHBOARD_FILES_ROOT', str(tmp_path / 'workspace'))
    spec = importlib.util.spec_from_file_location('folder_forwarder', SEED / 'forward.py')
    forward = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(forward)
    forward.WORKSPACE.mkdir()
    forward._hermes_token = 'instance-token'
    server = await asyncio.start_server(forward._handle, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    async with server, aiohttp.ClientSession() as http:
        base = f'http://127.0.0.1:{port}/__mt_user/files/'
        auth = {'X-Hermes-Session-Token': 'instance-token'}
        async def call(op, body, headers=auth):
            async with http.post(base + op, json=body, headers=headers) as response:
                return response.status, await response.json()
        request = {'defaultCwd': str(forward.WORKSPACE)}
        assert (await call('conversation-create', request, {}))[0] == 403
        async with http.post(base + 'conversation-create', data='{}', headers=auth) as response:
            assert response.status == 415
        status, value = await call('conversation-create', {'defaultCwd': str(tmp_path)})
        assert status == 200 and value['path'] is None
        status, value = await call('conversation-create', request)
        folder = Path(value['path'])
        assert status == 200 and folder.parent == forward.WORKSPACE
        assert (folder / '.tmp').is_dir()
        assert (await call('conversation-discard', {'path': str(folder)}))[0] == 200
        assert not folder.exists()
        forward._draining = True
        assert (await call('conversation-create', request))[0] == 503
