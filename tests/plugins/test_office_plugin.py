"""Office kit/profile isolation and publication contracts."""
import importlib
import json
from pathlib import Path
import sys
import types

import pytest

namespace=types.ModuleType('office_plugin_contract')
namespace.__path__=[str(Path(__file__).parents[2]/'plugins/uniwork-kits')]
sys.modules[namespace.__name__]=namespace
store=importlib.import_module(namespace.__name__+'.store')
runtime=importlib.import_module(namespace.__name__+'.office.office_runtime')
tools=importlib.import_module(namespace.__name__+'.office.tools')
sheet=importlib.import_module(namespace.__name__+'.office.sheetagent')


def test_profile_paths_and_enabled_kits_follow_a_b_a(tmp_path):
    homes=[tmp_path/'A',tmp_path/'B']
    for n,home in enumerate(homes):
        home.mkdir()
        (home/'config.yaml').write_text(f'uniwork_kits:\n  native_office:\n    runtime_dir: {home.as_posix()}/resources\n',encoding='utf-8')
        store.save_index(home,{'plugins':{'xlsx':{'version':'1.0.0-workbuddy-hermes.1','enabled':n==0}}})
    for home in [homes[0],homes[1],homes[0]]:
        with store.scoped_home(home):
            assert runtime.assets_dir()==home/'resources'
            assert ('xlsx' in tools.active_kits())==(home==homes[0])


def test_migrated_hint_uses_the_native_context_contract_and_excludes_ppt(tmp_path,monkeypatch):
    home=tmp_path/'home';home.mkdir()
    store.save_index(home,{'plugins':{'pdf':{'version':'1.0.0-workbuddy-hermes.1','enabled':True,'skill_names':['pdf--pdf']}}})
    monkeypatch.setattr(tools,'available',lambda:True)
    with store.scoped_home(home):
        assert 'pdf--pdf' in tools.hint(user_message='读取扫描 PDF')['context']
        assert tools.hint(user_message='制作 PPT') is None
        store.save_index(home,{'plugins':{'pdf':{'version':'1.0.0-workbuddy-hermes.1','enabled':False}}})
        assert tools.hint(user_message='读取扫描 PDF') is None


def test_unavailable_resources_do_not_downgrade_or_overwrite_owned_kits(tmp_path,monkeypatch):
    import hashlib
    seed=importlib.import_module(namespace.__name__+'.office.seed')
    archives=[]
    for name in ['docx','xlsx','pdf']:
        path=tmp_path/f'{name}.zip';path.write_bytes(name.encode());archives.append(path)
    store.save_index(tmp_path,{'plugins':{
        'docx':{'version':'0','digest':hashlib.sha256(archives[0].read_bytes()).hexdigest()},
        'xlsx':{'version':'1.0.0-workbuddy-hermes.1','digest':'native'},
        'pdf':{'version':'user','digest':'custom'},
    }})
    for status in [{'enabled':False,'available':True},{'enabled':True,'available':False}]:
        monkeypatch.setattr(runtime,'runtime_status',lambda:status)
        assert seed.overlay(tmp_path,archives)==[archives[0]]


def test_publication_detects_source_change_and_publishes_only_valid_revision(tmp_path):
    source=tmp_path/'source.xlsx';verified=tmp_path/'verified.xlsx'
    source.write_bytes(b'original');baseline=sheet.digest(source)
    verified.write_bytes(b'verified')
    source.write_bytes(b'user edited')
    with pytest.raises(RuntimeError,match='Source changed'):
        sheet.publish(verified,source,source,baseline)
    assert source.read_bytes()==b'user edited' and verified.read_bytes()==b'verified'
    sheet.publish(verified,source,source,sheet.digest(source))
    assert source.read_bytes()==b'verified'


def test_vendor_scope_rejects_other_workbook_and_keeps_full_prompt(tmp_path,monkeypatch):
    staged=tmp_path/'staged.xlsx'
    with pytest.raises(ValueError):sheet.scoped_arguments('read_table',{'file_id':'wrong'},staged,'owned')
    with pytest.raises(ValueError):sheet.scoped_arguments('resolve_local_excel',{'local_path':str(tmp_path/'other.xlsx')},staged,'owned')
    root=tmp_path/'assets';(root/'sheet/agents').mkdir(parents=True)
    prompt='完整原版说明\n'*18000
    (root/'sheet/agents/sheet-agent.md').write_text('---\nname: sheet-agent\n---\n'+prompt,encoding='utf-8')
    monkeypatch.setattr(runtime,'assets_dir',lambda:root)
    from mcp.types import Tool
    descriptions={name:Tool(name=name,description=name,inputSchema={'type':'object'}) for name in sheet.VENDOR_TOOLS}
    sheet._tasks['task']={'tools':descriptions,'prompt_loaded':False}
    try:
        result=json.loads(sheet.rpc({'task_token':'task','tool_name':'load-context'}))
        assert result['original_system_instructions']==prompt.strip()
        assert {t['name'] for t in result['tools']}==sheet.VENDOR_TOOLS
        result=json.loads(sheet.rpc({'task_token':'task','tool_name':'Read','arguments':{'file_path':str(tmp_path/'private.md')}}))
        assert result['isError']
    finally:sheet._tasks.pop('task')


def test_sheet_launch_uses_supported_public_contract(tmp_path,monkeypatch):
    from agent.subagent_lifecycle import SubagentLifecycleService
    from toolsets import TOOLSETS,create_custom_toolset
    create_custom_toolset('uniwork_sheetagent','Office contract',tools=['WorkBuddySheetRpc'])
    try:
        request=sheet.launch_request({'file_id':'owned','task_token':'opaque','user_request':'原地保存'})
        SubagentLifecycleService._validate_request(request,types.SimpleNamespace(enabled_toolsets=['uniwork_sheetagent']))
        assert json.loads(request.context)['user_request']=='原地保存'
    finally:TOOLSETS.pop('uniwork_sheetagent')
