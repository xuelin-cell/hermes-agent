"""对外路径的约定：页面在 /agents/，接口都在 /agents/api/（统一登录的网关只对这个前缀验登录），平台的服务接口不动。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from entry.app import build_app
from entry.config import Settings
from entry.service import RUNTIMES_PATH

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "deploy" / "hermes-mt"
PLATFORM = "http://platform.test"
PAGES = {"/agents/login", "/agents/logout"}


def _routes(**settings) -> set[str]:
    app = build_app(Settings(credential_key=Fernet.generate_key().decode(), database_url="postgresql://unused/db", **settings))
    return {resource.canonical for resource in app.router.resources()}


@pytest.mark.parametrize("settings", [{}, {"uniwork_server": PLATFORM}], ids=["personal", "enterprise"])
def test_every_route_but_the_pages_and_the_service_api_is_under_agents_api(settings: dict) -> None:
    routes = _routes(**settings)
    assert PAGES <= routes
    for route in routes - PAGES:
        if not route.startswith(RUNTIMES_PATH):
            assert route.startswith("/agents/api/"), route


def test_the_service_api_does_not_follow_the_page_path() -> None:
    # 平台配置里存的是这个地址，改了要平台同步改配置。
    assert RUNTIMES_PATH == "/hermes/__entry/service/v1/runtimes"
    assert RUNTIMES_PATH in _routes(base_path="/elsewhere", uniwork_server=PLATFORM)
    assert RUNTIMES_PATH in _routes(uniwork_server=PLATFORM)


def test_internal_callers_use_paths_the_entry_serves() -> None:
    routes = _routes()
    nginx = (HERE / "nginx" / "hermes-mt.conf").read_text(encoding="utf-8")
    auth = re.search(r"location = /__entry_auth \{.*?proxy_pass http://entry:9400(\S+);", nginx, re.S)
    assert auth and auth.group(1) in routes
    for name in ("compose.yaml", "compose.isolated.yaml"):
        health = re.findall(r"http://127\.0\.0\.1:9400(/[^']+)'", (HERE / name).read_text(encoding="utf-8"))
        assert health and set(health) <= routes, name
    deploy = re.findall(r"http://entry:9400(/\S+)", (HERE / "deploy.sh").read_text(encoding="utf-8"))
    assert deploy and set(deploy) <= routes


def test_the_frontend_is_built_and_served_at_the_same_path() -> None:
    package = (ROOT / "apps" / "desktop" / "package.json").read_text(encoding="utf-8")
    build = (HERE / "scripts" / "build-frontend.sh").read_text(encoding="utf-8")
    for text in (package, build):
        assert "--base=/agents/" in text
        assert "--base=/hermes" not in text
    assert "/usr/share/nginx/html/agents/" in (HERE / "nginx" / "Dockerfile").read_text(encoding="utf-8")
    nginx = (HERE / "nginx" / "hermes-mt.conf").read_text(encoding="utf-8")
    assert re.findall(r"alias (\S+);", nginx) == ["/usr/share/nginx/html/agents/assets/", "/usr/share/nginx/html/agents/"]


def test_the_browser_login_is_stored_and_read_under_the_api_prefix() -> None:
    # requestEntryMaas 拿同一个 base 拼接口地址、读登录凭据，所以登录凭据只能按接口前缀存；按页面路径读就读不到。
    static = HERE / "entry" / "entry" / "static"
    personal = (static / "login-personal.html").read_text(encoding="utf-8")
    assert "var apiBase = base + '/api';" in personal
    assert "storeBrowserLogin(apiBase, data)" in personal
    assert "storeBrowserLogin(base" not in personal
    assert "from './api/__entry/browser-auth.js'" in personal
    assert "base + '/api/__entry'" in (static / "login.html").read_text(encoding="utf-8")
    sources = (ROOT / "apps" / "desktop" / "src").rglob("*.ts*")
    readers = [source for source in sources if "readBrowserAuth(import.meta.env.BASE_URL" in source.read_text(encoding="utf-8")]
    assert not readers


def test_the_login_page_copy_of_the_browser_auth_module_is_current() -> None:
    shared = (ROOT / "apps" / "shared" / "src" / "browser-maas-auth.js").read_text(encoding="utf-8")
    copy = (HERE / "entry" / "entry" / "static" / "browser-auth.js").read_text(encoding="utf-8")
    assert copy == "// Generated from apps/shared/src/browser-maas-auth.js by build-frontend.sh.\n" + shared
