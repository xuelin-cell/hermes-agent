"""Dashboard API for kits and experts.

Mounted at ``/api/plugins/uniwork-kits/`` by the dashboard plugin loader.
The loader imports this file by path, outside the plugin package, so the
package is imported by its real name before any of its modules are used.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from hermes_constants import get_hermes_home


def _ensure_plugin() -> None:
    name = "hermes_plugins.uniwork_kits"
    if name in sys.modules:
        return
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        name, root / "__init__.py", submodule_search_locations=[str(root)]
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载套件插件：{root}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)


_ensure_plugin()

catalog = importlib.import_module("hermes_plugins.uniwork_kits.catalog")
experts = importlib.import_module("hermes_plugins.uniwork_kits.experts")
installer = importlib.import_module("hermes_plugins.uniwork_kits.installer")
jobs = importlib.import_module("hermes_plugins.uniwork_kits.jobs")
store = importlib.import_module("hermes_plugins.uniwork_kits.store")

router = APIRouter()


def _home() -> Path:
    return Path(get_hermes_home())


def _fail(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


class ToggleBody(BaseModel):
    name: str
    enabled: bool


class UninstallBody(BaseModel):
    name: str
    delete_profile: bool = False


class ConfigBody(BaseModel):
    name: str
    values: Dict[str, str] = Field(default_factory=dict)


class TriggersBody(BaseModel):
    name: str
    regenerate: bool = False


class RecentBody(BaseModel):
    name: str


@router.get("")
@router.get("/")
def list_installed() -> Dict[str, Any]:
    return catalog.describe(_home())


@router.post("/install")
async def install_zip(file: UploadFile = File(...)) -> Dict[str, Any]:
    data = await file.read()
    filename = file.filename or "package.zip"

    def _run() -> Dict[str, object]:
        path = jobs.save_upload(_home(), filename, data)
        return jobs.start(_home(), ["install", str(path)])

    try:
        job = await asyncio.to_thread(_run)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"job": job}


@router.post("/toggle")
def toggle(body: ToggleBody) -> Dict[str, Any]:
    try:
        entry = installer.set_enabled(_home(), body.name.strip(), body.enabled)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"name": body.name.strip(), "enabled": bool(entry.get("enabled", body.enabled))}


@router.post("/uninstall")
def uninstall(body: UninstallBody) -> Dict[str, Any]:
    name = body.name.strip()
    try:
        notes = installer.uninstall(_home(), name, delete_profile=body.delete_profile)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"name": name, "notes": notes}


@router.post("/config")
def write_config(body: ConfigBody) -> Dict[str, Any]:
    name = body.name.strip()
    pairs = [(key.strip(), value) for key, value in body.values.items() if key.strip()]
    if not name or not pairs:
        raise HTTPException(status_code=400, detail="要写明套件名，并且至少填一项")
    try:
        written = installer.set_config(_home(), name, pairs)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"name": name, "written": written}


@router.post("/triggers")
async def refresh_triggers(body: TriggersBody) -> Dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="要写明套件名")
    entry = (store.load_index(_home()).get("plugins") or {}).get(name)
    if not isinstance(entry, dict):
        raise HTTPException(status_code=400, detail=f"没有装 {name}")
    if entry.get("kind") not in ("kit", "team"):
        raise HTTPException(status_code=400, detail="只有套件有触发词")
    args = ["triggers", name]
    if body.regenerate:
        args.append("--regenerate")
    job = await asyncio.to_thread(jobs.start, _home(), args)
    return {"job": job}


@router.get("/experts")
def expert_directory() -> Dict[str, Any]:
    """What the summon picker lists: every installed expert and the recent five."""
    return experts.directory(_home())


@router.get("/experts/{name}/avatar")
def expert_avatar(name: str) -> Dict[str, str]:
    return {"data_url": experts.avatar_data_url(_home(), name)}


@router.post("/experts/recent")
def summoned(body: RecentBody) -> Dict[str, Any]:
    try:
        return {"recent": experts.record_recent(_home(), body.name.strip())}
    except installer.KitError as exc:
        raise _fail(exc) from exc


@router.get("/receipts/{name}")
def receipt(name: str) -> Dict[str, str]:
    text = catalog.receipt_text(_home(), name)
    if text is None:
        raise HTTPException(status_code=404, detail=f"没有装 {name}")
    return {"name": name, "text": text}


@router.get("/jobs/{job_id}")
def job(job_id: str) -> Dict[str, Any]:
    found: Optional[Dict[str, Any]] = jobs.status(_home(), job_id)
    if found is None:
        raise HTTPException(status_code=404, detail="没有这个任务")
    return found
