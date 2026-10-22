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
    """后端挂载这个接口文件时，插件包可能还没被插件系统导入；按插件系统的方式先把它导入，后面的模块才能引用。"""
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
expert_sync = importlib.import_module("hermes_plugins.uniwork_kits.expert_sync")
installer = importlib.import_module("hermes_plugins.uniwork_kits.installer")
jobs = importlib.import_module("hermes_plugins.uniwork_kits.jobs")
store = importlib.import_module("hermes_plugins.uniwork_kits.store")
autoseed = importlib.import_module("hermes_plugins.uniwork_kits.autoseed")

router = APIRouter()

# The backend mounts this module when it starts: put the bundled kits and
# experts into a new account, or update the ones that changed, off the
# request path. Only the default profile's backend does it (see autoseed).
try:
    autoseed.start(Path(get_hermes_home()))
except Exception:  # a failed start must not keep the API from mounting
    import logging

    logging.getLogger(__name__).warning("[uniwork-kits] could not start the bundled kit install", exc_info=True)


def _home() -> Path:
    """不管哪个档案的后端收到请求，套件页和召唤名单都按默认档案说话，套件和专家都装在那里。"""
    return store.root_home(Path(get_hermes_home()))


def _fail(exc: Exception) -> HTTPException:
    """把安装器的错误转成 400 返回给页面，错误文字原样带上。"""
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
    """套件页的全部卡片。"""
    return catalog.describe(_home())


@router.post("/install")
async def install_zip(file: UploadFile = File(...)) -> Dict[str, Any]:
    """接收上传的 zip，存好后在后台安装，立刻返回任务号供页面轮询。"""
    data = await file.read()
    filename = file.filename or "package.zip"

    def _run() -> Dict[str, object]:
        """在线程里保存上传文件并启动安装任务，避免阻塞接口。"""
        path = jobs.save_upload(_home(), filename, data)
        return jobs.start(_home(), ["install", str(path)])

    try:
        job = await asyncio.to_thread(_run)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"job": job}


@router.post("/toggle")
def toggle(body: ToggleBody) -> Dict[str, Any]:
    """启用或停用一个套件或专家。"""
    try:
        entry = installer.set_enabled(_home(), body.name.strip(), body.enabled)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"name": body.name.strip(), "enabled": bool(entry.get("enabled", body.enabled))}


@router.post("/uninstall")
def uninstall(body: UninstallBody) -> Dict[str, Any]:
    """卸载一个包；专家要明确带上 delete_profile 才会连档案一起删。"""
    name = body.name.strip()
    try:
        notes = installer.uninstall(_home(), name, delete_profile=body.delete_profile)
    except installer.KitError as exc:
        raise _fail(exc) from exc
    return {"name": name, "notes": notes}


@router.post("/config")
def write_config(body: ConfigBody) -> Dict[str, Any]:
    """把用户在页面上填的配置项写进对应档案的 .env。"""
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
    """在后台重新生成或补齐一个套件的触发词，只有套件有触发词。"""
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


@router.get("/bundled")
def bundled_status() -> Dict[str, Any]:
    """内置套件和专家是否还在安装，给套件页的进度条用。"""
    return autoseed.status()


@router.get("/experts")
def expert_directory() -> Dict[str, Any]:
    """召唤名单：全部已装专家和最近召唤的几位。"""
    return experts.directory(_home())


@router.get("/experts/{name}/avatar")
def expert_avatar(name: str) -> Dict[str, str]:
    """某位专家的头像（data URL），没有则为空字符串。"""
    return {"data_url": experts.avatar_data_url(_home(), name)}


@router.post("/experts/recent")
def summoned(body: RecentBody) -> Dict[str, Any]:
    """记一次召唤，把这位专家挪到「最近召唤」最前面。"""
    try:
        return {"recent": experts.record_recent(_home(), body.name.strip())}
    except installer.KitError as exc:
        raise _fail(exc) from exc


@router.post("/experts/sync")
def sync_one(body: RecentBody) -> Dict[str, Any]:
    """让一位专家马上跟上通用助手的配置（例如刚连上的东方财富连接器），返回改了哪些。"""
    return {"changes": expert_sync.sync_named(_home(), body.name.strip())}


@router.get("/receipts/{name}")
def receipt(name: str) -> Dict[str, str]:
    """某个包最近一次安装记录的全文。"""
    text = catalog.receipt_text(_home(), name)
    if text is None:
        raise HTTPException(status_code=404, detail=f"没有装 {name}")
    return {"name": name, "text": text}


@router.get("/jobs/{job_id}")
def job(job_id: str) -> Dict[str, Any]:
    """后台任务的状态和日志尾巴。"""
    found: Optional[Dict[str, Any]] = jobs.status(_home(), job_id)
    if found is None:
        raise HTTPException(status_code=404, detail="没有这个任务")
    return found
