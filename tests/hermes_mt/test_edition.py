"""同一份代码两种部署：配了 MT_UNIWORK_SERVER 是企业版，普通版的东西不出现；没配的普通版不受影响。"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml
from cryptography.fernet import Fernet

from entry import tenants as tenants_module
from entry.app import build_app
from entry.config import Settings
from entry.cube_api import Cube
from entry.tenants import PERSONAL_POLICY_KEYS, YUANJING_MCP_NAME, TenantManager

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
    enterprise = _routes(uniwork_server=PLATFORM)
    gone = personal - enterprise
    for route in ("drive/{operation}", "mail", "plan/{operation}", "account/{operation}", "connectors",
                  "messaging/{operation}", "skills/{operation}", "welcome/{locale}", "maas-auth", "browser-auth.js"):
        assert f"/agents/api/__entry/{route}" in gone
    assert not enterprise - personal
    for shared in ("/agents/login", "/agents/api/__entry/me", "/agents/api/__entry/login", "/agents/api/__entry/select-tenant",
                   "/agents/api/__entry/enterprise", "/agents/api/ws", "/agents/api/__hermes_backend/{tail}",
                   "/hermes/__entry/service/v1/runtimes"):
        assert shared in enterprise


def test_policy_and_seeded_config_leave_out_personal_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    personal = _manager(monkeypatch)
    enterprise = _manager(monkeypatch, uniwork_server=PLATFORM)

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
    await cube.bootstrap("s1", 9121, token="tok", files=[], enterprise=enterprise)
    assert sent.get("enterprise", False) is enterprise


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


def test_deploy_script_does_not_need_kits_for_the_enterprise_edition() -> None:
    script = (HERE / "deploy.sh").read_text(encoding="utf-8")
    # 入口的 Dockerfile 要 COPY .kits-runtime：企业版不拉配置仓库，但目录得在
    assert 'if is_enterprise; then mkdir -p "$HERE/.kits-runtime"; return 0; fi' in script[script.index("ensure_kits() {"):]
    assert 'is_enterprise || cat "$HERE/.kits-runtime/.fingerprint"' in script
    assert "COPY deploy/hermes-mt/.kits-runtime/" in (HERE / "entry" / "Dockerfile").read_text(encoding="utf-8")
