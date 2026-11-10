"""同一份代码两种部署：配了 MT_UNIWORK_SERVER 是企业版，普通版的东西不出现；没配的普通版不受影响。"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.fernet import Fernet

from entry import tenants as tenants_module
from entry.app import build_app
from entry.config import Settings
from entry.cube_api import Cube
from entry.tenants import PERSONAL_POLICY_KEYS, YUANJING_MCP_NAME, TenantManager
from entry.welcome_routes import WelcomeRoutes

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "deploy" / "hermes-mt"
SEED_DIR = HERE / "seed"
PLATFORM = "http://platform.test"


def _manager(monkeypatch: pytest.MonkeyPatch, **settings) -> TenantManager:
    monkeypatch.setattr(tenants_module, "SEED_DIR", SEED_DIR)
    return TenantManager(Settings(**settings), None, None, None, None)  # type: ignore[arg-type]


def _routes(**settings) -> set[str]:
    app = build_app(Settings(credential_key=Fernet.generate_key().decode(), database_url="postgresql://unused/db", **settings))
    return {resource.canonical for resource in app.router.resources()}


def test_personal_routes_exist_only_without_the_platform() -> None:
    personal = _routes()
    enterprise = _routes(uniwork_server=PLATFORM, client_features="none")
    gone = personal - enterprise
    for route in ("drive/{operation}", "mail", "plan/{operation}", "account/{operation}", "connectors",
                  "messaging/{operation}", "skills/{operation}", "maas-auth", "browser-auth.js"):
        assert f"/agents/api/__entry/{route}" in gone
    assert not enterprise - personal
    for shared in ("/agents/login", "/agents/api/__entry/me", "/agents/api/__entry/login", "/agents/api/__entry/select-tenant",
                   "/agents/api/__entry/enterprise", "/agents/api/__entry/welcome/{locale}", "/agents/api/ws",
                   "/agents/api/__hermes_backend/{tail}", "/hermes/__entry/service/v1/runtimes"):
        assert shared in enterprise


@pytest.mark.parametrize("raw, expected", [
    ("", {"kits", "skills", "connectors"}),
    ("none", set()),
    ("kits, connectors", {"kits", "connectors"}),
    ("skills,unknown", {"skills"}),
])
def test_client_features_default_to_everything_the_personal_edition_has(raw: str, expected: set[str]) -> None:
    assert Settings(uniwork_server=PLATFORM, client_features=raw).enterprise_features == expected


@pytest.mark.parametrize("features, opened", [
    ("", {"skills/{operation}", "connectors", "connectors/{provider}/oauth/callback"}),
    ("kits", {"skills/{operation}"}),
    ("skills", {"skills/{operation}"}),
    ("connectors", {"connectors", "connectors/{provider}/oauth/callback"}),
    ("none", set()),
])
def test_enterprise_opens_the_skill_and_connector_routes_it_lists(features: str, opened: set[str]) -> None:
    personal = _routes()
    closed = _routes(uniwork_server=PLATFORM, client_features="none")
    enterprise = _routes(uniwork_server=PLATFORM, client_features=features)
    assert {route.removeprefix("/agents/api/__entry/") for route in enterprise - closed} == opened
    assert not enterprise - personal
    for route in ("drive/{operation}", "mail", "plan/{operation}", "account/{operation}", "messaging/{operation}",
                  "maas-auth", "browser-auth.js"):
        assert f"/agents/api/__entry/{route}" not in enterprise  # 这些要个人版的 MaaS 账号或消息平台，不开


@pytest.mark.asyncio
async def test_enterprise_home_templates_are_read_without_a_maas_token() -> None:
    seen: list[tuple[str | None, str | None]] = []
    broken = {"en"}

    async def system_config(request: web.Request) -> web.Response:
        seen.append((request.query.get("key"), request.headers.get("Authorization")))
        if any(request.query.get("key", "").endswith(locale) for locale in broken):
            return web.json_response({"configValue": "not json"})
        return web.json_response({"configValue": json.dumps({"modules": [{"id": "office"}]}), "version": " v1 "})

    upstream = web.Application()
    upstream.router.add_get("/app/gateway/uniwork/system-config", system_config)
    async with TestServer(upstream) as server:
        routes = WelcomeRoutes(SimpleNamespace())
        assert routes.url == "https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config"  # 和桌面版同一个地址
        routes.url = str(server.make_url("/app/gateway/uniwork/system-config"))
        assert await routes.system_config("zh-CN") == {"modules": [{"id": "office"}], "version": "v1"}
        assert seen == [("welcome_config_v3_zh-CN", None)]  # 不带令牌
        await routes.system_config("zh-CN")
        assert len(seen) == 1  # 缓存期内不再去取
        with pytest.raises(web.HTTPServiceUnavailable):
            await routes.system_config("en")  # 配置坏了，也没有上一份
        broken.add("zh-CN")
        routes.cache["zh-CN"] = (time.monotonic() - 3600, routes.cache["zh-CN"][1])
        assert (await routes.system_config("zh-CN"))["modules"] == [{"id": "office"}]  # 过期后取不到，沿用上一份


def test_policy_and_seeded_config_leave_out_personal_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    personal = _manager(monkeypatch)
    enterprise = _manager(monkeypatch, uniwork_server=PLATFORM, client_features="none")

    assert PERSONAL_POLICY_KEYS <= set(personal._platform_policy())
    assert not PERSONAL_POLICY_KEYS & set(enterprise._platform_policy())
    assert enterprise._platform_policy()["model_catalog"] == {"enabled": False}

    seen_personal = yaml.safe_load(personal._render_user_files("k")["config.yaml"])
    seen_enterprise = yaml.safe_load(enterprise._render_user_files("k")["config.yaml"])
    for key in ("cloud_sharing", "cloud_drive", "cloud_mail", "cloud_kits"):
        assert seen_personal[key] == {"enabled": True}
        assert key not in seen_enterprise
    assert {"Agent-Mail", "UniWork-Drive"} <= set(seen_personal["mcp_servers"])
    assert "mcp_servers" not in seen_enterprise
    assert seen_enterprise["model"] == seen_personal["model"]
    assert seen_enterprise["onboarding"] == seen_personal["onboarding"]


@pytest.mark.parametrize("features, kits", [("", True), ("kits", True), ("skills,connectors", False), ("none", False)])
def test_enterprise_policy_turns_the_kits_on_only_when_they_are_open(monkeypatch: pytest.MonkeyPatch, features: str, kits: bool) -> None:
    policy = _manager(monkeypatch, uniwork_server=PLATFORM, client_features=features)._platform_policy()
    assert (policy.get("cloud_kits") == {"enabled": True}) is kits
    assert not (PERSONAL_POLICY_KEYS - {"cloud_kits"}) & set(policy)


@pytest.mark.asyncio
@pytest.mark.parametrize("features, sent", [("", True), ("connectors", True), ("kits,skills", False), ("none", False)])
async def test_enterprise_sends_connector_states_only_when_connectors_are_open(
    monkeypatch: pytest.MonkeyPatch, features: str, sent: bool
) -> None:
    class Store:
        async def connector_states(self, user_id: str) -> list[dict]:
            return [{"profile": "default", "snapshot": {}}]

    manager = _manager(monkeypatch, uniwork_server=PLATFORM, client_features=features)
    manager.store = Store()  # type: ignore[assignment]
    assert bool(await manager._connector_states("ent:T1:u1")) is sent


@pytest.mark.asyncio
@pytest.mark.parametrize("settings, env", [
    ({}, None),
    ({"uniwork_server": PLATFORM}, "MT_ENTERPRISE_FEATURES=connectors,kits,skills"),
    ({"uniwork_server": PLATFORM, "client_features": "none"}, "MT_ENTERPRISE_FEATURES="),
])
async def test_docker_instances_learn_the_open_features_from_the_environment(
    monkeypatch: pytest.MonkeyPatch, settings: dict, env: str | None
) -> None:
    specs: list[dict] = []

    class Docker:
        async def create_container(self, name: str, spec: dict) -> None:
            specs.append(spec)

    manager = _manager(monkeypatch, **settings)
    manager.docker = Docker()  # type: ignore[assignment]
    await manager._create("c", "n", "v", {}, "tok")
    features = [item for item in specs[0]["Env"] if item.startswith("MT_ENTERPRISE_FEATURES=")]
    assert features == ([env] if env else [])


def test_desktop_plugins_read_the_plan_key_only_in_the_personal_edition(monkeypatch: pytest.MonkeyPatch) -> None:
    """联网搜索等桌面插件按桌面的变量名取 MaaS key：普通版与模型用的是同一把，企业版的设备令牌不给它们。"""
    def env_of(manager: TenantManager) -> dict[str, str]:
        text = manager._render_user_files("plan-key")[".env"].decode("utf-8")
        return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)

    personal = _manager(monkeypatch)
    enterprise = _manager(monkeypatch, uniwork_server=PLATFORM)

    seen = env_of(personal)
    assert seen[tenants_module.DESKTOP_MAAS_KEY_ENV] == seen[personal.s.key_env_name] == "plan-key"
    assert tenants_module.DESKTOP_MAAS_KEY_ENV not in env_of(enterprise)


def test_enterprise_mcp_has_no_drive_and_goes_through_the_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    personal = _manager(monkeypatch)._mcp_servers("tok")
    enterprise = _manager(monkeypatch, uniwork_server=PLATFORM)._mcp_servers("tok")

    assert set(personal) == {"Agent-Mail", "UniWork-Drive", YUANJING_MCP_NAME}
    assert set(enterprise) == {YUANJING_MCP_NAME}
    assert enterprise[YUANJING_MCP_NAME]["url"].startswith(f"{PLATFORM}/api/client/yj/")


def test_config_patch_enables_each_side_only(monkeypatch: pytest.MonkeyPatch) -> None:
    personal = _manager(monkeypatch)._config_patch_spec(None, None)
    enterprise = _manager(monkeypatch, uniwork_server=PLATFORM)._config_patch_spec(None, None)

    assert "UniWork-Drive" in personal["mcp_servers"]
    assert "plugins" not in personal
    assert "mcp_servers" not in enterprise
    assert "enabled_plugins" not in enterprise
    assert enterprise["plugins"]["enable"]


@pytest.mark.asyncio
@pytest.mark.parametrize("enterprise", [False, True])
async def test_bootstrap_tells_the_forwarder_only_in_enterprise_mode(monkeypatch: pytest.MonkeyPatch, enterprise: bool) -> None:
    cube = Cube(api_base="http://api.test", proxy_base="http://proxy.test", domain="d.test", api_key="", template="t")
    sent: dict = {}

    async def fake_req(method, sandbox_id, port, path, *, json_body=None, **kwargs):
        sent.update(json_body or {})
        return 200, {"ok": True}

    monkeypatch.setattr(cube, "_tenant_req", fake_req)
    features = ["connectors"] if enterprise else None
    await cube.bootstrap("s1", 9121, token="tok", files=[], enterprise=enterprise, features=features)
    assert sent.get("enterprise", False) is enterprise
    assert sent.get("features") == features


@pytest.mark.skipif(os.name == "nt", reason="要 Linux 的 bash（Windows 上 bash 指到 WSL，路径翻译不了）")
@pytest.mark.parametrize("env, cpu", [
    ("", "1000"),
    ("MT_UNIWORK_SERVER=http://platform.test\n", "2000"),
    ("MT_DEPLOY_TPL_CPU=500\n", "500"),
    ("MT_UNIWORK_SERVER=http://platform.test\nMT_DEPLOY_TPL_CPU=500\n", "500"),
])
def test_template_cpu_defaults_by_edition(tmp_path: Path, env: str, cpu: str) -> None:
    env_file = tmp_path / "entry.env"
    env_file.write_text(env, encoding="utf-8")
    script = (HERE / "deploy.sh").read_text(encoding="utf-8")
    helpers = script[script.index("cfg() {"):script.index("load_cfg() {")]
    line = next(item.strip() for item in script.splitlines() if "TPL_CPU=" in item and "is_enterprise" in item)
    out = subprocess.run(["bash", "-c", f'ENV_FILE="$1"\n{helpers}\n{line}\nprintf %s "$TPL_CPU"', "bash", str(env_file)],
                         capture_output=True, text=True, check=True)
    assert out.stdout == cpu


def test_deploy_script_skips_the_kits_only_when_the_enterprise_turned_them_off() -> None:
    script = (HERE / "deploy.sh").read_text(encoding="utf-8")
    # 入口的 Dockerfile 要 COPY .kits-runtime：不要套件时不拉配置仓库，但目录得在
    assert 'if ! needs_kits; then mkdir -p "$HERE/.kits-runtime"; return 0; fi' in script[script.index("ensure_kits() {"):]
    assert '! needs_kits || cat "$HERE/.kits-runtime/.fingerprint"' in script
    assert "is_enterprise ||" not in script[script.index("stage_overlay() {"):script.index("# ---", script.index("stage_overlay() {"))]
    assert "COPY deploy/hermes-mt/.kits-runtime/" in (HERE / "entry" / "Dockerfile").read_text(encoding="utf-8")


@pytest.mark.skipif(os.name == "nt", reason="要 Linux 的 bash（Windows 上 bash 指到 WSL，路径翻译不了）")
@pytest.mark.parametrize("env, needs", [
    ("", True),
    ("MT_CLIENT_FEATURES=none\n", True),  # 个人版不看它
    ("MT_UNIWORK_SERVER=http://platform.test\n", True),
    ("MT_UNIWORK_SERVER=http://platform.test\nMT_CLIENT_FEATURES=connectors, kits\n", True),
    ("MT_UNIWORK_SERVER=http://platform.test\nMT_CLIENT_FEATURES=skills,connectors\n", False),
    ("MT_UNIWORK_SERVER=http://platform.test\nMT_CLIENT_FEATURES=none\n", False),
])
def test_needs_kits_follows_the_client_features(tmp_path: Path, env: str, needs: bool) -> None:
    env_file = tmp_path / "entry.env"
    env_file.write_text(env, encoding="utf-8")
    script = (HERE / "deploy.sh").read_text(encoding="utf-8")
    helpers = script[script.index("cfg() {"):script.index("load_cfg() {")]
    out = subprocess.run(["bash", "-c", f'ENV_FILE="$1"\n{helpers}\nif needs_kits; then printf yes; else printf no; fi', "bash", str(env_file)],
                         capture_output=True, text=True, check=True)
    assert out.stdout == ("yes" if needs else "no")
