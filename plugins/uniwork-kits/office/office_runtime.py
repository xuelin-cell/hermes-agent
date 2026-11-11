"""Profile-scoped resources and PM-owned worker environment for Office."""
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess

ENVIRONMENT = "uniwork-office"


def config():
    if not __package__:
        return json.loads(os.environ.get("UNICLAW_OFFICE_SETTINGS", "{}"))
    from hermes_cli.config import load_config_readonly
    return ((load_config_readonly() or {}).get("uniwork_kits") or {}).get("native_office") or {}


def assets_dir() -> Path:
    if not __package__ and os.environ.get("UNICLAW_OFFICE_ASSETS_DIR"):
        return Path(os.environ["UNICLAW_OFFICE_ASSETS_DIR"])
    import hermes_constants
    return Path(config().get("runtime_dir") or Path(hermes_constants.__file__).resolve().parent / "workbuddy-office-runtime/5.9.3").expanduser().resolve()


def command(name: str) -> str | None:
    from hermes_platform.resolver import locate_command
    resolved=locate_command(name)
    return resolved.command[0] if resolved.command else None


def engine_path() -> Path:
    from hermes_platform.host import facts
    platform = facts.os_family()
    arch = "arm64" if facts.native_arch() == "arm64" else "x64"
    return assets_dir()/"engine/bin"/f"{platform}-{arch}"/("editor_sdk.exe" if platform=="win32" else "editor_sdk")


def pdf_path() -> Path:
    return assets_dir()/"pdf-cli"/("workbuddy-pdf.exe" if os.name=="nt" else "workbuddy-pdf")


def recalc_path() -> Path:
    return assets_dir()/"sheet/skills/workbuddy-sheet-generation/scripts/recalc.py"


def find_soffice() -> str | None:
    explicit=config().get("soffice_path")
    return str(explicit) if explicit and Path(explicit).is_file() else command("soffice")


def worker_python(*, prepare=False) -> Path | None:
    import pm
    from hermes_constants import get_hermes_home
    from ..script_python import environment_root
    project=Path(__file__).with_name("worker-project")
    lock=project/"uv.lock"
    if not lock.is_file():
        if not prepare:return None
        raise RuntimeError("Office dependency lock is missing; provision the worker project before deployment")
    version=hashlib.sha256((project/"pyproject.toml").read_bytes()+lock.read_bytes()).hexdigest()[:16]
    root=environment_root(get_hermes_home(),ENVIRONMENT)/version
    marker=root/"ready.json"
    if marker.is_file():
        python=Path(json.loads(marker.read_text(encoding="utf-8"))["python"])
        if python.is_file():return python
    if not prepare:return None
    python=pm.build_environment(source=project,out=root/"venv",python=assets_dir()/"python312/python.exe",
                                no_install_project=True,explicit=True)
    marker.write_text(json.dumps({"python":str(python),"lock":version}),encoding="utf-8")
    return Path(python)


def child_environment() -> dict[str,str]:
    from hermes_constants import get_hermes_home
    import hermes_constants
    allowed={"path","pathext","systemroot","windir","temp","tmp","userprofile","appdata","localappdata","programfiles","programfiles(x86)","programdata","comspec","systemdrive"}
    env={key:value for key,value in os.environ.items() if key.lower() in allowed}
    env.update(PYTHONUTF8="1",PYTHONIOENCODING="utf-8",PYTHONNOUSERSITE="1",
               PYTHONPATH=str(Path(hermes_constants.__file__).resolve().parent),HERMES_HOME=str(get_hermes_home()),
               UNICLAW_OFFICE_ASSETS_DIR=str(assets_dir()),UNICLAW_OFFICE_SETTINGS=json.dumps(config()))
    soffice=find_soffice()
    if soffice:
        env["PATH"]=str(Path(soffice).parent)+os.pathsep+env.get("PATH","")
    return env


def sheetagent_available() -> bool:
    return config().get('enabled',True) and engine_path().is_file() and bool(command("node")) and all((assets_dir()/"sheet"/name).is_file() for name in ["agents/sheet-agent.md","mcp/start.mjs","mcp/server.mjs","mcp/worker.mjs"])


def runtime_status() -> dict:
    files={"engine":engine_path(),"pdf_cli":pdf_path(),"recalc":recalc_path()}
    components={name:{"path":str(path),"available":path.is_file()} for name,path in files.items()}
    deps={name:importlib.util.find_spec(name) is not None for name in ["openpyxl","pymupdf","rapidocr_onnxruntime"]}
    if __package__:
        python=worker_python()
        if python:
            probe=subprocess.run([str(python),'-c',"import importlib.util,json;print(json.dumps({n:importlib.util.find_spec(n) is not None for n in ['openpyxl','pymupdf','rapidocr_onnxruntime']}))"],capture_output=True,text=True,timeout=15,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            if probe.returncode==0:deps=json.loads(probe.stdout)
    return {"provider":"workbuddy","enabled":config().get("enabled",True),"assets_dir":str(assets_dir()),
            "available":all(item["available"] for item in components.values()) and bool(find_soffice()),
            "components":components,"worker_dependencies":deps,"libreoffice":find_soffice(),
            "word_format_extract_bundled":(assets_dir()/"docx/skills/format-extract/dist/cli.cjs").is_file(),
            "sheetagent_assets_available":sheetagent_available(),"pdf_local_ocr_available":deps["pymupdf"] and deps["rapidocr_onnxruntime"],
            "capabilities":{"word":"workbuddy_html_and_sdk; bounded OOXML extraction fallback",
                            "excel_create":"openpyxl+workbuddy_recalc","excel_edit":"native_sdk_or_original_sheetagent",
                            "pdf_read":"workbuddy_pdf_cli","pdf_scan":"local_rapidocr","pdf_export":"libreoffice"}}
