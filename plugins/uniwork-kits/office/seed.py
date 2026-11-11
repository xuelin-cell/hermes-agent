"""Replace only bundled Office skills through Hermes's existing kit installer."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import zipfile

from .. import store
from . import office_runtime as runtime

VERSION="1.0.0-workbuddy-hermes.2"


def wrapper(home: Path, settings: dict) -> Path:
    import hermes_constants
    path=store.imported_root(home)/'.native-office/cli.py'
    path.parent.mkdir(parents=True,exist_ok=True)
    repo=str(Path(hermes_constants.__file__).resolve().parent)
    env=runtime.child_environment()
    content=("# Generated profile-bound Office worker entry. No credentials.\n"
             "import os,sys\n"
             f"os.environ.clear();os.environ.update({env!r})\n"
             f"sys.path[:0]=[{repo!r},{str(Path(__file__).parent)!r}]\n"
             "from office_cli import main\n"
             "sys.stdout.reconfigure(encoding='utf-8')\n"
             "raise SystemExit(main())\n")
    if not path.is_file() or path.read_text(encoding='utf-8')!=content:
        temporary=path.with_suffix('.tmp');temporary.write_text(content,encoding='utf-8');temporary.replace(path)
    return path


def overlay(home: Path, archives: list[Path], removed=()):
    if not any(source.stem in {'docx','xlsx','pdf'} for source in archives):return archives
    index=store.load_index(home).get('plugins',{})
    status=runtime.runtime_status()
    if not status['enabled'] or not status['available']:
        # Missing/disabled native resources must not turn an automatic seed into
        # a downgrade, or overwrite a user's same-named custom package.
        result=[]
        for source in archives:
            installed=index.get(source.stem,{})
            if source.stem in {'docx','xlsx','pdf'} and installed:
                native=str(installed.get('version','')).startswith('1.0.0-workbuddy-hermes.')
                custom=installed.get('digest')!=hashlib.sha256(source.read_bytes()).hexdigest()
                if native or custom:continue
            result.append(source)
        return result
    python=runtime.worker_python(prepare=True)
    entry=wrapper(home,runtime.config())
    result=[]
    for source in archives:
        name=source.stem
        if name not in {'docx','xlsx','pdf'} or (name in removed and name not in index):
            result.append(source);continue
        installed=index.get(name,{})
        builtin_hash=hashlib.sha256(source.read_bytes()).hexdigest()
        if installed and not str(installed.get('version','')).startswith('1.0.0-workbuddy-hermes.') and installed.get('digest')!=builtin_hash:
            # User-imported kits are not replaced by a similarly named builtin.
            continue
        with zipfile.ZipFile(source) as archive:
            files={n:archive.read(n) for n in archive.namelist() if not n.endswith('/')}
        candidates=sorted((n for n in files if n.endswith('/SKILL.md')),key=lambda n:(n.count('/'),n))
        skill=candidates[0]
        text=(Path(__file__).parent/'skills'/name/'SKILL.md').read_text(encoding='utf-8')
        for old,new in {'$UNICLAW_OFFICE_PYTHON':str(python).replace('\\','/'),
                        '$UNICLAW_OFFICE_CLI':str(entry).replace('\\','/'),
                        '$UNICLAW_OFFICE_ASSETS_DIR':runtime.assets_dir().as_posix()}.items():text=text.replace(old,new)
        text+='\n\n## Hermes host\nCLI operations may also use WorkBuddyOffice(arguments=[...]) with the same argument list; do not include Python or the CLI path. Use the returned real output path in one MEDIA: attachment in the final answer. Do not attach scripts, previews or internal files unless requested. Never claim success on a failed receipt. Keep the final reply short: describe the requested result and any material limitation, then attach the file. Internal XML, API names, staging paths and debugging history belong in a diagnostic report only when requested.\n'
        files[skill.rsplit('/',1)[0]+'/references/legacy-SKILL.md']=files[skill]
        files[skill]=text.encode('utf-8')
        manifest=min((n for n in files if n.endswith('plugin.json')),key=lambda n:(n.count('/'),n))
        metadata=json.loads(files[manifest]);metadata['version']=VERSION
        files[manifest]=json.dumps(metadata,ensure_ascii=False).encode('utf-8')
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
            for filename,content in sorted(files.items()):
                info=zipfile.ZipInfo(filename,(2026,11,8,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
                archive.writestr(info,content)
        target=store.imported_root(home)/'.native-office'/f'{name}.zip'
        payload=output.getvalue()
        if not target.is_file() or target.read_bytes()!=payload:
            temporary=target.with_suffix('.tmp');temporary.write_bytes(payload);temporary.replace(target)
        result.append(target)
    return result
