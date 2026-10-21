"""东方财富专家接上桌面的 OpenConnector 连接器。

配置形状照桌面 ``electron/open-connector`` 实际写进档案的样子：键名 ``connector_eastmoney_mcp``，
本机地址、运行令牌、``X-OpenConnector-Allowed-Services`` 请求头和 ``desktop_connector`` 标记。
专家通过真实安装器装成独立档案，同步走真实的 ``expert_sync``。
"""

from pathlib import Path

import hermes_yaml as yaml
import pytest

from tests.plugins.test_uniwork_kits_plugin import (  # noqa: F401 - fixtures
    _config,
    _expert_pkg,
    _write,
    kits,
    profile_env,
)

CONNECTOR = {
    "url": "http://127.0.0.1:51873/mcp",
    "headers": {"Authorization": "Bearer runtime-token", "X-OpenConnector-Allowed-Services": "eastmoney_mcp"},
    "desktop_connector": "eastmoney_mcp",
    "enabled": True,
}


@pytest.fixture
def experts(kits, profile_env, tmp_path):
    """装一个东方财富专家和一个普通专家，返回它们各自的档案目录。"""
    from hermes_cli.profiles import get_profile_dir

    kits.installer.install(_expert_pkg(tmp_path, name="stock-diagnosis-expert"), profile_env, triggers={})
    kits.installer.install(_expert_pkg(tmp_path, name="demo-expert"), profile_env, triggers={})
    return Path(get_profile_dir("stock-diagnosis-expert")), Path(get_profile_dir("demo-expert"))


def _connect_in_default(home: Path, entry: dict) -> None:
    """模拟用户在默认档案的「连接器」页面授权东方财富后，桌面写进配置的那一条。"""
    _write(home / "config.yaml", yaml.safe_dump({
        "model": {"provider": "zai", "default": "glm-test"},
        "mcp_servers": {"connector_eastmoney_mcp": entry},
    }))


def test_the_default_profiles_connector_reaches_only_the_eastmoney_experts(kits, profile_env, experts, monkeypatch):
    """默认档案授权后，东方财富专家拿到同一条连接（换键名、去掉桌面标记），取数说明指向它；别的专家拿不到。"""
    em, plain = experts
    _connect_in_default(profile_env, CONNECTOR)

    kits.expert_sync.sync_all(profile_env)

    mirrored = _config(em)["mcp_servers"][kits.eastmoney_slot.MIRROR_NAME]
    assert mirrored["url"] == CONNECTOR["url"] and mirrored["headers"] == CONNECTOR["headers"]
    # 带着这个标记，专家后端启动前会被桌面改写成专家自己那份还没授权的连接器。
    assert "desktop_connector" not in mirrored
    assert "connector_eastmoney_mcp" not in _config(em)["mcp_servers"]
    assert not (_config(plain).get("mcp_servers") or {})

    monkeypatch.setenv("HERMES_HOME", str(em))
    note = kits.eastmoney_slot.turn_note(em)
    assert "mcp__eastmoney_mcp__execute_action" in note and "eastmoney_mcp.list_tools" in note


def test_an_earlier_copy_under_the_desktop_key_is_replaced(kits, profile_env, experts):
    """以前原样同步过去的 connector_eastmoney_mcp（已被桌面改写、连不上）会被清掉，换成新键名那条。"""
    em, _plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    stale = {**CONNECTOR, "url": "http://127.0.0.1:60001/mcp", "headers": {"Authorization": "Bearer expert-own"}}
    _write(em / "config.yaml", yaml.safe_dump({**_config(em), "mcp_servers": {"connector_eastmoney_mcp": stale}}))
    index = kits.store.load_index(em)
    name, entry = kits.store.self_expert(index)
    entry["sync"] = {"synced_mcp": ["connector_eastmoney_mcp"]}
    index["plugins"][name] = entry
    kits.store.save_index(em, index)

    kits.expert_sync.sync_all(profile_env)

    servers = _config(em)["mcp_servers"]
    assert "connector_eastmoney_mcp" not in servers
    assert servers[kits.eastmoney_slot.MIRROR_NAME]["url"] == CONNECTOR["url"]


