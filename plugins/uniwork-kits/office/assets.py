"""Versioned Office assets: verify local inputs and never mix upgrade directories."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile

PINNED={
    'engine/bin/win32-x64/editor_sdk.exe':'b15ee76fc11296651a03386552dce9e6b81d2908c5133bfed21c7d8dbc7da3f1',
    'pdf-cli/workbuddy-pdf.exe':'f24002b0bb7b9f23310955afd075ae26f16f7af84619940aebca6c16a426cd4b',
    'docx/skills/html-to-doc/scripts/convert_doc.py':'9b326657f4ed55d203410774e61fe15caee439528a4d5295e75cbc05550679fe',
    'sheet/mcp/server.mjs':'228bcaaac576cf4d30b23837cb8eb30e007e497a796d4af8e89d813347ec774f',
    'sheet/agents/sheet-agent.md':'651c3a2b0f5ee0c0f249e85b4b8cd370c023d932c35886ea62605b5506843a3c',
}


def sha(path):
    with path.open('rb') as reader:return hashlib.file_digest(reader,'sha256').hexdigest()


def record(root):
    for name,expected in PINNED.items():
        if sha(root/name)!=expected:raise ValueError(f'Office component differs from migration baseline: {name}')
    files=[{'path':p.relative_to(root).as_posix(),'sha256':sha(p),'bytes':p.stat().st_size}
           for p in sorted(root.rglob('*')) if p.is_file() and p.name!='manifest.json' and '__pycache__' not in p.parts and p.suffix!='.pyc']
    data={'version':'5.9.3','platform':'win32-x64','python':'3.12.13','files':files}
    (root/'manifest.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return data


def verify(root):
    data=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    for row in data['files']:
        path=(root/row['path']).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file() or sha(path)!=row['sha256']:
            raise ValueError(f'Office asset missing or changed: {row["path"]}')
    for name,expected in PINNED.items():
        if sha(root/name)!=expected:raise ValueError(f'Unrecognized Office component: {name}')
    if not (root/'python312/python.exe').is_file():raise ValueError('Office Python 3.12 runtime is missing')
    return data


def install(source,python_source,destination):
    if destination.exists():
        verify(destination)
        return destination
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.office-assets-',dir=destination.parent) as temporary:
        staged=Path(temporary)/'5.9.3';staged.mkdir()
        ignore=shutil.ignore_patterns('__pycache__','*.pyc','*.log')
        for name in ['engine','docx','sheet','pdf-cli','pdf-skill']:
            shutil.copytree(source/name,staged/name,ignore=ignore)
        shutil.copytree(python_source,staged/'python312',ignore=ignore)
        record(staged);verify(staged)
        staged.replace(destination)
    return destination
