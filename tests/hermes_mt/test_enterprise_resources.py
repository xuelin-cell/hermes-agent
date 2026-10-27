"""企业资源清单（docs/企业版对接/19~21）：入口把平台策略算成清单（entry/enterprise.py），转发器按清单装进实例（seed/mtent.py）。

- 员工实例：全员可见的技能、连接器进默认 profile；每个已发布的 Agent 一个托管 profile，只带它自己的东西（含 onlyFor 的）。
- 平台的运行环境：策略里的东西整份进默认 profile。
- 下载的包按 sha256 校验、缓存；越界路径的包装不上；下架移进 .uw-retired，重新发布移回来，会话还在。
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

from entry.config import Settings
from entry.enterprise import build_spec, spec_digest
from entry.tenants import TenantManager

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"
if str(SEED_DIR) not in sys.path:
    sys.path.insert(0, str(SEED_DIR))
import mtent  # noqa: E402

PLATFORM = "http://platform.test"  # 平台在策略里宣告的地址
ENTRY_SIDE = "http://host.docker.internal:11220"  # 入口配置的平台地址（实例按它连）
TOKEN_ENV = "HERMES_CUSTOM_YUANJING_API_KEY"
SETTINGS = Settings(key_env_name=TOKEN_ENV, uniwork_server=ENTRY_SIDE)


def _zip(files: dict[str, str], *, symlink: str = "") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = 0o120777 << 16
            z.writestr(info, "/etc/passwd")
    return buf.getvalue()


SKILL_ZIP = _zip({"sales-margin/SKILL.md": "---\nname: sales-margin\ndescription: 毛利率计算\n---\n算毛利率",
                  "sales-margin/scripts/margin.py": "print('MG-123456')\n"})
FLAT_SKILL_ZIP = _zip({"SKILL.md": "---\nname: weekly\ndescription: 周报\n---\n写周报"})
PLUGIN_ZIP = _zip({".claude-plugin/plugin.json": json.dumps({"name": "uniwork-report-reviewer"}),
                   ".codebuddy-plugin/plugin.json": json.dumps({"name": "uniwork-report-reviewer"}),
                   "skills/report-review/SKILL.md": "---\nname: report-review\ndescription: 审阅\n---\n审阅报告",
                   ".mcp.json": json.dumps({"mcpServers": {"review-api": {"type": "http", "url": "https://review.test/mcp"},
                                                           "local-tool": {"command": "node", "args": ["x.js"]}}})})
LAYER_ZIP = _zip({"monthly-analysis/SKILL.md": "---\nname: monthly-analysis\ndescription: 月度经营分析\n---\n分析"})
EVIL_ZIP = _zip({"../escape/SKILL.md": "x"})


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _item(file_id: str, name: str, data: bytes, **extra) -> dict:
    return {"id": file_id, "name": name, "displayName": name, "version": "v1", "description": "", "sha256": _sha(data),
            "url": f"{PLATFORM}/api/client/files/{file_id}", **extra}


def _policy(*, delivered: bool = True, instructions: str = "每次回答第一行写「【数据分析专家·联调】」。") -> dict:
    """照平台 b8a548d8 的 build_policy：Agent 用到、员工自己看不到的东西带 onlyFor。"""
    agent = {"key": "agent:agent_e2e_data", "kind": "agent", "id": "agent_e2e_data", "name": "数据分析专家（联调）",
             "description": "联调用", "model": "uniwork-catalog-glm", "instructions": instructions,
             "skills": ["f-skill"], "plugins": ["f-plugin"], "connectors": ["demo-sales"],
             "memory": "shared", "approval": "manual", "revision": "r1" if instructions.endswith("。") else "r2"}
    return {
        "revision": "rev-1",
        "enterprise": {"tenantId": "tid-1", "tenantCode": "T100001", "serverUrl": PLATFORM},
        "access": {"allowed": True, "reason": ""},
        "models": {"models": [
            {"id": "uniwork-catalog-ds", "model": "deepseek-v4-flash", "display_name": "DeepSeek V4 Flash"},
            {"id": "uniwork-catalog-glm", "model": "glm-5.2", "display_name": "GLM 5.2", "context_window": 128000,
             "onlyFor": ["agent_e2e_data"]},
        ], "main_model_id": "uniwork-catalog-ds", "fast_model_id": ""},
        "skills": [_item("f-weekly", "weekly", FLAT_SKILL_ZIP),
                   _item("f-skill", "sales-margin", SKILL_ZIP, onlyFor=["agent_e2e_data"])],
        "plugins": [_item("f-plugin", "uniwork-report-reviewer", PLUGIN_ZIP, kind="expert", onlyFor=["agent_e2e_data"])],
        "connectors": [
            {"id": "orders", "name": "订单库", "url": "http://10.0.0.9/mcp", "transport": "http", "timeout": 30,
             "relay": f"{PLATFORM}/api/client/connectors/orders/mcp"},
            {"id": "demo-sales", "name": "销售演示库", "url": "http://192.168.0.50:11231/mcp", "transport": "http",
             "timeout": 20, "relay": f"{PLATFORM}/api/client/connectors/demo-sales/mcp", "onlyFor": ["agent_e2e_data"]},
        ],
        "sharedLayers": [{
            "key": "agent:agent_e2e_data", "kind": "agent", "id": "agent_e2e_data", "name": "数据分析专家（联调）",
            "version": "v9", "skills": [_item("f-layer", "monthly-analysis", LAYER_ZIP, itemId="it-1", contributors=2)],
            "facts": {"count": 1, "inline": True, "items": [{"id": "it-2", "title": "毛利率统一口径",
                                                             "content": "毛利率 = 毛利 / 不含税收入，保留一位小数，标注 GM-26"}]},
            "layerUrl": f"{PLATFORM}/api/client/experts/agent%3Aagent_e2e_data/layer",
            "knowledgeMcp": {"url": f"{PLATFORM}/api/client/experts/agent%3Aagent_e2e_data/mcp"},
        }],
        "experts": [agent] if delivered else [],
    }


def _config(api_key: str = "device-token") -> dict:
    from entry import tenants as tenants_module

    tenants_module.SEED_DIR = SEED_DIR  # 入口镜像里 seed/ 在 entry/ 旁边；仓库里在上一级
    manager = TenantManager(SETTINGS, None, None, None)  # type: ignore[arg-type]
    return manager._config_patch_spec(("http://platform.test/v1", "deepseek-v4-flash"),  # noqa: SLF001
                                      [("deepseek-v4-flash", "deepseek")], {"deepseek-v4-flash": 300000}, api_key=api_key)


class Fetcher:
    """假下载：按 URL 给包，记下载了几次。"""

    def __init__(self, extra: dict[str, bytes] | None = None) -> None:
        self.blobs = {f"{ENTRY_SIDE}/api/client/files/{k}": v for k, v in {
            "f-weekly": FLAT_SKILL_ZIP, "f-skill": SKILL_ZIP, "f-plugin": PLUGIN_ZIP, "f-layer": LAYER_ZIP,
            **(extra or {})}.items()}
        self.calls: list[str] = []

    def __call__(self, url: str, _what: str) -> bytes:
        self.calls.append(url)
        if url not in self.blobs:
            raise mtent.EnterpriseError("平台返回 HTTP 404")
        return self.blobs[url]


@pytest.fixture
def home(tmp_path: Path) -> Path:
    (tmp_path / ".env").write_text(f"TERMINAL_ENV=local\n{TOKEN_ENV}=tok-1\n", encoding="utf-8")
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: deepseek-v4-flash\nmcp_servers:\n  my-own:\n    url: https://mine.test/mcp\n", encoding="utf-8")
    return tmp_path


# ---------------------------------------------------------------- 入口：策略 → 清单

def test_member_spec_splits_what_the_member_sees_from_what_only_the_agent_uses() -> None:
    spec = build_spec(_policy(), server=ENTRY_SIDE, token_env=TOKEN_ENV, config=_config())
    assert spec["v"] == mtent.SPEC_VERSION and spec["tenant"] == "tid-1" and spec["server"] == ENTRY_SIDE
    # 默认 profile：只有全员可见的（不带 onlyFor）；地址换成入口配置的平台地址
    assert [s["id"] for s in spec["default"]["skills"]] == ["f-weekly"]
    assert spec["default"]["skills"][0]["url"] == f"{ENTRY_SIDE}/api/client/files/f-weekly"
    assert [c["id"] for c in spec["default"]["connectors"]] == ["orders"]
    assert spec["default"]["plugins"] == [] and spec["default"]["layers"] == []
    [agent] = spec["agents"]
    assert agent["id"] == "agent_e2e_data" and agent["model"] == "glm-5.2"
    assert agent["models"] == ["glm-5.2", "deepseek-v4-flash"]
    assert [s["id"] for s in agent["skills"]] == ["f-skill"] and [p["id"] for p in agent["plugins"]] == ["f-plugin"]
    assert agent["connectors"][0]["relay"] == f"{ENTRY_SIDE}/api/client/connectors/demo-sales/mcp"
    assert agent["layers"][0]["key"] == "agent:agent_e2e_data"
    assert agent["layers"][0]["skills"][0]["url"] == f"{ENTRY_SIDE}/api/client/files/f-layer"
    assert agent["memory"] == "shared" and agent["approval"] == "manual"
    # 清单不带令牌；内置的元景 MCP 引用令牌变量
    text = json.dumps(spec, ensure_ascii=False)
    assert "device-token" not in text and f"${{{TOKEN_ENV}}}" in text


def test_service_spec_puts_everything_into_the_default_profile() -> None:
    spec = build_spec(_policy(), server=ENTRY_SIDE, token_env=TOKEN_ENV, config=_config(), service=True)
    assert spec["agents"] == []
    assert {s["id"] for s in spec["default"]["skills"]} == {"f-weekly", "f-skill"}
    assert [p["id"] for p in spec["default"]["plugins"]] == ["f-plugin"]
    assert {c["id"] for c in spec["default"]["connectors"]} == {"orders", "demo-sales"}
    assert [x["key"] for x in spec["default"]["layers"]] == ["agent:agent_e2e_data"]


def test_digest_ignores_the_policy_revision_but_not_the_content() -> None:
    a = build_spec(_policy(), server=ENTRY_SIDE, token_env=TOKEN_ENV, config=_config())
    b = build_spec({**_policy(), "revision": "rev-2"}, server=ENTRY_SIDE, token_env=TOKEN_ENV, config=_config())
    c = build_spec(_policy(instructions="改了"), server=ENTRY_SIDE, token_env=TOKEN_ENV, config=_config())
    assert spec_digest(a) == spec_digest(b) != spec_digest(c)


# ---------------------------------------------------------------- 转发器：按清单装

def _spec(policy: dict | None = None, **kw) -> dict:
    return build_spec(policy or _policy(), server=ENTRY_SIDE, token_env=TOKEN_ENV, config=_config(), **kw)


def test_agent_becomes_a_managed_profile_with_its_own_resources(home: Path) -> None:
    fetch = Fetcher()
    report = mtent.apply(home, _spec(), fetch)
    assert report["ok"], report["errors"]
    profile = home / "profiles" / "uw-agent_e2e_data"
    org = profile / "skills" / "_org"
    assert (org / ".active_org").read_text(encoding="utf-8") == "tid-1"
    assert (org / "tid-1" / "enterprise" / "sales-margin" / "scripts" / "margin.py").is_file()
    assert (org / "tid-1" / "plugin-uniwork-report-reviewer" / "report-review" / "SKILL.md").is_file()
    assert (org / "tid-1" / "experience" / "monthly-analysis" / "SKILL.md").is_file()
    # 人设 = 角色与指令 + 企业事实
    soul = (profile / "SOUL.md").read_text(encoding="utf-8")
    assert soul.startswith("# 数据分析专家（联调）\n\n每次回答第一行写「【数据分析专家·联调】」。")
    assert "## 企业事实" in soul and "GM-26" in soul
    meta = yaml.safe_load((profile / "profile.yaml").read_text(encoding="utf-8"))
    assert meta["display_name"] == "数据分析专家（联调）" and meta["ui_meta"]["hermes-bots"]["title"] == "数据分析专家（联调）"
    assert meta["ui_meta"]["uniwork"]["managed"] is True
    cfg = yaml.safe_load((profile / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["model"]["default"] == "glm-5.2"
    provider = cfg["providers"][cfg["model"]["provider"]]
    assert provider["extra_headers"] == {"X-Uniwork-Agent": "agent_e2e_data"}
    assert provider["models"] == {"glm-5.2": {"context_length": 128000}, "deepseek-v4-flash": {"context_length": 300000}}
    assert cfg["approvals"]["mode"] == "manual"
    assert cfg["memory"]["memory_enabled"] is True
    servers = cfg["mcp_servers"]
    assert servers["uniwork-ent-demo-sales"] == {
        "url": f"{ENTRY_SIDE}/api/client/connectors/demo-sales/mcp",
        "headers": {"Authorization": f"Bearer ${{{TOKEN_ENV}}}"}, "timeout": 20}
    assert servers["uniwork-plugin-uniwork-report-reviewer-review-api"] == {"url": "https://review.test/mcp"}
    assert not any("local-tool" in name for name in servers)  # stdio 的不装
    assert servers["yuanjing"]["url"].startswith(f"{ENTRY_SIDE}/api/client/yj/")  # 元景工具照常在
    assert "uniwork-ent-orders" not in servers  # 员工全员可见的连接器不进 Agent
    assert f"{TOKEN_ENV}=tok-1" in (profile / ".env").read_text(encoding="utf-8")
    # 默认 profile：全员可见的技能和连接器，用户自己的 MCP 不动
    assert (home / "skills" / "_org" / "tid-1" / "enterprise" / "weekly" / "SKILL.md").is_file()
    assert not (home / "skills" / "_org" / "tid-1" / "enterprise" / "sales-margin").exists()
    default_cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert default_cfg["mcp_servers"]["my-own"] == {"url": "https://mine.test/mcp"}
    assert default_cfg["mcp_servers"]["uniwork-ent-orders"]["url"] == f"{ENTRY_SIDE}/api/client/connectors/orders/mcp"
    assert "uniwork-ent-demo-sales" not in default_cfg["mcp_servers"]


def test_second_apply_is_a_no_op_and_uses_the_cache(home: Path) -> None:
    fetch = Fetcher()
    mtent.apply(home, _spec(), fetch)
    downloads = len(fetch.calls)
    report = mtent.apply(home, _spec(), fetch)
    assert report["ok"] and report["profiles"] == {} and report["installed"] == [] and report["mcp_changed"] == []
    assert len(fetch.calls) == downloads  # 专家包的 MCP 从缓存里读，不再下载


def test_edits_follow_and_user_disabled_connector_stays_disabled(home: Path) -> None:
    mtent.apply(home, _spec(), Fetcher())
    cfg = (home / "config.yaml").read_text(encoding="utf-8").replace(
        "uniwork-ent-orders:\n", "uniwork-ent-orders:\n    enabled: false\n")
    (home / "config.yaml").write_text(cfg, encoding="utf-8")
    report = mtent.apply(home, _spec(_policy(instructions="金额保留整数。")), Fetcher())
    assert report["profiles"] == {"uw-agent_e2e_data": ["SOUL.md"]}
    assert "金额保留整数。" in (home / "profiles" / "uw-agent_e2e_data" / "SOUL.md").read_text(encoding="utf-8")
    assert yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))["mcp_servers"]["uniwork-ent-orders"]["enabled"] is False


def test_withdrawn_agent_is_retired_with_its_data_and_comes_back(home: Path) -> None:
    mtent.apply(home, _spec(), Fetcher())
    profile = home / "profiles" / "uw-agent_e2e_data"
    (profile / "state.db").write_bytes(b"sessions")
    report = mtent.apply(home, _spec(_policy(delivered=False)), Fetcher())
    assert report["retired"] == ["uw-agent_e2e_data"] and not profile.exists()
    assert (home / "profiles" / ".uw-retired" / "uw-agent_e2e_data" / "state.db").read_bytes() == b"sessions"
    report = mtent.apply(home, _spec(), Fetcher())
    assert report["restored"] == ["uw-agent_e2e_data"] and (profile / "state.db").read_bytes() == b"sessions"


def test_bad_packages_are_reported_and_the_rest_still_installs(home: Path) -> None:
    policy = _policy()
    policy["skills"][1]["sha256"] = "0" * 64  # 平台说的 sha256 对不上
    policy["plugins"][0] = _item("f-evil", "evil", EVIL_ZIP, kind="expert", onlyFor=["agent_e2e_data"])
    policy["experts"][0]["plugins"] = ["f-evil"]
    report = mtent.apply(home, _spec(policy), Fetcher({"f-evil": EVIL_ZIP}))
    assert not report["ok"]
    assert any("sha256" in e for e in report["errors"]) and any("越界" in e for e in report["errors"])
    assert not (home / "escape").exists()
    profile = home / "profiles" / "uw-agent_e2e_data"
    assert (profile / "skills" / "_org" / "tid-1" / "experience" / "monthly-analysis" / "SKILL.md").is_file()
    assert (profile / "SOUL.md").is_file()


def test_downloads_only_from_the_platform(home: Path) -> None:
    policy = _policy()
    policy["skills"][0]["url"] = "http://attacker.test/x.zip"
    report = mtent.apply(home, _spec(policy), Fetcher())
    assert any("不在企业管理平台上" in e for e in report["errors"])


def test_symlinks_in_packages_are_skipped(home: Path) -> None:
    data = _zip({"s/SKILL.md": "---\nname: s\n---\n"}, symlink="s/link")
    dest = home / "out"
    assert mtent._extract_skills(data, dest, "s") == ["s"]  # noqa: SLF001
    assert not (dest / "s" / "link").exists()


def test_occupied_profile_name_is_not_overwritten(home: Path) -> None:
    mine = home / "profiles" / "uw-agent_e2e_data"
    mine.mkdir(parents=True)
    (mine / "SOUL.md").write_text("员工自己的", encoding="utf-8")
    report = mtent.apply(home, _spec(), Fetcher())
    assert any("已被占用" in e for e in report["errors"])
    assert (mine / "SOUL.md").read_text(encoding="utf-8") == "员工自己的"


def test_tokens_follow_the_default_profile(home: Path) -> None:
    mtent.apply(home, _spec(), Fetcher())
    (home / ".env").write_text(f"TERMINAL_ENV=local\n{TOKEN_ENV}=tok-2\n", encoding="utf-8")
    assert mtent.sync_tokens(home, mtent.token_env_of(home)) == ["uw-agent_e2e_data"]
    assert f"{TOKEN_ENV}=tok-2" in (home / "profiles" / "uw-agent_e2e_data" / ".env").read_text(encoding="utf-8")
    assert mtent.sync_tokens(home, TOKEN_ENV) == []
    # 员工自建的机器人（建时复制了默认 profile 的 .env）也跟上；没有这个变量的不碰
    mine = home / "profiles" / "my-bot"
    mine.mkdir()
    (mine / ".env").write_text(f"{TOKEN_ENV}=tok-2\nOTHER=1\n", encoding="utf-8")
    plain = home / "profiles" / "plain"
    plain.mkdir()
    (plain / "SOUL.md").write_text("x", encoding="utf-8")
    (home / ".env").write_text(f"TERMINAL_ENV=local\n{TOKEN_ENV}=tok-3\n", encoding="utf-8")
    assert sorted(mtent.sync_tokens(home, TOKEN_ENV)) == ["my-bot", "uw-agent_e2e_data"]
    assert (mine / ".env").read_text(encoding="utf-8") == f"{TOKEN_ENV}=tok-3\nOTHER=1\n"
    assert not (plain / ".env").exists()


def test_bot_mode_ui_meta_survives_a_resync(home: Path) -> None:
    mtent.apply(home, _spec(), Fetcher())
    meta_path = home / "profiles" / "uw-agent_e2e_data" / "profile.yaml"
    meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
    meta["ui_meta"]["hermes-bots"].update(pinned=True, color="#3366ff")
    meta["role"] = None
    meta_path.write_text(yaml.safe_dump(meta, allow_unicode=True), encoding="utf-8")
    mtent.apply(home, _spec(_policy(instructions="改了。")), Fetcher())
    after = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
    assert after["ui_meta"]["hermes-bots"] == {"title": "数据分析专家（联调）", "pinned": True, "color": "#3366ff"}
    assert after["ui_meta"]["uniwork"]["managed"] is True and "role" in after


def test_unbound_member_loses_org_skills_and_enterprise_connectors(home: Path) -> None:
    mtent.apply(home, _spec(), Fetcher())
    empty = {"revision": "x", "enterprise": {"tenantId": "", "serverUrl": PLATFORM}, "models": {"models": []}}
    report = mtent.apply(home, _spec(empty), Fetcher())
    assert report["retired"] == ["uw-agent_e2e_data"]
    assert not (home / "skills" / "_org" / ".active_org").exists()
    assert "uniwork-ent-orders" not in yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))["mcp_servers"]


def test_profile_names_are_valid_and_distinct() -> None:
    names = {mtent.profile_name(x) for x in ("agent_e2e_data", "Agent_E2E_Data", "数据", "a" * 80, "x/../y")}
    assert len(names) == 5
    assert all(mtent._PROFILE_NAME_RE.match(n) for n in names)  # noqa: SLF001
