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


def test_sync_does_not_create_connector_mirrors(kits, profile_env, experts):
    """连接器由 Electron 准备，插件同步不再给任何专家创建东方财富镜像。"""
    em, plain = experts
    _connect_in_default(profile_env, CONNECTOR)

    kits.expert_sync.sync_all(profile_env)

    assert not (_config(em).get("mcp_servers") or {})
    assert not (_config(plain).get("mcp_servers") or {})


@pytest.mark.parametrize("recorded", [True, False])
def test_retired_mirror_is_removed_without_deleting_shared_connector(kits, profile_env, experts, recorded):
    """旧镜像无论是否留下同步记录都会删除，已由 Electron 接管的条目不受旧记录影响。"""
    em, _plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    _write(em / "config.yaml", yaml.safe_dump({**_config(em), "mcp_servers": {
        "connector_eastmoney_mcp": CONNECTOR,
        kits.eastmoney_slot.MIRROR_NAME: {"url": "http://127.0.0.1:60001/mcp"},
        "personal": {"command": "custom-server"},
    }}))
    index = kits.store.load_index(em)
    name, entry = kits.store.self_expert(index)
    entry["sync"] = {"synced_mcp": ["connector_eastmoney_mcp", kits.eastmoney_slot.MIRROR_NAME] if recorded else []}
    index["plugins"][name] = entry
    kits.store.save_index(em, index)

    kits.expert_sync.sync_all(profile_env)

    servers = _config(em)["mcp_servers"]
    assert servers["connector_eastmoney_mcp"] == CONNECTOR
    assert kits.eastmoney_slot.MIRROR_NAME not in servers
    assert servers["personal"] == {"command": "custom-server"}
    assert kits.store.self_expert(kits.store.load_index(em))[1]["sync"]["synced_mcp"] == []


@pytest.mark.parametrize("own", [
    {"url": "https://mcp.eastmoney.com/mxds/mcp", "headers": {"Authorization": "Bearer user"}},
    {"command": "eastmoney-local-server"},
    {**CONNECTOR, "url": "http://127.0.0.1:60003/mcp"},
])
def test_user_owned_entry_under_the_retired_mirror_name_is_kept(kits, profile_env, experts, own):
    """同名但不是旧镜像（远程地址、本地命令或带桌面标记）的条目属于用户或桌面，不删除。"""
    em, _plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    _write(em / "config.yaml", yaml.safe_dump({**_config(em), "mcp_servers": {
        kits.eastmoney_slot.MIRROR_NAME: own,
    }}))

    kits.expert_sync.sync_all(profile_env)

    assert _config(em)["mcp_servers"][kits.eastmoney_slot.MIRROR_NAME] == own


def test_shared_managed_connection_drives_the_expert_turn_note(kits, profile_env, experts, monkeypatch):
    """只剩桌面受管条目时，取数说明仍指向同一条工具，不依赖旧镜像。"""
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


def test_sync_preserves_desktop_disabled_state(kits, profile_env, experts, monkeypatch):
    """桌面禁用连接器后，插件同步不重新启用它，也不靠镜像绕过禁用。"""
    em, _plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    _write(em / "config.yaml", yaml.safe_dump({**_config(em), "mcp_servers": {
        "connector_eastmoney_mcp": {**CONNECTOR, "enabled": False},
    }}))
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


def test_expert_plugin_load_keeps_the_endpoint_prepared_by_electron(kits, profile_env, experts, monkeypatch):
    """专家插件加载只同步模型等配置，不用主助手磁盘上的旧地址盖过 Electron 刚准备的地址。"""
    em, plain = experts
    _connect_in_default(profile_env, CONNECTOR)
    kits.expert_sync.sync_all(profile_env)

    _write(em / "config.yaml", yaml.safe_dump({**_config(em), "mcp_servers": {
        "connector_eastmoney_mcp": {**CONNECTOR, "url": "http://127.0.0.1:52990/mcp"},
    }}))
    monkeypatch.setattr(kits.expert_sync, "_synced_homes", set())
    monkeypatch.setattr(kits.expert_sync, "sync_all", lambda home: pytest.fail("an expert backend synced everyone"))

    kits.expert_sync.sync_on_load(em)

    assert _config(em)["mcp_servers"]["connector_eastmoney_mcp"]["url"] == "http://127.0.0.1:52990/mcp"
    assert kits.eastmoney_slot.MIRROR_NAME not in _config(em)["mcp_servers"]
    assert not (_config(plain).get("mcp_servers") or {})
