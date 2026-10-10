"""Authenticated UniWork personal-drive proxy.

The cloud access token never crosses into the renderer.  The renderer provides
its UniWork login JWT and phone; this module exchanges and caches the provider
token in process memory, then forwards only allow-listed drive operations.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_constants import get_hermes_home

router = APIRouter(prefix="/api/uniwork/drive", tags=["uniwork-drive"])

_DRIVE_BASE = "https://maas.ai-yuanjing.com/app/uniwork/general_uniclaw/clouddrive/v1"
_AUTH_URL = "https://www.yjworker.10010.com/app/gateway/uniwork-yunpan/access-token"
_PREVIEW_MAX_BYTES = 20 * 1024 * 1024
_PREVIEW_EXTENSIONS = re.compile(
    r"\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|md|mdx|markdown|html?|json|xml|png|jpe?g|gif|webp|bmp|svg|tiff?)$",
    re.IGNORECASE,
)
_token_cache: dict[str, tuple[str, float]] = {}
_token_locks: dict[str, asyncio.Lock] = {}


class DriveRequest(BaseModel):
    login: str
    phone: str
    route: str
    method: Literal["GET", "POST", "PATCH"] = "GET"
    body: dict[str, Any] | None = None


class DrivePreviewRequest(BaseModel):
    login: str
    phone: str
    asset_id: str
    fid: str | None = None
    name: str
    size_bytes: int | None = None


_ROUTES: dict[str, frozenset[str]] = {
    "/asset-spaces": frozenset({"GET"}),
    "/drive/capabilities": frozenset({"GET"}),
    "/folders": frozenset({"POST"}),
    "/assets/move": frozenset({"POST"}),
    "/assets/trash": frozenset({"POST"}),
    "/assets/download": frozenset({"POST"}),
    "/unicom/FileDetails": frozenset({"POST"}),
}


def _allowed(route: str, method: str) -> bool:
    path = route.split("?", 1)[0]
    if path == "/assets" and method == "GET":
        return True
    if path.startswith("/asset-spaces/") and path.endswith("/usage") and method == "GET":
        return True
    if path.startswith("/assets/") and method == "PATCH" and path.count("/") == 2:
        return True
    return method in _ROUTES.get(path, frozenset())


def _cache_key(phone: str, login: str) -> str:
    """Keep drive credentials scoped to the exact UniWork login session."""
    digest = hashlib.sha256(login.encode("utf-8")).hexdigest()
    return f"{phone}:{digest}"


async def _access_token(phone: str, login: str, *, force: bool = False) -> str:
    key = _cache_key(phone, login)
    lock = _token_locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _token_cache.get(key)
        if not force and cached and cached[1] > time.time():
            return cached[0]
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(_AUTH_URL, json={"phone": phone, "appVersion": "0.17.0"})
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(status_code=502, detail="个人云盘认证服务暂时不可用") from exc
        token = payload.get("result", {}).get("accessToken") if isinstance(payload, dict) else None
        if not response.is_success or not isinstance(token, str) or not token.strip():
            raise HTTPException(status_code=401, detail="个人云盘认证失败，请重新登录")
        _token_cache[key] = (token, time.time() + 7 * 24 * 60 * 60)
        return token


def _credential_rejected(response: httpx.Response, payload: Any) -> bool:
    """Match the expiry signals used by the UniWork cloud-drive service."""
    if not isinstance(payload, dict):
        return False
    error = payload.get("error")
    if not isinstance(error, dict):
        return False
    return error.get("code") == "DRIVE_AUTH_EXPIRED" or str(error.get("provider_code") or "") == "9999"


async def _upstream_request(request: DriveRequest, login: str, token: str) -> tuple[httpx.Response, Any]:
    headers = {"Authorization": f"Bearer {login}", "X-Drive-Access-Token": token}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.request(
                request.method,
                f"{_DRIVE_BASE}{request.route}",
                headers=headers,
                json=request.body if request.method != "GET" else None,
            )
        return response, response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="个人云盘服务暂时不可用") from exc


def _preview_filename(name: str) -> str:
    filename = Path(name.replace("\\", "/")).name.strip()
    if not filename or filename in {".", ".."} or not _PREVIEW_EXTENSIONS.search(filename):
        raise HTTPException(status_code=415, detail="此文件类型暂不支持预览")
    return re.sub(r"[^\w.()\-\u4e00-\u9fff]+", "_", filename, flags=re.UNICODE)[:180]


async def _download_preview_bytes(url: str, headers: dict[str, str]) -> bytes:
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="个人云盘文件下载失败") from exc
    if not response.is_success:
        raise HTTPException(status_code=response.status_code or 502, detail="个人云盘文件下载失败")
    content = response.content
    if len(content) > _PREVIEW_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 20 MB，无法在线预览")
    return content


@router.post("/request")
async def drive_request(request: DriveRequest) -> dict:
    login = request.login.strip()
    phone = request.phone.strip()
    if not login or not phone or "*" in phone:
        raise HTTPException(status_code=401, detail="UniWork 登录信息不完整")
    if not request.route.startswith("/") or not _allowed(request.route, request.method):
        raise HTTPException(status_code=403, detail="不允许的云盘操作")

    cache_key = _cache_key(phone, login)
    access_token = await _access_token(phone, login)
    response, payload = await _upstream_request(request, login, access_token)

    # Cloud tokens can be rejected before their documented seven-day expiry.
    # Refresh and replay reads exactly once; writes are never replayed because
    # the first attempt may already have taken effect upstream.
    if _credential_rejected(response, payload):
        _token_cache.pop(cache_key, None)
        refreshed = await _access_token(phone, login, force=True)
        if request.method == "GET":
            response, payload = await _upstream_request(request, login, refreshed)

    if response.status_code == 401:
        _token_cache.pop(cache_key, None)
    if not response.is_success or not isinstance(payload, dict) or payload.get("ok") is not True:
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        detail = error.get("message") if isinstance(error, dict) else None
        raise HTTPException(status_code=response.status_code or 502, detail=detail or "个人云盘请求失败")
    return payload


@router.post("/preview")
async def materialize_drive_preview(request: DrivePreviewRequest) -> dict:
    """Download one cloud file into a bounded, backend-local preview cache."""
    login = request.login.strip()
    phone = request.phone.strip()
    asset_id = request.asset_id.strip()
    filename = _preview_filename(request.name)
    if not login or not phone or "*" in phone or not asset_id:
        raise HTTPException(status_code=401, detail="UniWork 登录信息不完整")
    if request.size_bytes is not None and request.size_bytes > _PREVIEW_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 20 MB，无法在线预览")

    fid = (request.fid or "").strip()
    if not fid:
        details = await drive_request(
            DriveRequest(
                login=login,
                phone=phone,
                route="/unicom/FileDetails",
                method="POST",
                body={"fileId": asset_id},
            )
        )
        data = details.get("data", {})
        fid = str(data.get("fid") or "").strip() if isinstance(data, dict) else ""
    if not fid:
        raise HTTPException(status_code=502, detail="个人云盘未返回文件标识")

    plan = await drive_request(
        DriveRequest(
            login=login,
            phone=phone,
            route="/assets/download",
            method="POST",
            body={"fid": fid},
        )
    )
    data = plan.get("data", {})
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="个人云盘下载响应无效")

    token = await _access_token(phone, login)
    headers = {"Authorization": f"Bearer {login}", "X-Drive-Access-Token": token}
    download_path = data.get("download_path")
    download_url = data.get("download_url")
    if isinstance(download_path, str) and download_path.startswith("/drive/content?"):
        url = urljoin(f"{_DRIVE_BASE}/", download_path.lstrip("/"))
    elif isinstance(download_url, str) and urlparse(download_url).scheme in {"http", "https"}:
        url = download_url
        # Signed CDN URLs authenticate themselves; never forward account
        # credentials away from the configured drive service origin.
        if urlparse(url).netloc != urlparse(_DRIVE_BASE).netloc:
            headers = {}
    else:
        raise HTTPException(status_code=502, detail="个人云盘未返回可用的下载地址")

    content = await _download_preview_bytes(url, headers)
    preview_dir = get_hermes_home() / "cache" / "drive-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    target = preview_dir / f"{uuid.uuid4().hex}-{filename}"
    target.write_bytes(content)
    return {"ok": True, "path": str(target), "name": request.name, "size_bytes": len(content)}
