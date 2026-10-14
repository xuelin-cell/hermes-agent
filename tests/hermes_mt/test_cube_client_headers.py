"""Cube 客户端：数据面每一种调用都要带路由 Host 和（登记过的）流量令牌；控制面调用不带令牌。

用一个假的 aiohttp 会话记录每次请求的 URL 和请求头，不碰网络。
"""

from __future__ import annotations

import json

import aiohttp
import pytest

from entry import cube_api
from entry.cube_api import TRAFFIC_TOKEN_HEADER, Cube, CubeError, SandboxGone


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
    """``responses`` 按路径最后一段给回包：``(状态, 内容)``；给一串就按次序一个个回（最后一个一直回下去）；
    给一个异常就抛它。"""

    def __init__(self):
        self.calls: list[tuple[str, str, dict]] = []
        self.bodies: list[object] = []
        self.responses: dict[str, object] = {}

    def request(self, method, url, **kwargs):
        headers = dict(kwargs.get("headers") or {})
        self.calls.append((method, url, headers))
        self.bodies.append(kwargs.get("json"))
        found = self.responses.get(url.split("?")[0].rsplit("/", 1)[-1], (200, {"ok": True}))
        if isinstance(found, list):
            found = found.pop(0) if len(found) > 1 else found[0]
        if isinstance(found, Exception):
            raise found
        status, body = found
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


async def _no_sleep(_s):
    return None


@pytest.mark.asyncio
async def test_wait_hermes_stops_at_once_when_control_plane_says_gone(monkeypatch) -> None:
    """数据面答"不认识这台实例"且控制面 404 ⇒ 立刻 SandboxGone，不等满超时（10-08 真机等了 180 秒）。"""
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    cube, fake = _cube()
    fake.responses["health"] = (404, {"error": "not found"})
    fake.responses["sbGone"] = (404, {"error": "not found"})
    with pytest.raises(SandboxGone):
        await cube.wait_hermes("sbGone", 9121, timeout_s=60)
    control = [c for c in fake.calls if c[1] == "http://api:3000/sandboxes/sbGone"]
    assert len(control) == 1


@pytest.mark.asyncio
async def test_wait_hermes_keeps_waiting_while_control_plane_still_lists_it(monkeypatch) -> None:
    """控制面还说"在"（刚建好路由没登记 / 异步删除还没落地）⇒ 照常等到超时，控制面最多 5 秒问一次。"""
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    cube, fake = _cube()
    fake.responses["health"] = (404, {"error": "not found"})
    fake.responses["sbAlive"] = (200, {"sandboxID": "sbAlive", "state": "running"})
    with pytest.raises(CubeError) as exc:
        await cube.wait_hermes("sbAlive", 9121, timeout_s=0.2)
    assert not isinstance(exc.value, SandboxGone)
    control = [c for c in fake.calls if c[1] == "http://api:3000/sandboxes/sbAlive"]
    assert len(control) == 1


# ---- 引导请求被平台代理挡回时重发（10-14 换模板时撞上过：转发器刚应答了健康检查，引导请求就被代理回了 502）

PROXY_502 = "<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n<center><h1>502 Bad Gateway</h1></center>\n<hr><center>openresty</center>\n</body>\n</html>\n"


def _bootstrap_posts(fake: _FakeHttp) -> int:
    return sum(1 for c in fake.calls if c[1].endswith("/__mt/bootstrap"))


def test_only_what_the_platform_proxy_bounced_counts_as_a_hiccup() -> None:
    assert cube_api.proxy_hiccup(CubeError(502, PROXY_502[:300]))
    assert cube_api.proxy_hiccup(CubeError(504, "<html>gateway timeout</html>"))
    assert cube_api.proxy_hiccup(CubeError(0, "ClientConnectorError: refused"))
    # 转发器自己回的错是 JSON：hermes 没在超时内就绪、恢复失败、卷没挂好……重发也一样，不算
    assert not cube_api.proxy_hiccup(CubeError(503, str({"ok": False, "error": "hermes 未在超时内就绪"})))
    assert not cube_api.proxy_hiccup(CubeError(500, str({"ok": False, "error": "恢复失败: x"})))
    assert not cube_api.proxy_hiccup(CubeError(409, str({"ok": False, "error": "拒绝启动", "refused": True})))


@pytest.mark.asyncio
async def test_bootstrap_is_resent_when_the_platform_proxy_bounces_it(monkeypatch) -> None:
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    cube, fake = _cube()
    fake.responses["bootstrap"] = [(502, PROXY_502), (200, {"ok": True, "state": {"archive": "a.tar.gz"}})]

    body = await cube.bootstrap("sb1", 9121, token="t", files=[], state=None)

    assert body["state"]["archive"] == "a.tar.gz" and _bootstrap_posts(fake) == 2


@pytest.mark.asyncio
async def test_resent_bootstrap_that_finds_it_already_done_counts_as_done(monkeypatch) -> None:
    """第一次其实到了实例、只是回包被挡：重发的那次回「已经引导过了」，当作成功。"""
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    cube, fake = _cube()
    fake.responses["bootstrap"] = [(502, PROXY_502), (409, {"ok": False, "error": "已经引导过了"})]

    assert await cube.bootstrap("sb1", 9121, token="t", files=[], state=None) == {"ok": True, "already": True}


@pytest.mark.asyncio
async def test_bootstrap_is_not_resent_when_the_instance_itself_says_no(monkeypatch) -> None:
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    cube, fake = _cube()
    fake.responses["bootstrap"] = (503, {"ok": False, "error": "hermes 未在超时内就绪"})

    with pytest.raises(CubeError) as exc:
        await cube.bootstrap("sb1", 9121, token="t", files=[], state=None)

    assert exc.value.status == 503 and _bootstrap_posts(fake) == 1


@pytest.mark.asyncio
async def test_bootstrap_resends_for_at_most_thirty_seconds(monkeypatch) -> None:
    """一直被挡：30 秒后把最后那个错抛出去，交给下一次请求补引导。"""
    clock = iter(range(0, 1000, 10))
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(cube_api.time, "monotonic", lambda: next(clock))
    cube, fake = _cube()
    fake.responses["bootstrap"] = (502, PROXY_502)

    with pytest.raises(CubeError) as exc:
        await cube.bootstrap("sb1", 9121, token="t", files=[], state=None)

    assert exc.value.status == 502 and _bootstrap_posts(fake) == 3


@pytest.mark.asyncio
async def test_bootstrap_is_resent_when_the_proxy_cannot_be_reached(monkeypatch) -> None:
    monkeypatch.setattr(cube_api.asyncio, "sleep", _no_sleep)
    cube, fake = _cube()
    fake.responses["bootstrap"] = [aiohttp.ClientConnectionError("reset"), (200, {"ok": True, "state": {}})]

    assert (await cube.bootstrap("sb1", 9121, token="t", files=[], state=None))["ok"] is True
    assert _bootstrap_posts(fake) == 2


@pytest.mark.asyncio
async def test_bootstrap_sends_the_skill_policy_only_when_given() -> None:
    cube, fake = _cube()
    await cube.bootstrap("sb1", 9121, token="t", files=[], state=None,
                         skills={"keep_categories": ["uniwork"], "keep": []})
    await cube.bootstrap("sb2", 9121, token="t", files=[], state=None)
    first, second = [body for body, call in zip(fake.bodies, fake.calls) if call[1].endswith("/__mt/bootstrap")]
    assert first["skills"] == {"keep_categories": ["uniwork"], "keep": []}
    assert "skills" not in second  # 老转发器不认这一项也没关系，但没给就别带
