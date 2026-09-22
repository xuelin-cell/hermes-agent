"""CubeSandbox 控制面的最小客户端（HTTP + aiohttp，不依赖官方 SDK）。

和 ``docker_api.py`` 平级：那一份是「我们自己用 Docker 建容器」的后端，
这一份是「让沙箱平台替我们建实例」的后端。只封装租户生命周期要用的那些调用。

与 Docker 后端的三处根本差异，决定了这里的接口为什么长这样：

1. **没有「往未启动的实例里塞文件」这个能力。** Docker 那边是
   ``put_archive`` 到停着的容器再启动；这里只能等实例跑起来之后，
   经平台代理调容器内的引导接口（见 ``bootstrap``）。

2. **不建网络、不起名字。** 隔离由平台的 MicroVM 提供，实例标识由平台下发。
   我们只需要把「用户 → sandbox_id」存进自己的库。

3. **空闲回收是「暂停」不是「停容器」。** 而且暂停不会取消平台的空闲回收：
   建实例时必须显式把超时动作设成暂停、并允许请求自动唤醒，否则暂停的实例
   到点会连同可写层（对话库就在上面）一起被销毁，且不报任何错。
   这两项写死在 ``create_sandbox`` 里，不给调用方传错的机会。

存储分两处，原因见 docs/Hermes多租户-Cube架构说明.html §5：
对话库放实例可写层（能跑 SQLite，靠暂停保住），用户文件放持久卷（跨实例生命周期）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import aiohttp

log = logging.getLogger("entry.cube")

# 平台代理按 ``<容器端口>-<沙箱ID>.<域名>`` 解析路由。
_HOST_TMPL = "{port}-{sandbox_id}.{domain}"

# 交给平台的上游 Host 模板。``${PORT}`` 由平台替换成实际容器端口。
# hermes 只认回环形式的 Host，见架构说明 §4.1。
_MASK_REQUEST_HOST = "localhost:${PORT}"


class CubeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"cube {status}: {message}")
        self.status = status
        self.message = message


class Cube:
    """CubeAPI 客户端。

    ``api_base``  控制面地址，例如 ``http://10.0.0.5:3000``
    ``proxy_base`` 数据面地址（平台代理）。转发用户流量和调容器内引导接口都走它。
    ``domain``    平台的沙箱域名，用于拼 Host 头
    ``api_key``   控制面鉴权；集群没开鉴权时留空
    """

    def __init__(
        self,
        api_base: str,
        proxy_base: str,
        domain: str,
        api_key: str = "",
        template: str = "",
    ):
        self.api_base = api_base.rstrip("/")
        self.proxy_base = proxy_base.rstrip("/")
        self.domain = domain
        self.template = template
        headers = {"X-API-Key": api_key} if api_key else {}
        self._http = aiohttp.ClientSession(headers=headers)

    async def close(self) -> None:
        await self._http.close()

    # ---- 底层 ----------------------------------------------------------------

    async def _req(
        self,
        method: str,
        path: str,
        *,
        base: str | None = None,
        json_body: Any = None,
        data: bytes | None = None,
        headers: dict | None = None,
        ok: tuple[int, ...] = (200, 201, 204),
        timeout_s: float = 60,
    ) -> tuple[int, Any]:
        url = (base or self.api_base) + path
        kwargs: dict[str, Any] = {
            "headers": headers,
            "timeout": aiohttp.ClientTimeout(total=timeout_s),
        }
        if json_body is not None:
            kwargs["json"] = json_body
        if data is not None:
            kwargs["data"] = data
            kwargs.setdefault("headers", {})
        try:
            async with self._http.request(method, url, **kwargs) as resp:
                text = await resp.text()
                body: Any
                try:
                    body = json.loads(text) if text.strip() else None
                except json.JSONDecodeError:
                    body = text
                if resp.status not in ok:
                    message = ""
                    if isinstance(body, dict):
                        message = str(body.get("message") or body.get("detail") or body)
                    else:
                        message = str(body)[:300]
                    raise CubeError(resp.status, message)
                return resp.status, body
        except aiohttp.ClientError as exc:
            raise CubeError(0, f"{type(exc).__name__}: {exc}") from exc
        except asyncio.TimeoutError as exc:
            raise CubeError(0, f"请求超时（{timeout_s}s）") from exc

    def host_for(self, sandbox_id: str, port: int) -> str:
        """拼平台代理认的 Host 头。"""
        return _HOST_TMPL.format(port=port, sandbox_id=sandbox_id, domain=self.domain)

    # ---- 卷 ------------------------------------------------------------------
    #
    # 卷是独立对象，不随实例销毁。平台返回的 volumeID 与我们传的 name 相同，
    # 所以直接拿用户 ID 当卷名，不需要在库里额外存一份映射。

    async def list_volumes(self) -> list[dict]:
        _, body = await self._req("GET", "/volumes")
        return body or []

    async def ensure_volume(self, name: str, driver: str = "") -> bool:
        """卷不存在就建。返回 True 表示这次新建的（可据此判断是不是新用户）。"""
        for vol in await self.list_volumes():
            if vol.get("name") == name or vol.get("volumeID") == name:
                return False
        payload: dict[str, Any] = {"name": name}
        if driver:
            payload["driver"] = driver
        try:
            await self._req("POST", "/volumes", json_body=payload)
        except CubeError as exc:
            # 并发建同名卷时后到的那个会冲突，此时当作已存在。
            if exc.status == 409:
                return False
            raise
        return True

    async def remove_volume(self, name: str) -> None:
        """删卷会清空后端数据，不可恢复。只在真的要注销用户时调。"""
        try:
            await self._req("DELETE", f"/volumes/{name}", timeout_s=120)
        except CubeError as exc:
            if exc.status != 404:
                raise

    # ---- 沙箱 ----------------------------------------------------------------

    async def create_sandbox(
        self,
        *,
        volume_name: str,
        workspace_path: str,
        metadata: dict | None = None,
        template: str = "",
        allow_internet: bool = True,
    ) -> str:
        """建一个实例，返回平台下发的 sandbox_id。

        生命周期那两项是写死的，不给调用方传错的机会：
        ``timeout=-1`` 永不超时、``onTimeout=pause`` 超时改成暂停而非销毁。
        少任何一项，暂停的实例都会被平台连同可写层一起回收 —— 对话库就在可写层上，
        而且这个过程不报错，表现为用户的历史无声无息消失。
        """
        payload: dict[str, Any] = {
            "templateID": template or self.template,
            "timeout": -1,
            "lifecycle": {"onTimeout": "pause", "autoResume": True},
            "network": {
                "maskRequestHost": _MASK_REQUEST_HOST,
                "allowInternetAccess": allow_internet,
            },
            "volumeMounts": [
                {"name": volume_name, "path": workspace_path, "readOnly": False}
            ],
        }
        if metadata:
            payload["metadata"] = metadata
        _, body = await self._req("POST", "/sandboxes", json_body=payload, timeout_s=180)
        sandbox_id = (body or {}).get("sandboxID")
        if not sandbox_id:
            raise CubeError(0, f"创建实例的响应里没有 sandboxID: {str(body)[:200]}")
        return sandbox_id

    async def list_sandboxes(self) -> list[dict]:
        _, body = await self._req("GET", "/sandboxes")
        return body or []

    async def get_sandbox(self, sandbox_id: str) -> dict | None:
        for sb in await self.list_sandboxes():
            if sb.get("sandboxID") == sandbox_id:
                return sb
        return None

    async def sandbox_state(self, sandbox_id: str) -> str:
        """``running`` / ``paused`` / ``gone``（已不存在）。"""
        sb = await self.get_sandbox(sandbox_id)
        return "gone" if sb is None else str(sb.get("state") or "unknown")

    async def pause_sandbox(self, sandbox_id: str) -> None:
        try:
            await self._req("POST", f"/sandboxes/{sandbox_id}/pause", json_body={}, timeout_s=180)
        except CubeError as exc:
            if exc.status != 404:
                raise

    async def resume_sandbox(self, sandbox_id: str) -> None:
        """显式恢复。

        平常不需要调 —— 建实例时开了自动唤醒，请求打到代理会自己把实例叫醒。
        这个方法留给「想在用户请求到达前先预热」的场景。
        """
        await self._req("POST", f"/sandboxes/{sandbox_id}/resume", json_body={}, timeout_s=180)

    async def remove_sandbox(self, sandbox_id: str) -> None:
        """销毁实例。

        ★ 不可逆，而且会连同可写层一起删掉 —— 对话库就在上面。
        空闲回收请用 ``pause_sandbox``，只有注销用户时才该调这个。
        """
        try:
            await self._req("DELETE", f"/sandboxes/{sandbox_id}", timeout_s=180)
        except CubeError as exc:
            if exc.status != 404:
                raise

    # ---- 容器内的引导与探活 ----------------------------------------------------

    async def _tenant_req(
        self,
        method: str,
        sandbox_id: str,
        port: int,
        path: str,
        *,
        json_body: Any = None,
        timeout_s: float = 30,
        ok: tuple[int, ...] = (200,),
    ) -> tuple[int, Any]:
        return await self._req(
            method,
            path,
            base=self.proxy_base,
            headers={"Host": self.host_for(sandbox_id, port)},
            json_body=json_body,
            timeout_s=timeout_s,
            ok=ok,
        )

    async def wait_forwarder(self, sandbox_id: str, port: int, timeout_s: float = 120) -> None:
        """等容器里的转发进程能应答。

        它不依赖任何用户数据，实测秒级就绪；等不到通常意味着实例根本没起来。
        """
        deadline = time.monotonic() + timeout_s
        last = ""
        while time.monotonic() < deadline:
            try:
                await self._tenant_req("GET", sandbox_id, port, "/__mt/health", timeout_s=8)
                return
            except CubeError as exc:
                last = exc.message or str(exc.status)
            await asyncio.sleep(0.5)
        raise CubeError(0, f"转发进程 {timeout_s}s 内没就绪：{last}")

    async def status(self, sandbox_id: str, port: int) -> dict:
        """问容器：hermes 起了没、引导过没、引导窗口还剩多久。"""
        _, body = await self._tenant_req("GET", sandbox_id, port, "/__mt/status", timeout_s=15)
        return body if isinstance(body, dict) else {}

    async def bootstrap(
        self,
        sandbox_id: str,
        port: int,
        *,
        token: str,
        files: list[dict],
        ready_timeout_s: int = 240,
    ) -> dict:
        """把会话令牌和种子文件送进容器，并让它把 hermes 拉起来。

        这是绕开平台时序限制的那条通道：平台下发创建时环境变量是在容器进程
        已经起来之后，而 hermes 缺了令牌会直接退出、导致实例根本建不起来。
        详见架构说明 §4.2。

        ``files`` 每项 ``{"path", "content", "overwrite"}``；``overwrite`` 取
        ``True`` / ``False`` / ``"if-pristine"`` 三者之一，语义见 seed/forward.py。
        用户配置该用 ``"if-pristine"``：既能盖掉镜像首启种下的默认示例，
        又不会动用户或 hermes 自己写过的内容。

        只认第一次。实例已经引导过时平台返回 409，这里当作成功 —— 调用方重试
        或多个请求撞上时不该因此失败。
        """
        try:
            _, body = await self._tenant_req(
                "POST",
                sandbox_id,
                port,
                "/__mt/bootstrap",
                json_body={"token": token, "files": files, "ready_timeout_s": ready_timeout_s},
                timeout_s=ready_timeout_s + 30,
            )
            return body if isinstance(body, dict) else {}
        except CubeError as exc:
            if exc.status == 409:
                log.info("sandbox %s 已经引导过，跳过", sandbox_id[:12])
                return {"ok": True, "already": True}
            raise

    async def wait_hermes(self, sandbox_id: str, port: int, timeout_s: float = 240) -> None:
        """等 hermes 真的能应答业务请求。

        注意 Host 头由平台按 ``maskRequestHost`` 改写成回环形式，所以这里
        照常用平台的路由 Host 即可，不需要我们自己伪造回环 Host。
        """
        deadline = time.monotonic() + timeout_s
        last = ""
        while time.monotonic() < deadline:
            try:
                st, body = await self._tenant_req(
                    "GET", sandbox_id, port, "/api/health", timeout_s=8, ok=(200,)
                )
                if isinstance(body, dict) and body.get("ok"):
                    return
                last = str(body)[:120]
            except CubeError as exc:
                last = exc.message or str(exc.status)
            await asyncio.sleep(1.0)
        raise CubeError(0, f"hermes {timeout_s}s 内没就绪：{last}")

    # ---- 空闲回收 --------------------------------------------------------------

    async def sweep_idle(
        self,
        active: dict[str, float],
        idle_seconds: float,
        metadata_key: str = "",
        metadata_value: str = "",
    ) -> list[str]:
        """把闲置超过阈值的实例暂停掉（不是销毁）。返回被暂停的 sandbox_id。

        ``active`` 是 ``{sandbox_id: 最后活跃的单调时间}``，由入口自己维护。
        表里没有的实例不动 —— 可能是别的入口实例在管，也可能是刚建还没记上。
        """
        now = time.monotonic()
        paused: list[str] = []
        for sb in await self.list_sandboxes():
            sid = sb.get("sandboxID")
            if not sid or sb.get("state") == "paused":
                continue
            if metadata_key and (sb.get("metadata") or {}).get(metadata_key) != metadata_value:
                continue
            last = active.get(sid)
            if last is None or now - last < idle_seconds:
                continue
            try:
                await self.pause_sandbox(sid)
                paused.append(sid)
                log.info("sandbox %s 闲置 %.0fs，已暂停", sid[:12], now - last)
            except CubeError as exc:
                log.warning("暂停 sandbox %s 失败: %s", sid[:12], exc)
        return paused
