"""FastAPI元数据 → 原生钩子 → 本机桥 → SessionDB的隔离端到端探针。"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import shutil
from unittest.mock import patch
import time
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hermes_state import SessionDB

plugin_dir=Path(__file__).resolve().parents[4]/"apps/desktop/assets/uniwork-titles"
home=Path(os.environ['HERMES_HOME'])

def module(name,path,package=False):
    """按真实插件加载器的方式导入，并支持其相对导入和Pydantic类型解析。"""
    spec=importlib.util.spec_from_file_location(name,path,submodule_search_locations=[str(path.parent)] if package else None)
    result=importlib.util.module_from_spec(spec); sys.modules[name]=result;spec.loader.exec_module(result)
    return result

api=module('isolated_title_api',plugin_dir/'dashboard/plugin_api.py')
# 通过本基线真实发现/注册/分发链，隔离目录替代所有外部插件来源。
from hermes_cli.plugins import PluginManager
import hermes_cli.plugins as plugins_mod
shutil.copytree(plugin_dir, home/'plugins'/'uniwork-titles')
(home/'config.yaml').write_text('plugins:\n  enabled: [uniwork-titles]\nauxiliary:\n  title_generation:\n    enabled: false\n')
with patch.object(plugins_mod, 'get_bundled_plugins_dir', return_value=home/'empty-bundled'), patch.object(PluginManager, '_scan_entry_points', return_value=[]):
    manager=PluginManager()
    manager.discover_and_load()
loaded=manager._plugins['uniwork-titles']
assert loaded.enabled and not loaded.error, loaded.error
app=FastAPI();app.include_router(api.router,prefix='/api/plugins/uniwork-titles')
db=SessionDB(db_path=home/'state.db')
db.create_session('probe',source='desktop')
raw='@file:/tmp/89413.pdf'
db.append_message('probe','user',raw)
before=db.get_messages('probe')
with TestClient(app) as client:
    result=client.post('/api/plugins/uniwork-titles/seed?profile=default',json={'sessionId':'probe','temporary':'89413.pdf','intent':''})
    assert result.status_code==200 and result.json()['ok'],result.text
    assert db.get_session_title('probe')=='89413.pdf'
    message=[{'type':'text','text':raw}];snapshot=copy.deepcopy(message)
    manager.invoke_hook('pre_llm_call', session_id='probe',user_message=message,is_first_turn=True,platform='desktop')
    manager.invoke_hook('pre_api_request', session_id='probe')
    manager.invoke_hook('post_tool_call', session_id='probe',tool_name='terminal',args={'command':'pdftotext /tmp/89413.pdf -'},result=json.dumps({'exit_code':0,'output':'文件正文：房屋租赁合同，包含押金、租期与违约责任。'}),status='ok')
    deadline=time.monotonic()+8
    while time.monotonic()<deadline and db.get_session_title_source('probe')!='llm':time.sleep(.05)
    assert db.get_session_title('probe')=='房屋租赁合同条款',db.get_session_title('probe')
    assert message==snapshot
    assert db.get_messages('probe')==before
    # 同一Profile两条任务必须在任一模型响应完成前同时进入本机桥。
    for sid in ['parallel-a','parallel-b']:
        db.create_session(sid,source='desktop')
        intent='并行'+sid[-1]+'主题'
        db.append_message(sid,'user',intent)
        assert client.post('/api/plugins/uniwork-titles/seed?profile=default',json={'sessionId':sid,'temporary':intent,'intent':intent}).json()['ok']
        manager.invoke_hook('pre_api_request',session_id=sid)
    deadline=time.monotonic()+8
    while time.monotonic()<deadline and any(db.get_session_title_source(sid)!='llm' for sid in ['parallel-a','parallel-b']):time.sleep(.05)
    for sid in ['parallel-a','parallel-b']:
        assert db.get_session_title_source(sid)=='llm',sid
        assert db.get_session_title(sid)=='并行'+sid[-1]+'主题'
    # 手动改名后相同接口重试不能生成新标题。
    db.set_session_title('probe','我的合同')
    assert client.post('/api/plugins/uniwork-titles/seed?profile=default',json={'sessionId':'probe','temporary':'坏标题','intent':'重复'}).json()=={'ok':False}
    db.close();db=SessionDB(db_path=home/'state.db')
    assert db.get_session_title('probe')=='我的合同'
    assert manager.unload('uniwork-titles')
    assert manager.invoke_hook('pre_api_request', session_id='probe') == []
    print(json.dumps({'nativeDiscoveryAndUnload':True,'saved':True,'mainMessagesUnchanged':True,'manualWins':True,'restart':True}))
db.close()
