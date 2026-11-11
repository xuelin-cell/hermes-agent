"""Stage an operator-supplied verified Office runtime into a desktop payload."""
from pathlib import Path
import importlib.util
import shutil


def stage_native_office(repo_dir: Path,env: dict):
    configured=env.get('UNIWORK_OFFICE_RUNTIME','').strip()
    if not configured:return False
    source=Path(configured).resolve()
    spec=importlib.util.spec_from_file_location('office_payload_assets',repo_dir/'plugins/uniwork-kits/office/assets.py')
    assets=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets)
    assets.verify(source)
    destination=repo_dir/'workbuddy-office-runtime/5.9.3'
    if source!=destination.resolve():
        if destination.exists():raise ValueError('Office payload directory already exists; build from a fresh snapshot')
        shutil.copytree(source,destination,ignore=shutil.ignore_patterns('__pycache__','*.pyc','*.log'))
    assets.verify(destination)
    return True


def warm_office_wheels(repo_dir: Path,cache: Path,env: dict | None):
    import pm
    import tempfile
    runtime=repo_dir/'workbuddy-office-runtime/5.9.3'
    if not runtime.is_dir():return
    with tempfile.TemporaryDirectory(prefix='office-worker-wheels-') as temp:
        pm.build_environment(source=repo_dir/'plugins/uniwork-kits/office/worker-project',out=Path(temp)/'venv',
            python=runtime/'python312/python.exe',cache=cache,env=env,no_install_project=True,explicit=True)
