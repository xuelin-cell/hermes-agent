"""Original six-tool SheetAgent MCP, hosted by Hermes's public subagent service."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from uuid import uuid4

import anyio

from . import office_runtime as runtime
from .office_cli import DocumentEngine, OfficeError
from .tools import workspace

VENDOR_TOOLS=frozenset({'resolve_local_excel','read_table','get_cell_ranges','set_cell_range','search_data','run_command'})
COMPLETE='SHEETAGENT_COMPLETE'
PUBLISH_LOCK=threading.Lock()
_tasks={}


@asynccontextmanager
async def vendor_sheet_tools(engine):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    server=StdioServerParameters(command=runtime.command('node'),args=[str(runtime.assets_dir()/'sheet/mcp/start.mjs')],
        env={**runtime.child_environment(),'SHEETAGENT_MCP_TRANSPORT':'stdio','SHEET_API_MODE':'local','TENCENT_DOCS_LOCAL_MCP':engine.endpoint})
    async with stdio_client(server) as (read,write),ClientSession(read,write) as session:
        await session.initialize()
        tools={tool.name:tool for tool in (await session.list_tools()).tools}
        if missing:=VENDOR_TOOLS-tools.keys():raise OfficeError(f'SheetAgent tools missing: {sorted(missing)}')
        yield session,tools


def scoped_arguments(name,args,staged,file_id):
    args=dict(args)
    if name=='resolve_local_excel':
        if args.get('local_path') is not None and Path(args['local_path']).resolve()!=staged.resolve():raise ValueError('Only the host-opened workbook is accessible')
        args['local_path']=str(staged)
    elif args.get('file_id')!=file_id:raise ValueError('Use only the host-supplied file_id')
    if args.get('secondary_file_ids'):raise ValueError('This task supports only one workbook')
    if args.get('local_path') is not None and Path(args['local_path']).resolve()!=staged.resolve():raise ValueError('Only the host-opened workbook is accessible')
    return args


def rpc(args,**_):
    try:
        task=_tasks.get(args.get('task_token'))
        if not task:raise ValueError('SheetAgent task expired or unavailable')
        name=args.get('tool_name');arguments=args.get('arguments') or {}
        root=runtime.assets_dir()/'sheet'
        if name=='load-context':
            text=(root/'agents/sheet-agent.md').read_text(encoding='utf-8-sig')
            _,_,body=text.lstrip().partition('---');_,separator,prompt=body.partition('\n---')
            if not separator:raise ValueError('Missing original SheetAgent prompt')
            task['prompt_loaded']=True
            return json.dumps({'original_system_instructions':prompt.strip().replace('${CODEBUDDY_PLUGIN_ROOT}',root.as_posix()),
                'tools':[{'name':name,'description':task['tools'][name].description,'inputSchema':task['tools'][name].input_schema} for name in sorted(VENDOR_TOOLS)],
                'host_adapter':'The complete original instructions above are not abbreviated. Invoke every named vendor tool through WorkBuddySheetRpc using this task_token, tool_name and arguments. Read references through the same bridge with tool_name=Read and arguments.file_path. The host alone saves and verifies. Finish with SHEETAGENT_COMPLETE on its own final line only when all requested operations succeeded.'},ensure_ascii=False)
        if not task['prompt_loaded']:raise ValueError('Load the complete original context before using spreadsheet tools')
        if name=='Read':
            path=Path(arguments.get('file_path','')).resolve()
            if not path.is_relative_to((root/'prompt').resolve()) or path.suffix.lower()!='.md':raise ValueError(f'Read arguments.file_path must be an absolute .md path below {root/"prompt"}')
            return path.read_text(encoding='utf-8')
        if name not in VENDOR_TOOLS:raise ValueError('Unknown vendor tool')
        arguments=scoped_arguments(name,arguments,task['staged'],task['file_id'])
        future=asyncio.run_coroutine_threadsafe(task['session'].call_tool(name,arguments),task['loop'])
        result=future.result(timeout=100)
        return json.dumps(result.model_dump(mode='json',by_alias=True),ensure_ascii=False)
    except (OSError,ValueError,TimeoutError) as exc:
        return json.dumps({'isError':True,'error':str(exc)},ensure_ascii=False)


def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').digest()


def publish(verified,source,output,baseline):
    with PUBLISH_LOCK:
        if output==source and digest(source)!=baseline:raise OfficeError('Source changed during the task; nothing published')
        if output!=source and output.exists():raise OfficeError('Output already exists; nothing overwritten')
        os.replace(verified,output)


def launch_request(payload):
    from agent.subagent_lifecycle import SubagentLaunchRequest
    return SubagentLaunchRequest(
        goal='Act as the original WorkBuddy SheetAgent. First call WorkBuddySheetRpc(tool_name="load-context") with the task_token in context. Read ALL original instructions and schemas returned, then carry out the unmodified user_request using only that bridge. Do not save files; the host verifies and publishes. End with SHEETAGENT_COMPLETE only on complete success.',
        context=json.dumps(payload,ensure_ascii=False),allowed_toolsets=('uniwork_sheetagent',))


async def execute(params,ctx,task_id):
    from .tools import active_kits
    if 'xlsx' not in active_kits():raise OfficeError('The migrated Excel kit is not enabled in this profile')
    root=workspace(task_id)
    def path(value,*,input=False):
        p=Path(value)
        if not p.is_absolute() or (not input and not p.resolve().is_relative_to(root)) or p.suffix.lower()!='.xlsx':raise OfficeError('Use an absolute .xlsx input path and a new output in this task workspace')
        return p.resolve()
    source=path(params['input_path'],input=True)
    request=params['user_request']
    in_place=re.search(r'保存回|原地保存|in.place|save back',request,re.I)
    output=path(params['output_path']) if params.get('output_path') and not in_place else source
    if not source.is_file():raise OfficeError('Input workbook missing')
    if params['action'] not in {'read','edit'}:raise OfficeError('action must be read or edit')
    if not runtime.sheetagent_available():raise OfficeError('SheetAgent resources or Node are missing')
    formula_edit=bool(re.search(r'跨表.{0,20}公式|cross.sheet formulas?',request,re.I))
    bounded_edit=bool(re.search(r'只(?:把|改|修改|调整)|single.cell|only',request,re.I))
    preserve=bool((formula_edit or bounded_edit) and re.search(r'保留[^。\n]{0,70}(?:格式|样式)|preserve[^.\n]{0,70}format',request,re.I))
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.sheetagent-',dir=output.parent) as tmp:
        scratch=Path(tmp);staged=scratch/'source.xlsx';saved=scratch/'saved.xlsx';verified=scratch/'verified.xlsx'
        shutil.copyfile(source,staged);baseline=digest(staged)
        engine=DocumentEngine()
        await anyio.to_thread.run_sync(engine.__enter__)
        try:
            opened=await anyio.to_thread.run_sync(lambda:engine.call('open_file',{'file_path':str(staged),'open_with_existing':True,'wait':True}))
            file_id=opened['file_id']
            info=await anyio.to_thread.run_sync(lambda:engine.call('sheet_get_sheet_info',{'file_id':file_id}))
            async with vendor_sheet_tools(engine) as (session,tools):
                token=uuid4().hex
                _tasks[token]={'session':session,'tools':tools,'staged':staged,'file_id':file_id,'loop':asyncio.get_running_loop(),'prompt_loaded':False}
                payload={'task_token':token,'local_path':str(staged),'file_id':file_id,'sheet_id':info['sheets'][0]['sheet_id'],'user_request':request}
                handle=None
                try:
                    handle=ctx.subagent_lifecycle.launch(launch_request(payload))
                    end=await anyio.to_thread.run_sync(lambda:ctx.subagent_lifecycle.wait(handle,timeout_seconds=480))
                    if not end.completed:
                        ctx.subagent_lifecycle.cancel(handle,reason='Office task timed out')
                        raise OfficeError('SheetAgent timed out; no workbook published')
                    result=ctx.subagent_lifecycle.result(handle)
                    text=result.summary or ''
                    if not result.ready or result.error_classification or text.strip().splitlines()[-1:]!=[COMPLETE]:raise OfficeError(f'SheetAgent did not complete; no workbook published. {result.error_classification or text}')
                    summary=text.strip().rsplit('\n',1)[0]
                except BaseException:
                    if handle:ctx.subagent_lifecycle.cancel(handle,reason='Office operation interrupted')
                    raise
                finally:_tasks.pop(token,None)
            if params['action']=='read':return {'success':True,'summary':summary,'provider':'workbuddy-sheetagent','saved':False}
            await anyio.to_thread.run_sync(lambda:engine.call('save_file',{'file_id':file_id,'file_path':str(saved)}))
        finally:
            with anyio.CancelScope(shield=True):await anyio.to_thread.run_sync(lambda:engine.__exit__(None,None,None))
        python=runtime.worker_python(prepare=True)
        from .office_cli import run
        argv=[str(python),str(Path(__file__).with_name('verify_sheet.py')),str(saved),str(verified)]
        if preserve:argv.append(str(staged))
        if preserve and bounded_edit and not formula_edit:argv.append('--numeric-values')
        proc=await anyio.to_thread.run_sync(lambda:run(argv,120,env=runtime.child_environment()))
        if proc.returncode:raise OfficeError(proc.stderr.decode('utf-8',errors='replace')[-2500:])
        verification=json.loads(proc.stdout.decode('utf-8'))
        publish(verified,source,output,baseline)
        return {'success':True,'summary':summary,'provider':'workbuddy-sheetagent','saved_by':'host.save_file','saved_in_place':output==source,**verification,'output':str(output),
                'next_action':'Host save, original-format preservation and real formula recalculation succeeded. Report this result now; do not run a second recalculation or another editing subtask.'}


def register(ctx):
    from toolsets import create_custom_toolset
    create_custom_toolset('uniwork_sheetagent','Task-scoped original SheetAgent MCP',tools=['WorkBuddySheetRpc'])
    async def handler(args,task_id='',**_):
        try:return json.dumps(await execute(args,ctx,task_id),ensure_ascii=False)
        except (OSError,ValueError,RuntimeError,KeyError,ExceptionGroup) as exc:
            def diagnostic(error):
                if isinstance(error,BaseExceptionGroup):return '; '.join(diagnostic(child) for child in error.exceptions)
                return f'{type(error).__name__}: {error}'
            return json.dumps({'success':False,'error':diagnostic(exc)},ensure_ascii=False)
    ctx.register_tool('WorkBuddySheet','uniwork_office',{'name':'WorkBuddySheet','description':'现有XLSX的数据相关分析、清洗、汇总和跨表公式：交给完整原版SheetAgent与原版六个MCP工具。原样传用户要求；宿主负责原地保存、公式修复、重算与格式保留。',
        'parameters':{'type':'object','properties':{'input_path':{'type':'string'},'user_request':{'type':'string'},'action':{'type':'string','enum':['read','edit']},'output_path':{'type':'string'}},'required':['input_path','user_request','action']}},handler,is_async=True,check_fn=runtime.sheetagent_available,description='原版 Excel 子代理',emoji='📊')
    ctx.register_tool('WorkBuddySheetRpc','uniwork_sheetagent',{'name':'WorkBuddySheetRpc','description':'Only for an active SheetAgent child task. Load the complete original prompt once; invoke the original six MCP tools or read original references using the supplied task token.',
        'parameters':{'type':'object','properties':{'task_token':{'type':'string'},'tool_name':{'type':'string','enum':['load-context','Read',*sorted(VENDOR_TOOLS)]},'arguments':{'type':'object'}},'required':['task_token','tool_name']}},rpc,check_fn=runtime.sheetagent_available,description='SheetAgent private workbook bridge')
