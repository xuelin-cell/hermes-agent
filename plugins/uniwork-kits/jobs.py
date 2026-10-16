"""Background ``hermes kit`` processes for installs and trigger refresh.

The dashboard action log lives in the core web server and only accepts names
registered there. Jobs stay inside this plugin: a detached ``python -m
hermes_cli.main kit ...`` writes a log under the profile home, and the page
polls ``/jobs/{id}``. Arguments are kit subcommands only — config values are
written in-process so a secret never lands on a command line.
"""

from __future__ import annotations

import os
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from . import store

_MAX_TAIL = 80
_JOBS: Dict[str, "_Job"] = {}


@dataclass
class _Job:
    id: str
    home: Path
    log_path: Path
    proc: subprocess.Popen


def _log_dir(home: Path) -> Path:
    path = store.imported_root(home) / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _tail(path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-_MAX_TAIL:])


def start(home: Path, kit_args: List[str]) -> Dict[str, object]:
    """Spawn ``hermes kit <kit_args>`` against *home* and return ``{id, running}``."""
    if not kit_args or kit_args[0] not in {"install", "triggers"}:
        raise ValueError("只有安装和刷新触发词放到后台")
    home = Path(home).resolve()
    job_id = uuid.uuid4().hex[:12]
    log_path = _log_dir(home) / f"{job_id}.log"
    cmd = [sys.executable, "-m", "hermes_cli.main", "kit", *kit_args]
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["HERMES_NONINTERACTIVE"] = "1"
    # The log is decoded as UTF-8. A Windows console code page would otherwise
    # write the receipt in the locale encoding and the page would show garbage.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.pop("_HERMES_GATEWAY", None)
    log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115 — closed after the child inherits it
    try:
        log_file.write(f"=== {job_id} kit {' '.join(kit_args)} ===\n".encode("utf-8"))
        kwargs: Dict[str, object] = {
            "stdin": subprocess.DEVNULL,
            "stdout": log_file,
            "stderr": subprocess.STDOUT,
            "env": env,
        }
        if sys.platform == "win32":
            from hermes_cli._subprocess_compat import windows_detach_flags

            kwargs["creationflags"] = windows_detach_flags()
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **kwargs)  # noqa: S603 — fixed interpreter, kit args only
    finally:
        log_file.close()
    _JOBS[job_id] = _Job(job_id, Path(home), log_path, proc)
    return {"id": job_id, "running": True}


def status(home: Path, job_id: str) -> Optional[Dict[str, object]]:
    """Running flag, exit code, and the log tail. ``None`` when the id is unknown here."""
    job = _JOBS.get(job_id)
    if job is None or job.home != Path(home).resolve():
        return None
    code = job.proc.poll()
    return {
        "id": job.id,
        "running": code is None,
        "exit_code": code,
        "tail": _tail(job.log_path),
    }


def save_upload(home: Path, filename: str, data: bytes, *, limit: int = 100 * 1024 * 1024) -> Path:
    """Store an uploaded zip beside the job logs. The name is not trusted as a path."""
    from .installer import KitError

    if not data or len(data) > limit:
        raise KitError("安装包是空的，或者超过 100MB")
    if not str(filename or "").lower().endswith(".zip"):
        raise KitError("请上传 zip 安装包")
    dest = store.imported_root(home) / "uploads" / f"{uuid.uuid4().hex[:12]}.zip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest
