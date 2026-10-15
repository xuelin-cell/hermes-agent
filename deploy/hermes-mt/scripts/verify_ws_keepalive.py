#!/usr/bin/env python3
"""回归测试：只要 ws 还连着，容器就不能被空闲回收停掉。

为什么需要它：用户把页面开着不说话时，ws 是**完全静默**的——没有帧，也没有新的 HTTP
请求。入口如果按「最后一次活动多久以前」判闲置，就会把这个人的容器停掉，页面当场掉线；
一次长回复的流式输出（几十分钟只有零星帧）同样会被误伤。所以判活看的是「有没有连接」，
不是「多久没动静」。

本测试连上 ws 之后**一帧都不发**，静置到盖过两个回收周期，全程盯容器状态。
修复前（按帧/按时间判活）必挂，修复后必过。

跑法（入口需 MT_DEV_LOGIN=1，并把 MT_IDLE_MINUTES 临时调成 1）：
    python scripts/verify_ws_keepalive.py
    BASE=http://host:18081 HOLD_S=150 python scripts/verify_ws_keepalive.py
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time

import aiohttp

BASE = os.environ.get("BASE", "http://localhost:18081").rstrip("/")
USER = os.environ.get("WS_PROBE_USER", "wsprobe")
PREFIX = os.environ.get("MT_PREFIX", "hermes")
HOLD_S = int(os.environ.get("HOLD_S", "150"))  # 要盖过两个 60s 回收周期
SAMPLE_EVERY_S = 15


def container_state(name: str) -> str:
    out = subprocess.run(
        ["docker", "inspect", name, "--format", "{{.State.Status}}"],
        capture_output=True, text=True,
    )
    return (out.stdout or out.stderr).strip()


async def main() -> int:
    cname = f"{PREFIX}-t-{USER}"
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{BASE}/hermes/__entry/dev-login", json={"user": USER}) as resp:
            if resp.status != 200:
                print(f"FAIL  dev-login -> {resp.status}（入口是否开了 MT_DEV_LOGIN=1？）")
                return 1
        print(f"登录 {USER}，等容器就绪…")

        # 只用这一次 REST 把容器拉起来；之后全程不再发 REST。
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            try:
                async with http.get(
                    f"{BASE}/hermes/__hermes_backend/api/health",
                    timeout=aiohttp.ClientTimeout(total=90),
                ) as r:
                    if r.status == 200 and '"ok":true' in (await r.text()).replace(" ", ""):
                        break
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(3)
        else:
            print("FAIL  容器没能就绪")
            return 1
        print(f"容器就绪: {cname} -> {container_state(cname)}")

        async with http.ws_connect(f"{BASE}/hermes/api/ws", heartbeat=None, max_msg_size=64 * 1024 * 1024) as ws:
            first = await asyncio.wait_for(ws.receive(), timeout=30)
            if "gateway.ready" not in str(first.data):
                print(f"FAIL  首帧不是 gateway.ready: {str(first.data)[:200]}")
                return 1
            print(f"ws 已连接并收到 gateway.ready；接下来 {HOLD_S}s 内一帧都不发，也不发 REST")

            start = time.monotonic()
            while True:
                elapsed = time.monotonic() - start
                if elapsed >= HOLD_S:
                    break
                await asyncio.sleep(min(SAMPLE_EVERY_S, HOLD_S - elapsed))
                st = container_state(cname)
                print(f"  t+{int(time.monotonic() - start):3d}s  container={st}  (ws 静默)")
                if st != "running":
                    print(f"FAIL  静默 ws 期间容器被停掉了（state={st}）—— 空闲回收误杀")
                    return 1
                if ws.closed:
                    print(f"FAIL  ws 被断开了（close_code={ws.close_code}）")
                    return 1

            print(f"PASS  ws 静默挂 {HOLD_S}s（零帧、零 REST），容器全程 running、连接没断")

        # 断开后应重新开始计时：状态仍是 running，但已不在 live_ws 名单里
        await asyncio.sleep(2)
        async with http.get(f"{BASE}/hermes/__entry/health") as r:
            live = (await r.json()).get("live_ws", {})
        if USER in live:
            print(f"FAIL  ws 已断开但 live_ws 里还留着 {USER}: {live}")
            return 1
        print(f"PASS  ws 断开后 live_ws 已清干净（断开这一刻起重新计闲置）")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
