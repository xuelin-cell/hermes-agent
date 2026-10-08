"""Cube 客户端：数据面每一种调用都要带路由 Host 和（登记过的）流量令牌；控制面调用不带令牌。

用一个假的 aiohttp 会话记录每次请求的 URL 和请求头，不碰网络。
"""

from __future__ import annotations

import json

import pytest

from entry.cube_api import TRAFFIC_TOKEN_HEADER, Cube, CubeError


class _Resp:
    def __init__(self, status: int, body):
        self.status = status
        self._body = body

    async def text(self):
        return json.dumps(self._body) if not isinstance(self._body, str) else self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeHttp:
    def __init__(self):
        self.calls: list[tuple[str, str, dict]] = []
        self.responses: dict[str, tuple[int, object]] = {}

    def request(self, method, url, **kwargs):
        headers = dict(kwargs.get("headers") or {})
        self.calls.append((method, url, headers))
        status, body = self.responses.get(url.split("?")[0].rsplit("/", 1)[-1], (200, {"ok": True}))
        return _Resp(status, body)

    async def close(self):
        pass


def _cube() -> tuple[Cube, _FakeHttp]:
    cube = Cube(api_base="http://api:3000", proxy_base="http://proxy", domain="cube.app", template="tpl-x")
    fake = _FakeHttp()
    cube._http = fake  # type: ignore[assignment]
    return cube, fake


@pytest.mark.asyncio
async def test_every_data_plane_call_carries_host_and_token() -> None:
    cube, http = _cube()
    cube.register_traffic_token("sb1", "tok-1")
    http.responses["status"] = (200, {"bootstrapped": True})
    http.responses["sync"] = (200, {"archive": {"archive": "a.tar.gz"}})
    http.responses["drain"] = (200, {"archive": {"archive": "f.tar.gz"}})
    http.responses["bootstrap"] = (200, {"ok": True, "state": {}})
    http.responses["health"] = (200, {"ok": True})

    await cube.wait_forwarder("sb1", 9121, timeout_s=5)
    await cube.status("sb1", 9121)
    await cube.bootstrap("sb1", 9121, token="t", files=[], state=None)
    await cube.sync_state("sb1", 9121, "t")
    await cube.drain("sb1", 9121, "t")
    await cube.wait_hermes("sb1", 9121, timeout_s=5)

    paths = [c[1].split("http://proxy")[-1] for c in http.calls]
    assert paths == ["/__mt/health", "/__mt/status", "/__mt/bootstrap", "/__mt/sync", "/__mt/drain", "/api/health"]
    for method, url, headers in http.calls:
        assert headers["Host"] == "9121-sb1.cube.app", url
        assert headers[TRAFFIC_TOKEN_HEADER] == "tok-1", url
    # sync / drain 还要带状态管家的令牌
    assert http.calls[3][2]["X-MT-Token"] == "t" and http.calls[4][2]["X-MT-Token"] == "t"


@pytest.mark.asyncio
async def test_public_instance_has_no_token_header_and_control_plane_never_does() -> None:
    cube, http = _cube()
    http.responses["status"] = (200, {"bootstrapped": True})
    await cube.status("sb-public", 9121)
    assert TRAFFIC_TOKEN_HEADER not in http.calls[-1][2]

    cube.register_traffic_token("sb1", "tok-1")
    http.responses["sb1"] = (200, {"sandboxID": "sb1", "state": "running"})
    await cube.get_sandbox("sb1")
    method, url, headers = http.calls[-1]
    assert url == "http://api:3000/sandboxes/sb1"
    assert TRAFFIC_TOKEN_HEADER not in (headers or {})


@pytest.mark.asyncio
async def test_create_private_registers_token_and_refuses_when_platform_gives_none() -> None:
    cube, http = _cube()
    http.responses["sandboxes"] = (201, {"sandboxID": "sb9", "trafficAccessToken": "tok-9"})
    sid = await cube.create_sandbox(volume_name="v", workspace_path="/mnt/u", private_traffic=True)
    assert sid == "sb9" and cube.traffic_token("sb9") == "tok-9"

    http.calls.clear()
    http.responses["sandboxes"] = (201, {"sandboxID": "sb10"})
    http.responses["sb10"] = (204, "")
    with pytest.raises(CubeError, match="trafficAccessToken"):
        await cube.create_sandbox(volume_name="v", workspace_path="/mnt/u", private_traffic=True)
    assert any(c[0] == "DELETE" and c[1].endswith("/sandboxes/sb10") for c in http.calls)  # 没令牌的实例立刻删掉
    assert cube.traffic_token("sb10") == ""


@pytest.mark.asyncio
async def test_remove_sandbox_forgets_token() -> None:
    cube, http = _cube()
    cube.register_traffic_token("sb1", "tok-1")
    http.responses["sb1"] = (204, "")
    await cube.remove_sandbox("sb1")
    assert cube.traffic_token("sb1") == ""
