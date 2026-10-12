"""UniWork 公共技能目录与标准技能安装入口。"""

from typing import Optional
from urllib.parse import urljoin

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_cli.skill_market_install import (
    MarketSkillInstallError,
    install_market_skill,
    validate_package_url,
)

router = APIRouter()
MARKET_BASE = "https://maas.ai-yuanjing.com/app/gateway/wanwu"
RECOMMENDED_BASE = "https://maas.ai-yuanjing.com/app/gateway"


async def catalog_get(base: str, route: str, params: Optional[dict] = None):
    """读取固定公共目录，不向上游发送桌面凭据。"""
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.get(base + route, params=params)
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "技能目录服务暂时不可用，请重试") from exc
    if isinstance(payload, dict) and "code" in payload:
        if payload["code"] not in (0, "0", None):
            raise HTTPException(502, "技能目录服务返回失败，请重试")
        return payload.get("data")
    return payload


@router.get("/api/skills/market/categories")
async def market_categories():
    """返回技能市场分类。"""
    return await catalog_get(MARKET_BASE, "/api/skills/categories")


@router.get("/api/skills/market/list")
async def market_list(category: str = "all", page: int = 1, page_size: int = 100):
    """返回市场列表，限制分页大小。"""
    return await catalog_get(MARKET_BASE, "/api/skills/list", {
        "category": category, "page": max(1, page), "page_size": min(max(1, page_size), 100),
    })


@router.get("/api/skills/recommended/categories")
async def recommended_categories():
    """返回推荐目录分类。"""
    return await catalog_get(RECOMMENDED_BASE, "/uniwork/skill-categories")


@router.get("/api/skills/recommended/list")
async def recommended_list():
    """返回推荐技能列表。"""
    return await catalog_get(RECOMMENDED_BASE, "/uniwork/recommended-skills")


class SkillInstall(BaseModel):
    id: str
    name: Optional[str] = None
    download_url: str


@router.post("/api/skills/market/install")
async def install_skill(body: SkillInstall, profile: Optional[str] = None):
    """沿用标准隔离扫描安装链，不改变现有会话提示缓存。"""
    url = body.download_url.strip()
    if url.startswith("/uniwork/skills/"):
        url = urljoin(RECOMMENDED_BASE + "/", "uniwork/skills/" + url[len("/uniwork/skills/"):])
    try:
        url = validate_package_url(url)
    except MarketSkillInstallError as exc:
        raise HTTPException(400, str(exc)) from exc
    label = (body.name or body.id).strip()
    if not label:
        raise HTTPException(400, "技能名称不能为空")
    import asyncio
    try:
        return await asyncio.to_thread(install_market_skill, url, body.id, profile)
    except MarketSkillInstallError as exc:
        raise HTTPException(400, str(exc)) from exc
