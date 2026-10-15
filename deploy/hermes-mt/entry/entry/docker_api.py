"""Docker Engine API 的最小客户端（unix socket + aiohttp，不依赖 docker SDK）。

只有入口服务能碰 docker.sock。这里只封装租户生命周期需要的十来个调用，
每个都是薄包装，出错抛 ``DockerError`` 并带上 daemon 的原话。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import aiohttp

log = logging.getLogger("entry.docker")


class DockerError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"docker {status}: {message}")
        self.status = status
        self.message = message


class Docker:
    def __init__(self, sock_path: str):
        self._connector = aiohttp.UnixConnector(path=sock_path)
        self._http = aiohttp.ClientSession(connector=self._connector, base_url="http://docker")

    async def close(self) -> None:
        await self._http.close()

    async def _req(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: Any = None,
        data: bytes | None = None,
        headers: dict | None = None,
        ok: tuple[int, ...] = (200, 201, 204),
        timeout_s: float = 60,
    ) -> tuple[int, Any]:
        kwargs: dict[str, Any] = {"params": params, "headers": headers, "timeout": aiohttp.ClientTimeout(total=timeout_s)}
        if json_body is not None:
            kwargs["json"] = json_body
        if data is not None:
            kwargs["data"] = data
        async with self._http.request(method, path, **kwargs) as resp:
            text = await resp.text()
            body: Any
            try:
                body = json.loads(text) if text else None
            except json.JSONDecodeError:
                body = text
            if resp.status not in ok:
                message = body.get("message") if isinstance(body, dict) else str(body)[:300]
                raise DockerError(resp.status, message or "")
            return resp.status, body

    # ---- containers ----------------------------------------------------------
    async def inspect_container(self, name: str) -> dict | None:
        try:
            _, body = await self._req("GET", f"/containers/{name}/json")
            return body
        except DockerError as exc:
            if exc.status == 404:
                return None
            raise

    async def create_container(self, name: str, spec: dict) -> str:
        _, body = await self._req("POST", "/containers/create", params={"name": name}, json_body=spec)
        return body["Id"]

    async def start_container(self, name: str) -> None:
        await self._req("POST", f"/containers/{name}/start", ok=(204, 304))

    async def stop_container(self, name: str, timeout_s: int = 15) -> None:
        await self._req("POST", f"/containers/{name}/stop", params={"t": timeout_s}, ok=(204, 304), timeout_s=timeout_s + 30)

    async def remove_container(self, name: str) -> None:
        try:
            await self._req("DELETE", f"/containers/{name}", params={"force": "true", "v": "false"})
        except DockerError as exc:
            if exc.status != 404:
                raise

    async def get_archive(self, name: str, path: str) -> bytes | None:
        """把容器里的一个路径取成 tar；路径不存在返回 None。"""
        try:
            async with self._http.get(
                f"/containers/{name}/archive",
                params={"path": path},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status == 404:
                    return None
                if resp.status != 200:
                    raise DockerError(resp.status, (await resp.text())[:200])
                return await resp.read()
        except aiohttp.ClientError as exc:
            raise DockerError(0, f"{type(exc).__name__}: {exc}") from exc

    async def put_archive(self, name: str, path: str, tar_bytes: bytes) -> None:
        await self._req(
            "PUT",
            f"/containers/{name}/archive",
            params={"path": path},
            data=tar_bytes,
            headers={"Content-Type": "application/x-tar"},
        )

    async def list_containers(self, label: str, all_: bool = True) -> list[dict]:
        filters = json.dumps({"label": [label]})
        _, body = await self._req("GET", "/containers/json", params={"all": "true" if all_ else "false", "filters": filters})
        return body or []

    async def container_ip(self, name: str, network: str) -> str:
        info = await self.inspect_container(name)
        if not info:
            return ""
        nets = (info.get("NetworkSettings") or {}).get("Networks") or {}
        entry = nets.get(network) or {}
        return entry.get("IPAddress") or ""

    # ---- networks / volumes ---------------------------------------------------
    async def ensure_network(self, name: str, labels: dict) -> None:
        try:
            await self._req("GET", f"/networks/{name}")
            return
        except DockerError as exc:
            if exc.status != 404:
                raise
        await self._req(
            "POST",
            "/networks/create",
            json_body={"Name": name, "Driver": "bridge", "CheckDuplicate": True, "Labels": labels},
            ok=(201,),
        )

    async def connect_network(self, network: str, container: str) -> None:
        try:
            await self._req("POST", f"/networks/{network}/connect", json_body={"Container": container}, ok=(200,))
        except DockerError as exc:
            # 403 = already connected；忽略
            if exc.status not in (403,) and "already exists" not in exc.message:
                raise

    async def remove_network(self, name: str) -> None:
        try:
            await self._req("DELETE", f"/networks/{name}")
        except DockerError as exc:
            if exc.status != 404:
                raise

    async def ensure_volume(self, name: str, labels: dict) -> bool:
        """返回 True 表示这次新建（首次建卷要 seed），False 表示已存在。"""
        try:
            await self._req("GET", f"/volumes/{name}")
            return False
        except DockerError as exc:
            if exc.status != 404:
                raise
        await self._req("POST", "/volumes/create", json_body={"Name": name, "Labels": labels}, ok=(201,))
        return True
