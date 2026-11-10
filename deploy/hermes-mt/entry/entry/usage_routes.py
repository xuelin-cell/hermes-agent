"""企业版左下角的额度（企业用量、个人用量）：替浏览器拿成员的设备令牌去平台取（平台 39 号第 1 节）。

浏览器连不到平台，也不该拿到设备令牌，所以由入口转一道，只留界面用的字段。平台说这个成员没有席位、已停用、
企业停用（401 / 403）就回 ``available: false``，界面不显示；平台连不上回 ``available: false`` 和一句原因。
同一个用户 ``CACHE_S`` 秒内的重复请求用上一份（页面每轮对话后、每分钟各取一次，开几个标签页也只问一次平台）。
"""
from __future__ import annotations

import math
import time

from aiohttp import web

from .uniwork import UniworkError

CACHE_S = 15.0
NO_STORE = {"Cache-Control": "no-store"}
UNREACHABLE = "额度暂时读不到，稍后再试。"


def _number(value, default):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return value


def _level(item) -> dict | None:
    if not isinstance(item, dict) or not isinstance(item.get("label"), str):
        return None
    return {
        "level": str(item.get("level") or "")[:20],
        "label": item["label"][:40],
        "limit": _number(item.get("limit"), 0),
        "used": _number(item.get("used"), 0),
        "remaining": _number(item.get("remaining"), None),
        "percent": _number(item.get("percent"), None),
    }


def shape(data: dict) -> dict:
    """平台的回包只留界面要的字段（企业 → 部门 → 个人各级、最先用完的那一级、周期），别的不往浏览器送。"""
    levels = [level for item in (data.get("levels") or []) if (level := _level(item))]
    body: dict = {"available": True, "levels": levels, "binding": str(data.get("binding") or "")[:20],
                  "exceeded": bool(data.get("exceeded"))}
    for key in ("unit", "cycleStart", "cycleEnd", "endsAt"):
        if isinstance(data.get(key), str):
            body[key] = data[key][:40]
    return body


class UsageRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.cache: dict[str, tuple[float, dict]] = {}

    async def _fetch(self, user_id: str) -> dict:
        try:
            token = (await self.entry.store.get_tenant_context(user_id)).api_key
        except Exception:  # noqa: BLE001 —— 没有这个人的配置（没登录完）就当没有额度可显示
            return {"available": False}
        if not token:
            return {"available": False}
        try:
            data = await self.entry.uniwork.usage(token)
        except UniworkError as exc:
            # 401 / 403：没席位、已停用、企业停用，平台 39 号说这时不显示；其余是平台那边出了问题
            return {"available": False} if exc.status in (401, 403) else {"available": False, "error": UNREACHABLE}
        return shape(data)

    async def handle(self, request: web.Request) -> web.Response:
        if self.entry.uniwork is None:  # 个人版：套餐用量走 plan 那组接口
            raise web.HTTPNotFound()
        session = await self.entry._require(request)
        now = time.monotonic()
        hit = self.cache.get(session.user_id)
        if hit and now - hit[0] < CACHE_S:
            return web.json_response(hit[1], headers=NO_STORE)
        body = await self._fetch(session.user_id)
        if len(self.cache) > 2048:
            self.cache = {k: v for k, v in self.cache.items() if now - v[0] < CACHE_S}
        self.cache[session.user_id] = (now, body)
        return web.json_response(body, headers=NO_STORE)