def test_an_expert_authorized_on_its_own_keeps_its_own_connection(kits, profile_env, experts, monkeypatch):
    """用户在专家档案里自己授权过（带桌面标记、不是同步来的），就用专家自己的，不再同步默认档案那条。"""
    em, _plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    own = {**CONNECTOR, "url": "http://127.0.0.1:60002/mcp"}
    _write(em / "config.yaml", yaml.safe_dump({**_config(em), "mcp_servers": {"connector_eastmoney_mcp": own}}))

    kits.expert_sync.sync_all(profile_env)

    servers = _config(em)["mcp_servers"]
    assert servers["connector_eastmoney_mcp"]["url"] == own["url"]
    assert kits.eastmoney_slot.MIRROR_NAME not in servers
    monkeypatch.setenv("HERMES_HOME", str(em))
    assert "mcp__connector_eastmoney_mcp__execute_action" in kits.eastmoney_slot.turn_note(em)


def test_disconnecting_in_the_default_profile_takes_it_back_from_the_experts(kits, profile_env, experts, monkeypatch):
    """在默认档案断开（桌面把那条设成 enabled: false）后，下次同步从专家里去掉，专家回到包里的脚本取数。"""
    em, _plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    kits.expert_sync.sync_all(profile_env)
    assert kits.eastmoney_slot.MIRROR_NAME in _config(em)["mcp_servers"]

    _connect_in_default(profile_env, {**CONNECTOR, "enabled": False})
    kits.expert_sync.sync_all(profile_env)

    assert kits.eastmoney_slot.MIRROR_NAME not in (_config(em).get("mcp_servers") or {})
    monkeypatch.setenv("HERMES_HOME", str(em))
    assert kits.eastmoney_slot.turn_note(em) == ""


def test_the_connector_is_recognised_by_its_marker_or_header_under_any_key(kits):
    """键名不是约定的也认：桌面标记或请求头限定了东方财富服务就算；自己授权的那条优先；关掉的不算。"""
    slot = kits.eastmoney_slot
    assert slot.server_name({"anything": {"desktop_connector": "eastmoney_mcp"}}) == "anything"
    header_only = {"headers": {"x-openconnector-allowed-services": "qcc_mcp, eastmoney_mcp"}}
    assert slot.server_name({"other": header_only}) == "other"
    assert slot.server_name({"connector_qcc_mcp": {"desktop_connector": "qcc_mcp"}}) == ""
    both = {"eastmoney_mcp": {"url": "http://127.0.0.1:1/mcp"}, "connector_eastmoney_mcp": CONNECTOR}
    assert slot.server_name(both) == "connector_eastmoney_mcp"
    assert slot.server_name({"connector_eastmoney_mcp": {**CONNECTOR, "enabled": False}}) == ""


def test_an_expert_backend_refreshes_its_own_copy_when_it_starts(kits, profile_env, experts, monkeypatch):
    """连接器端口每次开桌面都会变：专家后端自己加载插件时从默认档案拉一次，不等默认档案先同步，也不碰别的专家。"""
    em, plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    kits.expert_sync.sync_all(profile_env)

    # 下一次打开桌面：默认档案的连接器换了端口，专家后端抢在默认档案同步之前启动。
    _connect_in_default(profile_env, {**CONNECTOR, "url": "http://127.0.0.1:52990/mcp"})
    monkeypatch.setattr(kits.expert_sync, "_synced_homes", set())
    monkeypatch.setattr(kits.expert_sync, "sync_all", lambda home: pytest.fail("an expert backend synced everyone"))

    kits.expert_sync.sync_on_load(em)

    assert _config(em)["mcp_servers"][kits.eastmoney_slot.MIRROR_NAME]["url"] == "http://127.0.0.1:52990/mcp"
    assert not (_config(plain).get("mcp_servers") or {})
