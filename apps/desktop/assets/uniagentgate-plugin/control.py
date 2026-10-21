"""账号内的 5G 重连控制；仅监听 loopback，不向 Renderer 暴露地址或凭证。"""

import atexit
import asyncio
import hmac
import json
import os
from pathlib import Path
import secrets


class ReconnectControl:
    def __init__(self, home):
        self.home = Path(home)
        self.file = self.home / "uniagentgate-control.json"
        self.token = secrets.token_hex(32)
        self.server = None
        self.adapter = None
        self.busy = False
        self.loop = None
        self._binding_task = None
        self._binding_revision = 0

    async def start(self, adapter):
        """保留主网关里的适配器引用，初始失败后仍允许原进程恢复该平台。"""
        if not getattr(adapter, "gateway_runner", None) or adapter._owner_profile:
            return
        self.adapter = adapter
        if self.server:
            return
        self.loop = asyncio.get_running_loop()
        self.server = await asyncio.start_server(self._request, "127.0.0.1", 0, limit=4096)
        port = self.server.sockets[0].getsockname()[1]
        temporary = self.file.with_suffix(f".{self.token[:12]}.tmp")
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump({"port": port, "token": self.token, "pid": os.getpid()}, stream)
        temporary.replace(self.file)
        atexit.register(self.close)

    def close(self):
        """只清理本实例的凭证，避免旧插件卸载删除新实例记录。"""
        if self._binding_task and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._binding_task.cancel)
        if self.server:
            if not self.loop.is_closed():
                self.loop.call_soon_threadsafe(self.server.close)
            self.server = None
        try:
            if json.loads(self.file.read_text(encoding="utf-8")).get("token") == self.token:
                self.file.unlink()
        except (OSError, ValueError):
            return

    async def _request(self, reader, writer):
        """固定操作及限长请求；无凭证的网页/其它账号不能触发重连。"""
        try:
            request = json.loads(await asyncio.wait_for(reader.readline(), 3))
            if not isinstance(request, dict) or not isinstance(request.get("token"), str):
                result = {"status": "unauthorized"}
            elif not hmac.compare_digest(request["token"], self.token):
                result = {"status": "unauthorized"}
            elif request.get("operation") not in {"reconnect", "apply_binding"}:
                result = {"status": "invalid"}
            else:
                from gateway.run import _profile_runtime_scope
                with _profile_runtime_scope(self.home):
                    result = await (self.apply_binding() if request["operation"] == "apply_binding"
                                    else self.reconnect())
            writer.write(json.dumps(result).encode() + b"\n")
            await writer.drain()
        except (ValueError, OSError, asyncio.TimeoutError):
            pass  # 失败或断开的控制请求只关闭连接，客户端不会自动重放不确定操作。
        finally:
            writer.close()
            await writer.wait_closed()

    async def reconnect(self):
        """只替换该平台的连接；忙碌时保留当前轮次，其它通道完全沿用原对象。"""
        adapter = self.adapter
        runner = adapter.gateway_runner
        if self.busy or self._binding_task and not self._binding_task.done() or getattr(adapter, "_connecting", False):
            return {"status": "connecting"}
        if not runner._running or getattr(runner, "_shutdown_event", None) and runner._shutdown_event.is_set():
            return {"status": "stopped"}
        if adapter._active_sessions or adapter._client and adapter._client._dispatch_tasks:
            return {"status": "busy"}
        client = adapter._client
        if client and client.is_alive and client.health.state in {"starting", "running", "degraded"}:
            # 与旧版一致：已在线或协议自身正在恢复时，人工点击不重复注册或抢占连接。
            return {"status": "connected" if client.health.state == "running" else "connecting"}
        self.busy = True
        try:
            from gateway.config import load_gateway_config
            config = load_gateway_config().platforms.get(adapter.platform)
            if not config or not config.enabled:
                return {"status": "unbound"}
            # 移除待重试条目后再 await，避免 watcher 同时建立第二条连接。
            runner._failed_platforms.pop(adapter.platform, None)
            await adapter.disconnect()
            adapter.config = config
            connected = await adapter.connect(is_reconnect=True)
            runner._publish_primary_adapter(adapter.platform, adapter)
            runner.delivery_router.adapters = runner.adapters
            return {"status": "connected" if connected else "failed"}
        finally:
            self.busy = False

    def _has_work(self):
        adapter = self.adapter
        return bool(adapter._active_sessions or adapter._pending_messages
                    or adapter._text_debounce_store()
                    or adapter._client and adapter._client._dispatch_tasks)

    async def apply_binding(self):
        """同一进程应用落盘绑定；旧轮次发完回复后才替换其连接。"""
        self._binding_revision += 1
        if self._binding_task and not self._binding_task.done():
            return {"status": "connecting"}  # worker 始终读取最新落盘配置。
        if self.busy or getattr(self.adapter, "_connecting", False) or self._has_work():
            self._binding_task = asyncio.create_task(self._apply_when_idle(), name="uniagentgate-binding")
            return {"status": "connecting"}
        return await self._apply_binding_now()

    async def _apply_when_idle(self):
        try:
            while self.adapter.gateway_runner._running:
                if not self.busy and not getattr(self.adapter, "_connecting", False) and not self._has_work():
                    # 排队期间可能收到下一次凭据变化，不能沿用创建任务时的 secret scope。
                    from gateway.run import _profile_runtime_scope
                    revision = self._binding_revision
                    with _profile_runtime_scope(self.home):
                        await self._apply_binding_now()
                    if revision == self._binding_revision:
                        return
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            raise
        except Exception:
            import logging
            logging.getLogger(__name__).error("uniAgentGate binding update failed; credentials omitted")

    async def _apply_binding_now(self):
        from gateway.config import load_gateway_config
        from gateway.platforms._shared import get_scoped_secret

        adapter = self.adapter
        runner = adapter.gateway_runner
        if not runner._running or runner._shutdown_event and runner._shutdown_event.is_set():
            return {"status": "stopped"}
        config = load_gateway_config().platforms.get(adapter.platform)
        client = adapter._client
        if config and config.enabled and client:
            extra = config.extra or {}
            from .adapter import gateway_url
            target = (gateway_url(extra.get("gateway_url", "")), extra.get("agent_id"),
                      get_scoped_secret("UNIAGENTGATE_AGENT_SK", ""))
            if target == (client._gateway_url, client._agent_id, client._agent_sk):
                return {"status": "connected" if client.health.state == "running" else "connecting"}
        self.busy = True
        try:
            runner._failed_platforms.pop(adapter.platform, None)
            await adapter.disconnect()
            if config:
                adapter.config = config
                runner.config.platforms[adapter.platform] = config
            if not config or not config.enabled:
                return {"status": "unbound"}
            connected = await adapter.connect(is_reconnect=True)
            runner._publish_primary_adapter(adapter.platform, adapter)
            runner.delivery_router.adapters = runner.adapters
            return {"status": "connected" if connected else "failed"}
        finally:
            self.busy = False
