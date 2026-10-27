"""平台调用云端运行智能体的服务接口：``{入口}/__entry/service/v1``（见 docs/企业版对接/15、17）。

运行环境（runtime）在云端就是一个由平台直接给设备令牌的「用户」：``svc:<企业ID>:<runtimeKey>``。
卷、实例和成员一样隔离；拉策略、写模型配置、写人设、换令牌后重新加载都走成员那一套。
不同的只有两点：实例另开 gateway 的 API 服务（``/v1/runs`` 只在 gateway 里有），人设由平台下发。

鉴权：``Authorization: Bearer <MT_UNIWORK_SERVICE_SECRET>``，常量时间比较；没配密钥整组回 404。
另按 ``MT_UNIWORK_SERVICE_ALLOW`` 只放行平台的地址（取 nginx 写的 X-Real-IP，入口不对外暴露）。
出错回 ``{"error": "<中文说明>", "code": "<英文码>"}``：平台会把 error 原样显示给企业管理员。

事件流原样转发 hermes ``/v1/runs/{id}/events`` 的 SSE（保留 hermes 的 seq，平台靠它断线续传、去重），
只多两样：开头补一条 ``run.started``（hermes 不发，平台要靠它离开「正在准备」），没有数据时每 15 秒发一行注释保活。
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any

import aiohttp
from aiohttp import web

from .store import ServiceRuntime
from .tenants import Tenant
from .uniwork import ACCESS_MESSAGES, ACTIVE, UniworkError, access_status, plan_of

if TYPE_CHECKING:
    from .app import Entry

log = logging.getLogger("entry.service")

RUNTIME_KEY_RE = re.compile(r"^[a-z0-9:_-]{1,120}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")  # hermes 的 run_xxx；拼进实例里的路径，不许带 . 和 /
API = "/__mt/api"
PREPARE_TIMEOUT_S = 130.0  # 平台等 PUT 150 秒；留出余量，超时就先回 504，实例在后台接着起
API_READY_TIMEOUT_S = 90.0  # gateway 的 API 服务通常比网页后端晚几到十几秒
KEEPALIVE_S = 15.0
TOUCH_EVERY_S = 30.0  # 事件流期间多久记一次活动，免得长运行中途被空闲回收暂停
ACTIVE_RUN = {"queued", "started", "running", "stopping"}
TERMINAL_EVENTS = {"run.completed", "run.failed", "run.cancelled", "run.interrupted"}


def _err(status: int, message: str, code: str) -> web.Response:
    return web.json_response({"error": message, "code": code}, status=status)


def persona_of(policy: dict) -> str:
    """平台策略的 agentProfile 换成实例的 SOUL.md；没有就空串（实例用默认人设）。"""
    profile = policy.get("agentProfile") if isinstance(policy.get("agentProfile"), dict) else {}
    instructions = str(profile.get("instructions") or "").strip()
    if not instructions:
        return ""
    name = str(profile.get("name") or "").strip()
    return f"# {name}\n\n{instructions}\n" if name else f"{instructions}\n"


def _hermes_message(body: dict) -> str:
    error = body.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "")
    return str(error or body.get("raw") or "")


class ServiceApi:
    def __init__(self, entry: Entry) -> None:
        self.e = entry
        self._allow = [
            ipaddress.ip_network(item.strip(), strict=False)
            for item in entry.s.service_allow.split(",")
            if item.strip()
        ]

    # ---- 鉴权与定位 ----------------------------------------------------------------------

    def _authorize(self, request: web.Request) -> web.Response | None:
        secret = self.e.s.service_secret
        if not secret or self.e.uniwork is None:
            raise web.HTTPNotFound()
        if self._allow:
            peer = request.headers.get("X-Real-IP") or request.remote or ""
            try:
                address = ipaddress.ip_address(peer.strip())
            except ValueError:
                address = None
            if address is None or not any(address in net for net in self._allow):
                log.warning("service api: refused source %r", peer[:64])
                return _err(403, "来源地址不在允许范围内", "forbidden_source")
        given = request.headers.get("Authorization", "")
        given = given[7:] if given.startswith("Bearer ") else ""
        if not hmac.compare_digest(given.encode("utf-8"), secret.encode("utf-8")):
            return _err(401, "服务密钥缺失或不正确", "unauthorized")
        return None

    async def _runtime(self, request: web.Request) -> ServiceRuntime | web.Response:
        key = request.match_info["key"]
        tenant_id = request.query.get("tenantId", "").strip()
        found = await self.e.store.find_service_runtimes(key, tenant_id)
        if not found:
            return _err(404, "运行环境不存在，请先准备运行环境", "runtime_not_found")
        if len(found) > 1:
            return _err(400, "多个企业有同名的运行环境，请求要带 tenantId", "tenant_required")
        return found[0]

    def _instance(self, tenant: Tenant) -> tuple[str, dict[str, str]]:
        origin = tenant.origin or f"{tenant.ip}:{self.e.s.forward_port}"
        headers = {"Host": tenant.host_header or f"127.0.0.1:{self.e.s.hermes_port}", "X-MT-Token": tenant.token}
        if tenant.traffic_token:
            headers["cube-traffic-access-token"] = tenant.traffic_token
        return f"http://{origin}{API}", headers

    async def _call(self, tenant: Tenant, method: str, path: str, *, json_body: dict | None = None,
                    timeout_s: float = 30) -> tuple[int, dict]:
        """调实例里 gateway 的 API 服务（经转发器的 /__mt/api）。"""
        assert self.e.http is not None
        url, headers = self._instance(tenant)
        async with self.e.http.request(method, url + path, headers=headers, json=json_body,
                                       timeout=aiohttp.ClientTimeout(total=timeout_s)) as resp:
            try:
                body = await resp.json(content_type=None)
            except (ValueError, aiohttp.ContentTypeError):
                body = {"raw": (await resp.text())[:200]}
            return resp.status, body if isinstance(body, dict) else {"data": body}

    async def _tenant(self, rt: ServiceRuntime) -> Tenant:
        assert self.e.tenants is not None
        return await self.e.tenants.ensure_running(rt.user_id)

    async def _run_active(self, tenant: Tenant, rt: ServiceRuntime) -> bool:
        """记着的那次运行是不是还在跑；已经结束（或实例换代后查不到）就清掉记录。"""
        if not rt.current_run_id:
            return False
        try:
            status, body = await self._call(tenant, "GET", f"/v1/runs/{rt.current_run_id}")
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return True  # 问不到就当还在跑，宁可让平台稍后再试
        if status == 200 and str(body.get("status")) in ACTIVE_RUN:
            return True
        await self.e.store.end_service_run(rt.user_id, rt.current_run_id)
        return False

    # ---- 运行环境 --------------------------------------------------------------------------

    async def put_runtime(self, request: web.Request) -> web.StreamResponse:
        """准备运行环境：建或更新用户、按平台给的令牌拉策略写配置、拉起实例，必要时重新加载。"""
        if (denied := self._authorize(request)) is not None:
            return denied
        key = request.match_info["key"]
        if not RUNTIME_KEY_RE.fullmatch(key):
            return _err(400, "运行环境标识不合法（只能是小写字母、数字和 :_-）", "invalid_runtime_key")
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _err(400, "请求体不是合法的 JSON", "invalid_json")
        tenant_id = str(request.query.get("tenantId") or body.get("tenantId") or "").strip()
        device_token = str(body.get("deviceToken") or "").strip()
        if not tenant_id or not device_token:
            return _err(400, "缺少 tenantId 或 deviceToken", "missing_field")

        assert self.e.uniwork is not None
        try:
            policy = await self.e.uniwork.policy(device_token)
        except UniworkError as exc:
            if exc.status in (401, 403):
                return _err(400, f"平台给的设备令牌无效：{exc}", "device_token_invalid")
            return _err(502, f"向平台拉取运行环境的策略失败：{exc}", "policy_unavailable")
        reason = access_status(policy)
        if reason != ACTIVE:
            return _err(403, ACCESS_MESSAGES.get(reason, f"平台不允许这个运行环境运行（{reason}）"), "access_denied")
        plan = plan_of(policy, device_token)
        if plan is None:
            return _err(400, "平台策略里没有可用的模型", "no_model")

        user_id = f"svc:{tenant_id}:{key}"
        await self.e.store.upsert_service_runtime(
            user_id=user_id,
            tenant_id=tenant_id,
            tenant_code=str(body.get("tenantCode") or ""),
            runtime_key=key,
            kind=str(body.get("kind") or "agent")[:32],
            label=str(body.get("label") or "")[:200],
            device_token=device_token,
            endpoint=plan.endpoint(),
            catalog=plan.catalog(),
            limits=plan.limits(),
            persona=persona_of(policy),
        )
        task = asyncio.ensure_future(self._prepare(user_id, tenant_id, key))
        try:
            rt = await asyncio.wait_for(asyncio.shield(task), PREPARE_TIMEOUT_S)
        except asyncio.TimeoutError:
            return _err(504, "运行环境启动超时，实例还在后台准备，请稍后重试", "runtime_timeout")
        except Exception as exc:  # noqa: BLE001
            log.exception("service %s: prepare failed", key)
            reason = str(exc) if isinstance(exc, RuntimeError) and str(exc) else type(exc).__name__
            return _err(503, f"运行环境启动失败，请稍后重试（{reason}）", "runtime_start_failed")
        return web.json_response({
            "runtimeKey": key,
            "status": "ready",
            "instance": rt.sandbox_id or rt.user_id,
            "policyRevision": str(policy.get("revision") or ""),
            "createdAt": int(rt.created_at.timestamp()),
            "lastActiveAt": int(rt.last_active_at.timestamp()),
        })

    async def _prepare(self, user_id: str, tenant_id: str, key: str) -> ServiceRuntime:
        assert self.e.tenants is not None
        tenant = await self.e.tenants.ensure_running(user_id)
        rt = (await self.e.store.find_service_runtimes(key, tenant_id))[0]
        # 人设或模型变了就重新加载；有运行在跑就先不动，等它跑完下一次 PUT 再说
        if not rt.current_run_id and await self.e.tenants.apply_service_spec(user_id, rt.spec_sha256):
            tenant = await self.e.tenants.ensure_running(user_id)  # Docker 路径重启过容器，地址可能变了
        # 实例起来了不等于 gateway 的 API 服务起来了（它比网页后端晚几秒）：等到能用再回 ready
        await self._wait_api(tenant)
        return (await self.e.store.find_service_runtimes(key, tenant_id))[0]

    async def _wait_api(self, tenant: Tenant, timeout_s: float = API_READY_TIMEOUT_S) -> None:
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                status, _ = await self._call(tenant, "GET", "/health", timeout_s=10)
                if status == 200:
                    return
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("实例里的 API 服务没有在时限内就绪")
            await asyncio.sleep(1.0)

    async def list_runtimes(self, request: web.Request) -> web.StreamResponse:
        if (denied := self._authorize(request)) is not None:
            return denied
        tenant_id = request.query.get("tenantId", "").strip()
        if not tenant_id:
            return _err(400, "缺少 tenantId", "missing_field")
        status = {"running": "running", "starting": "starting", "stopped": "stopped"}
        template = self.e.s.cube_template if self.e.s.backend == "cube" else "docker"
        items = [{
            "runtimeKey": rt.runtime_key,
            "label": rt.label,
            "kind": rt.kind,
            "status": status.get(rt.state, "error" if rt.state else "stopped"),
            "instance": rt.sandbox_id,
            "createdAt": int(rt.created_at.timestamp()),
            "lastActiveAt": int(rt.last_active_at.timestamp()),
            "template": template,
            "image": self.e.s.image,
        } for rt in await self.e.store.list_service_runtimes(tenant_id)]
        return web.json_response({"items": items})

    async def restart_runtime(self, request: web.Request) -> web.StreamResponse:
        if (denied := self._authorize(request)) is not None:
            return denied
        rt = await self._runtime(request)
        if isinstance(rt, web.Response):
            return rt
        assert self.e.tenants is not None
        try:
            if await self._run_active(await self._tenant(rt), rt):
                return _err(409, "运行环境正忙，请等当前运行结束再重启", "runtime_busy")
            await self.e.tenants.restart_service(rt.user_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("service %s: restart failed", rt.runtime_key)
            return _err(503, f"重启运行环境失败，请稍后重试（{type(exc).__name__}）", "restart_failed")
        return web.json_response({"ok": True, "runtimeKey": rt.runtime_key, "status": "ready"})

    async def delete_runtime(self, request: web.Request) -> web.StreamResponse:
        if (denied := self._authorize(request)) is not None:
            return denied
        rt = await self._runtime(request)
        if isinstance(rt, web.Response):
            # 已经没有了：删除是幂等的
            return web.json_response({"ok": True, "deleted": False})
        assert self.e.tenants is not None
        try:
            await self.e.tenants.delete_service(rt.user_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("service %s: delete failed", rt.runtime_key)
            return _err(503, f"删除运行环境失败，请稍后重试（{type(exc).__name__}）", "delete_failed")
        return web.json_response({"ok": True, "deleted": True})

    # ---- 运行 ------------------------------------------------------------------------------

    async def start_run(self, request: web.Request) -> web.StreamResponse:
        if (denied := self._authorize(request)) is not None:
            return denied
        rt = await self._runtime(request)
        if isinstance(rt, web.Response):
            return rt
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _err(400, "请求体不是合法的 JSON", "invalid_json")
        if not body.get("input"):
            return _err(400, "缺少 input", "missing_field")
        forward = {k: body[k] for k in ("input", "session_id", "instructions", "model") if body.get(k)}
        try:
            tenant = await self._tenant(rt)
            if await self._run_active(tenant, rt):
                return _err(409, "运行环境正忙，请等当前运行结束", "runtime_busy")
            status, reply = await self._call(tenant, "POST", "/v1/runs", json_body=forward, timeout_s=60)
            if status == 503:
                # 实例刚被唤醒或重启过，API 服务还没起来：等它一会儿再发一次
                await self._wait_api(tenant, timeout_s=30)
                status, reply = await self._call(tenant, "POST", "/v1/runs", json_body=forward, timeout_s=60)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return _err(502, f"云端实例没有响应，请稍后重试（{type(exc).__name__}）", "instance_unreachable")
        except Exception as exc:  # noqa: BLE001
            log.exception("service %s: start run failed", rt.runtime_key)
            return _err(503, f"运行环境启动失败，请稍后重试（{type(exc).__name__}）", "runtime_start_failed")
        run_id = str(reply.get("run_id") or "")
        if status >= 300 or not run_id:
            message = _hermes_message(reply) or f"HTTP {status}"
            return _err(400 if status < 500 else 502, f"智能体没有接受这次运行：{message}", "run_rejected")
        await self.e.store.begin_service_run(rt.user_id, run_id)
        return web.json_response(
            {"run_id": run_id, "session_id": body.get("session_id") or "", "status": "queued"}, status=202)

    async def run_status(self, request: web.Request) -> web.StreamResponse:
        return await self._passthrough(request, "GET", "")

    async def stop_run(self, request: web.Request) -> web.StreamResponse:
        return await self._passthrough(request, "POST", "/stop")

    async def run_approval(self, request: web.Request) -> web.StreamResponse:
        return await self._passthrough(request, "POST", "/approval")

    async def _passthrough(self, request: web.Request, method: str, suffix: str) -> web.StreamResponse:
        if (denied := self._authorize(request)) is not None:
            return denied
        rt = await self._runtime(request)
        if isinstance(rt, web.Response):
            return rt
        run_id = request.match_info["run_id"]
        if not RUN_ID_RE.fullmatch(run_id):
            return _err(400, "运行标识不合法", "invalid_run_id")
        payload = None
        if method == "POST":
            try:
                payload = await request.json() if request.can_read_body else {}
            except (ValueError, json.JSONDecodeError):
                return _err(400, "请求体不是合法的 JSON", "invalid_json")
        try:
            status, body = await self._call(await self._tenant(rt), method, f"/v1/runs/{run_id}{suffix}",
                                            json_body=payload)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return _err(502, f"云端实例没有响应，请稍后重试（{type(exc).__name__}）", "instance_unreachable")
        if status >= 300:
            return _err(status if status < 500 else 502, _hermes_message(body) or f"HTTP {status}", "run_error")
        if suffix == "" and str(body.get("status")) not in ACTIVE_RUN:
            await self.e.store.end_service_run(rt.user_id, run_id)
        return web.json_response(body, status=status)

    async def run_events(self, request: web.Request) -> web.StreamResponse:
        if (denied := self._authorize(request)) is not None:
            return denied
        rt = await self._runtime(request)
        if isinstance(rt, web.Response):
            return rt
        run_id = request.match_info["run_id"]
        if not RUN_ID_RE.fullmatch(run_id):
            return _err(400, "运行标识不合法", "invalid_run_id")
        last_event_id = request.headers.get("Last-Event-ID", "").strip()
        try:
            tenant = await self._tenant(rt)
        except Exception as exc:  # noqa: BLE001
            return _err(503, f"运行环境启动失败，请稍后重试（{type(exc).__name__}）", "runtime_start_failed")
        assert self.e.http is not None
        url, headers = self._instance(tenant)
        headers["Accept"] = "text/event-stream"
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        try:
            upstream = await self.e.http.get(
                f"{url}/v1/runs/{run_id}/events", headers=headers,
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=None))
        except aiohttp.ClientError as exc:
            return _err(502, f"云端实例没有响应，请稍后重试（{type(exc).__name__}）", "instance_unreachable")
        try:
            if upstream.status != 200:
                try:
                    body = await upstream.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError):
                    body = {}
                body = body if isinstance(body, dict) else {}
                return _err(upstream.status if upstream.status < 500 else 502,
                            _hermes_message(body) or f"HTTP {upstream.status}", "run_error")
            out = web.StreamResponse(status=200, headers={
                "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
            await out.prepare(request)
            if not last_event_id:
                started = {"event": "run.started", "run_id": run_id, "timestamp": time.time()}
                await out.write(f"data: {json.dumps(started, ensure_ascii=False)}\n\n".encode("utf-8"))
            await self._relay(upstream, out, rt, run_id)
            return out
        finally:
            upstream.release()

    async def _relay(self, upstream: aiohttp.ClientResponse, out: web.StreamResponse,
                     rt: ServiceRuntime, run_id: str) -> None:
        """逐行转发，空闲时发注释保活；看到终止事件就清掉「正在跑」的记录。"""
        lines: asyncio.Queue[bytes | None] = asyncio.Queue()

        async def pump() -> None:
            try:
                async for line in upstream.content:
                    await lines.put(line)
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            finally:
                await lines.put(None)

        reader = asyncio.create_task(pump())
        touched = time.monotonic()
        finished = False
        try:
            while True:
                try:
                    line = await asyncio.wait_for(lines.get(), KEEPALIVE_S)
                except asyncio.TimeoutError:
                    await out.write(b": keepalive\n\n")
                    continue
                if line is None:
                    break
                await out.write(line)
                if line.startswith(b"data:"):
                    try:
                        event = json.loads(line[5:].strip() or b"{}")
                    except ValueError:
                        event = {}
                    if isinstance(event, dict) and event.get("event") in TERMINAL_EVENTS:
                        finished = True
                if time.monotonic() - touched > TOUCH_EVERY_S:
                    touched = time.monotonic()
                    await self._touch(rt)
        except (ConnectionResetError, asyncio.CancelledError):
            # 平台断开了：运行在实例里照常跑完，平台会带 Last-Event-ID 重连
            raise
        finally:
            reader.cancel()
            if finished:
                await self.e.store.end_service_run(rt.user_id, run_id)
            await self._touch(rt)

    async def _touch(self, rt: ServiceRuntime) -> None:
        try:
            await self.e.store.touch_tenant(rt.user_id)
            await self.e.store.touch_service_runtime(rt.user_id)
        except Exception as exc:  # noqa: BLE001 — 活动时间只是回收依据，不打断事件流
            log.warning("service %s: touch failed: %s", rt.runtime_key, type(exc).__name__)
