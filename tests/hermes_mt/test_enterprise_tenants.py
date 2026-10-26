"""企业模式下实例那一侧：元景 MCP 改走平台中转，建实例时放行内网的平台地址。个人模式不变。"""

from __future__ import annotations

import pytest

from entry.config import Settings
from entry.cube_api import Cube
from entry.tenants import YUANJING_MCP_NAME, TenantManager, cube_allow_out

PERSONAL = Settings(key_env_name="HERMES_CUSTOM_YUANJING_API_KEY")
ENTERPRISE = Settings(key_env_name="HERMES_CUSTOM_YUANJING_API_KEY", uniwork_server="http://192.168.0.50:11220")


def _mcp(settings: Settings, api_key: str = "device-token") -> dict | None:
    manager = TenantManager(settings, None, None, None)  # type: ignore[arg-type]
    return manager._mcp_servers(api_key)[YUANJING_MCP_NAME]


def test_personal_mode_mcp_url_is_unchanged() -> None:
    entry = _mcp(PERSONAL)
    assert entry is not None
    assert entry["url"].startswith("https://maas.ai-yuanjing.com/app/mcp-server/mcp?")
    assert "key=${HERMES_CUSTOM_YUANJING_API_KEY}" in entry["url"]


def test_enterprise_mcp_goes_through_the_platform_relay_with_the_same_parameters() -> None:
    entry = _mcp(ENTERPRISE)
    assert entry is not None
    url = entry["url"]
    assert url.startswith("http://192.168.0.50:11220/api/client/yj/app/mcp-server/mcp?")
    # key 仍然引用同一个变量（里面是设备令牌），平台中转时换成企业的 key；明文令牌不落进 config.yaml
    assert "key=${HERMES_CUSTOM_YUANJING_API_KEY}" in url and "device-token" not in url
    assert "client_id=UniWork" in url and "oss_mode=internal" in url
    assert entry["timeout"] == _mcp(PERSONAL)["timeout"]  # type: ignore[index]


def test_no_key_or_disabled_mcp_stays_off_in_enterprise_mode() -> None:
    assert _mcp(ENTERPRISE, api_key="") is None
    off = Settings(uniwork_server="http://192.168.0.50:11220", yuanjing_mcp_url="")
    assert _mcp(off) is None


@pytest.mark.parametrize(
    ("server", "extra", "want"),
    [
        ("", "", []),                                              # 个人模式不放行任何东西
        ("http://192.168.0.50:11220", "", ["192.168.0.50/32"]),   # 内网平台：自动放行这一个地址
        ("http://10.1.2.3", "", ["10.1.2.3/32"]),
        ("https://uniwork.example.com", "", []),                  # 域名：沙箱本来就放行公网
        ("http://8.8.8.8:11220", "", []),                         # 公网 IP 不用放行
        ("http://127.0.0.1:11220", "", []),                       # 回环地址对实例没意义
        ("http://192.168.0.50:11220", "10.9.0.0/16, 192.168.0.50/32", ["192.168.0.50/32", "10.9.0.0/16"]),
        ("", "10.9.0.0/16", ["10.9.0.0/16"]),
    ],
)
def test_cube_allow_out(server: str, extra: str, want: list[str]) -> None:
    assert cube_allow_out(Settings(uniwork_server=server, cube_allow_out=extra)) == want


async def _created_network(**kwargs) -> dict:
    cube = Cube(api_base="http://cube:3000", proxy_base="http://proxy:80", domain="cube.app", template="tpl-1")
    sent: dict = {}

    async def fake_req(method, path, *, json_body=None, **_):
        sent.update(json_body or {})
        return 200, {"sandboxID": "sb-1"}

    cube._req = fake_req  # type: ignore[method-assign]
    try:
        assert await cube.create_sandbox(volume_name="vol", workspace_path="/mnt/u", **kwargs) == "sb-1"
    finally:
        await cube.close()
    return sent["network"]


@pytest.mark.asyncio
async def test_create_sandbox_sends_allow_out_only_when_given() -> None:
    assert "allowOut" not in await _created_network()
    assert "allowOut" not in await _created_network(allow_out=[])
    network = await _created_network(allow_out=["192.168.0.50/32"])
    assert network["allowOut"] == ["192.168.0.50/32"]
    assert network["allowInternetAccess"] is True
