"""前端报来的耗时（打开页面、新对话第一句、新建 bot、召唤专家），记进审计 ``client.timing``。

两个版本都有：前端是同一份（apps/desktop/src/lib/timing-mt.ts），各自记进自己入口的库。只收环节名、秒数和几项
短标签（模型名、是不是 bot 的会话这类），不收对话内容；每个用户每分钟最多收 ``PER_MINUTE`` 条，多的丢掉。
"""
from __future__ import annotations

import json
import math
import re
import time
from collections import deque

from aiohttp import web

KINDS = frozenset({"page.open", "chat.first_turn", "bot.create", "expert.summon"})
NAME = re.compile(r"[a-z][a-z0-9_]{0,31}")
MAX_BODY = 4096
MAX_STEPS = 12
MAX_LABELS = 8
MAX_LABEL_TEXT = 64
MAX_SECONDS = 3600.0
PER_MINUTE = 30


def _seconds(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return round(float(value), 2) if 0 <= value <= MAX_SECONDS else None


def _label(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) and abs(value) <= 1_000_000 else None
    if isinstance(value, str):
        text = "".join(ch for ch in value if ch.isprintable()).strip()
        return text[:MAX_LABEL_TEXT] if text else None
    return None


def clean(body) -> dict | None:
    """校验并整理一条耗时；不合规矩的整条不要（返回 None）。"""
    if not isinstance(body, dict) or body.get("kind") not in KINDS:
        return None
    seconds = _seconds(body.get("seconds"))
    steps = body.get("steps")
    if seconds is None or not isinstance(steps, dict) or len(steps) > MAX_STEPS:
        return None
    record: dict = {"kind": body["kind"], "seconds": seconds, "steps": {}}
    for name, value in steps.items():
        step = _seconds(value)
        if not isinstance(name, str) or not NAME.fullmatch(name) or step is None:
            return None
        record["steps"][name] = step
    labels = body.get("labels")
    if labels is not None:
        if not isinstance(labels, dict) or len(labels) > MAX_LABELS:
            return None
        kept = {}
        for name, value in labels.items():
            if isinstance(name, str) and NAME.fullmatch(name) and (label := _label(value)) is not None:
                kept[name] = label
        if kept:
            record["labels"] = kept
    return record


class TimingRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.recent: dict[str, deque[float]] = {}

    def _allow(self, user_id: str) -> bool:
        now = time.monotonic()
        seen = self.recent.setdefault(user_id, deque())
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        if len(self.recent) > 4096:  # 很久没报的用户不留着
            for key in [k for k, v in self.recent.items() if not v or now - v[-1] > 60]:
                self.recent.pop(key, None)
        return True

    async def handle(self, request: web.Request) -> web.Response:
        session = await self.entry._require(request)
        raw = await request.content.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            return web.json_response({"error": "too large"}, status=413)
        try:
            body = json.loads(raw)
        except ValueError:
            return web.json_response({"error": "invalid json"}, status=400)
        record = clean(body)
        if record is None:
            return web.json_response({"error": "invalid timing"}, status=400)
        if not self._allow(session.user_id):
            return web.json_response({"error": "too many"}, status=429)
        await self.entry.store.write_audit(session.user_id, "client.timing", record)
        return web.Response(status=204)
