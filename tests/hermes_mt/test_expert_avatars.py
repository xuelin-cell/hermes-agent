"""Cloud portraits share desktop assets without installing packages or leaking profile identity."""
import base64
import importlib

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import yaml

from tests.plugins.test_uniwork_kits_plugin import kits, profile_env, _expert_pkg, _zip_dir


@pytest.mark.asyncio
async def test_portraits_before_install_preserve_custom_identity_and_tenant_scope(kits,profile_env,tmp_path):
    routes=importlib.import_module('hermes_plugins.uniwork_kits.cloud_routes')
    roots={'alice':profile_env,'bob':tmp_path/'bob'}
    for owner,root in roots.items():
        root.mkdir(parents=True,exist_ok=True)
        bundle=root/'.mt/bundled'
        (bundle/'avatars').mkdir(parents=True)
        (bundle/'avatars/demo-expert.png').write_bytes((owner+'-template').encode())
        _zip_dir(_expert_pkg(tmp_path/owner),bundle/'plugins/demo-expert.zip')
        (root/'config.yaml').write_text(yaml.safe_dump({'cloud_kits':{'enabled':True},'uniwork_kits':{'bundled_dir':str(bundle)}}))
    app=FastAPI()
    @app.middleware('http')
    async def scope(request,call_next):
        root=roots.get(request.headers.get('X-Hermes-Session-Token'))
        if root is None: return JSONResponse({'error':'unauthorized'},status_code=401)
        with kits.store.scoped_home(root): return await call_next(request)
    app.include_router(routes.router,prefix='/api/plugins/uniwork-kits/cloud')
    path='/api/plugins/uniwork-kits/cloud/experts/demo-expert/avatar'
    def decode(result): return base64.b64decode(result['data_url'].split(',',1)[1])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://instance') as http:
        assert (await http.get(path)).status_code==401
        # A -> B -> A: before install, the card already has the desktop template portrait.
        for owner in ['alice','bob','alice']:
            result=await http.get(path,headers={'X-Hermes-Session-Token':owner})
            assert result.status_code==200 and decode(result.json())==(owner+'-template').encode()
            assert not (roots[owner]/'profiles').exists()
            assert not kits.store.index_path(roots[owner]).exists()
        # Same expert name, two different real profile identities: never use the launch home's profile.
        for owner,root in roots.items():
            profile=root/'profiles/demo-expert'
            (profile/'assets').mkdir(parents=True)
            (profile/'assets/avatar.png').write_bytes((owner+'-custom').encode())
            kits.store.save_index(root,{'plugins':{'demo-expert':{'kind':'expert','profile':'demo-expert','self':False}}})
        for owner in ['alice','bob','alice']:
            result=await http.get(path,headers={'X-Hermes-Session-Token':owner})
            assert decode(result.json())==(owner+'-custom').encode()
        # Removing a missing old portrait falls back to the template without reinstalling/deleting anything.
        (roots['alice']/'profiles/demo-expert/assets/avatar.png').unlink()
        result=await http.get(path,headers={'X-Hermes-Session-Token':'alice'})
        assert decode(result.json())==b'alice-template'
        result=await http.get(path,headers={'X-Hermes-Session-Token':'bob'})
        assert decode(result.json())==b'bob-custom'


def test_package_avatar_fallback_and_file_boundaries(kits,profile_env,tmp_path):
    cloud_avatars=importlib.import_module('hermes_plugins.uniwork_kits.cloud_avatars')
    bundle=profile_env/'.mt/bundled'
    data=b'\x89PNG\r\n\x1a\npackage-image'
    _zip_dir(_expert_pkg(tmp_path,avatar_bytes=data),bundle/'plugins/demo-expert.zip')
    (profile_env/'config.yaml').write_text(yaml.safe_dump({'cloud_kits':{'enabled':True},'uniwork_kits':{'bundled_dir':str(bundle)}}))
    assert base64.b64decode(cloud_avatars.avatar(profile_env,'demo-expert').split(',',1)[1])==data
    outside=tmp_path/'private.png'; outside.write_bytes(b'outside-portrait')
    (bundle/'avatars').mkdir()
    (bundle/'avatars/demo-expert.png').symlink_to(outside)
    # A pointer outside the portraits directory cannot override the packaged expert image.
    assert base64.b64decode(cloud_avatars.avatar(profile_env,'demo-expert').split(',',1)[1])==data
    assert cloud_avatars.avatar(profile_env,'../private')==''
    assert cloud_avatars.avatar(profile_env,'missing')==''
    assert not kits.store.index_path(profile_env).exists()
