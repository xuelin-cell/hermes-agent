"""A connector serving many 5G agents shares one registration/handshake budget (cloud channels).

Real HTTP registration and WebSocket handshakes against a local gateway; no mocked transport.
"""
import asyncio
import importlib

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

stream = importlib.import_module("apps.desktop.assets.uniagentgate-plugin.stream")


@pytest.mark.asyncio
async def test_many_agents_never_register_or_handshake_beyond_the_shared_budget():
    """UniClaw caps registrations plus handshakes at 10 per process so a restart or gateway blip
    never reconnects thousands of agents at once. A served connection frees its slot, so every
    agent still connects even when the budget is smaller than the number of agents."""
    load = {"now": 0, "peak": 0}
    connected = set()

    def enter():
        load["now"] += 1
        load["peak"] = max(load["peak"], load["now"])

    async def register(request):
        enter()
        try:
            await asyncio.sleep(0.05)
            agent = request.headers["X-Agent-Id"]
            return web.json_response({"agent_id": agent, "session_token": f"session-{agent}", "ttl_sec": 600})
        finally:
            load["now"] -= 1

    async def connect(request):
        agent = request.headers["X-Agent-Id"]
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        enter()
        try:
            await asyncio.sleep(0.05)
            await ws.send_json({"type": "connection.accepted", "connection_id": f"connection-{agent}",
                                "agent_id": agent, "payload": {"heartbeat_interval_sec": 60}})
        finally:
            load["now"] -= 1
        connected.add(agent)
        async for _ in ws:
            pass
        return ws

    gateway = web.Application()
    gateway.router.add_post("/v1/agent-runtimes/register", register)
    gateway.router.add_get("/v1/agent-runtimes/connect", connect)
    budget = asyncio.Semaphore(2)

    async def on_message(raw, context):
        pass

    clients = []
    async with TestServer(gateway) as server:
        url = str(server.make_url("")).rstrip("/")
        clients = [stream.UniAgentGateStreamClient(url, f"agent-{index}", "secret", on_message, admission=budget)
                   for index in range(6)]
        try:
            await asyncio.gather(*(client.start() for client in clients))
            await asyncio.wait_for(asyncio.gather(*(client.ready.wait() for client in clients)), 10)
            assert connected == {f"agent-{index}" for index in range(6)}
            assert load["peak"] <= 2
        finally:
            await asyncio.gather(*(client.stop() for client in clients))
