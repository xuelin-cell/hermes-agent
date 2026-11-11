"""Hermes tool boundary for the independent Office CLI and original SheetAgent."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import time

from . import office_runtime as runtime


def available():
    return runtime.config().get('enabled',True) and runtime.engine_path().is_file() and runtime.pdf_path().is_file()


def active_kits():
    from hermes_constants import get_hermes_home
    from .. import store
    return {name:entry for name,entry in store.load_index(get_hermes_home()).get('plugins',{}).items()
            if name in {'docx','xlsx','pdf'} and entry.get('enabled',True) and str(entry.get('version','')).startswith('1.0.0-workbuddy-hermes.')}


def workspace(task_id):
    from agent.runtime_cwd import scoped_session_cwd
    from tools.terminal_tool import get_session_cwd
    path=scoped_session_cwd() or get_session_cwd(task_id)
    if not path:raise ValueError('Office needs the current session workspace')
    return Path(path).resolve()


def handle(args,task_id='',quality_client=None,**_):
    started=time.monotonic()
    try:
        if not available():raise ValueError('Office components are disabled or unavailable')
        root=workspace(task_id)
        argv=args.get('arguments',[])
        if not isinstance(argv,list) or not all(isinstance(a,str) for a in argv):raise ValueError('arguments must be a list of strings')
        from .office_cli import parser,run
        try:parsed=parser().parse_args(argv)
        except SystemExit as exc:raise ValueError('Invalid Office CLI arguments; use status or the installed skill examples') from exc
        if parsed.kind!='status' and parsed.kind not in active_kits():raise ValueError('This Office kit is not enabled in the current profile')
        for name in ['input','reference','output','html','content','operations','changes']:
            value=getattr(parsed,name,None)
            # Desktop uploads live in the profile attachment store, outside the session cwd.
            # Inputs are read by the adapter; generated control files and new outputs stay local.
            in_place=name=='output' and value is not None and getattr(parsed,'input',None) is not None and value.resolve()==parsed.input.resolve()
            if value is not None and (not value.is_absolute() or (name not in {'input','reference'} and not in_place and not value.resolve().is_relative_to(root))):
                raise ValueError(f'{name} must be an absolute path inside the current task workspace')
        review_receipt=None
        if parsed.kind=='docx' and parsed.action=='compose':
            from .word_quality import review
            if quality_client is None:raise ValueError('The host Word review service is unavailable')
            reviewed,review_receipt=review(quality_client,task_id,parsed.content,parsed.output)
            argv=list(argv)
            for index,argument in enumerate(argv):
                if argument=='--content':
                    argv[index+1]=str(reviewed)
                    break
                if argument.startswith('--content='):
                    argv[index]='--content='+str(reviewed)
                    break
        python=runtime.worker_python(prepare=True)
        proc=run([str(python),str(Path(__file__).with_name('office_cli.py')),*argv],240,cwd=root,env=runtime.child_environment())
        stdout=proc.stdout.decode('utf-8',errors='replace')
        result=json.loads(stdout.splitlines()[-1]) if stdout.strip() else {'success':False,'error':proc.stderr.decode('utf-8',errors='replace')[-3000:]}
        if proc.returncode:result['success']=False
        if result.get('success') and result.get('output') and not Path(result['output']).exists():
            raise ValueError('Office reported an output path that does not exist')
        result['duration_seconds']=round(time.monotonic()-started,3)
        if review_receipt is not None:
            result['content_review']=review_receipt
            result.setdefault('verification',{})['source_request_reviewed']=True
        if result.get('success') and parsed.kind=='docx' and parsed.action in {'compose','restyle','edit-exact'}:
            result['next_action']='The requested operation and the receipt checks are complete. Present the output file once in the final answer now. Do not repeat successful content/pagination/style checks, probe PDF libraries or run another export. Report any specific limitation already stated in the receipt.'
        if result.get('ocr_lines'):
            result['next']='OCR is local; the text is now available. Answer the user from these lines, preserve page numbers and uncertainty; do not upload or reread page images when local processing was requested. Do not repeat successful extraction.'
        return json.dumps(result,ensure_ascii=False)
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as exc:
        return json.dumps({'success':False,'error':str(exc),'duration_seconds':round(time.monotonic()-started,3)},ensure_ascii=False)


def hint(user_message='',**_):
    text=user_message if isinstance(user_message,str) else ' '.join(p.get('text','') for p in user_message or [] if isinstance(p,dict))
    import re
    kits=active_kits()
    if not kits or not available() or re.search(r'ppt|幻灯片|演示文稿',text,re.I):return None
    if not re.search(r'word|excel|xlsx|docx|pdf|电子表格|工作簿|扫描件',text,re.I):return None
    names=[name for kit in kits.values() for name in kit.get('skill_names',[])]
    return {'context':f'本档案已启用的新版Office套件技能：{names}。先读对应套件技能；旧uniai入口不是默认路线。Word只调整排版优先docx restyle（支持多节、已有目录、脚注批注）；参考模板加--reference。不要为这些任务查询SDK样式或手写排版脚本。Word短中报告用compose一次成文。Excel已明确表名/单元格/数值的修改用xlsx edit-exact，支持原地保存及真实重算；需要发现数据、跨表设计等才用WorkBuddySheet，原样传用户要求。不重装依赖，不把失败/空输出当完成；成功文件在最后说明后只附一次。扫描件本地提取完整文本后直接回答，不反复裁图。'}


def register(ctx):
    from . import word_quality
    ctx.register_hook('pre_llm_call',word_quality.remember)
    ctx.register_hook('on_session_end',word_quality.forget)
    def handler(args,task_id='',**kwargs):
        return handle(args,task_id,quality_client=getattr(ctx,'llm',None),**kwargs)
    ctx.register_tool('WorkBuddyOffice','uniwork_office',{
        'name':'WorkBuddyOffice','description':'Word/Excel/PDF套件的受管执行入口。先读相应技能；arguments为CLI参数列表，如["status"]或["pdf","extract","--input",绝对路径,"--output",绝对路径]。不能执行任意shell命令。',
        'parameters':{'type':'object','properties':{'arguments':{'type':'array','items':{'type':'string'}}},'required':['arguments']}},handler,check_fn=available,description='Word Excel PDF',emoji='📄')
    ctx.register_hook('pre_llm_call',hint)
    from . import sheetagent
    sheetagent.register(ctx)
