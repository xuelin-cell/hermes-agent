"""技能目录通过真实应用路由访问本地上游，回归合并遗漏。"""
import json
import io
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi.testclient import TestClient


def test_catalog_routes_reach_upstream(tmp_path, monkeypatch):
    """挂载真实应用验证全部目录入口，不读取用户配置或外部凭据。"""
    from hermes_cli import web_server
    app = web_server.app
    from hermes_cli.web_routers import skill_market

    paths = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            """提供真实 HTTP 夹具并记录转发路径。"""
            paths.append(self.path)
            body = json.dumps({"code": 0, "data": {"list": [{"id": "fixture"}]}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            """避免夹具输出请求噪声。"""

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(skill_market, "MARKET_BASE", base)
    monkeypatch.setattr(skill_market, "RECOMMENDED_BASE", base)
    try:
        with TestClient(app, headers={"Authorization": "Bearer " + web_server._SESSION_TOKEN}) as client:
            for route in ["market/categories", "market/list", "recommended/categories", "recommended/list"]:
                response = client.get("/api/skills/" + route)
                assert response.status_code == 200
                assert response.json() == {"list": [{"id": "fixture"}]}
        assert len(paths) == 4
        assert paths[1].startswith("/api/skills/list?")
        assert paths[3] == "/uniwork/recommended-skills"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_install_refuses_insecure_url():
    """不安全地址不能进入真实后台安装链。"""
    from hermes_cli import web_server
    with TestClient(web_server.app, headers={"Authorization": "Bearer " + web_server._SESSION_TOKEN}) as client:
        result = client.post("/api/skills/market/install", json={"id": "fixture", "download_url": "http://127.0.0.1/private"})
        assert result.status_code == 400


def _skill_zip(files):
    """创建内存 ZIP，供安装链测试使用。"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


def test_zip_bundle_strips_wrapper_and_uses_frontmatter_name():
    """市场 ZIP 的外层目录不会成为技能名，名称以 SKILL.md 为准。"""
    from hermes_cli.skill_market_install import bundle_from_zip

    bundle = bundle_from_zip(_skill_zip({
        "download/SKILL.md": "---\nname: office-writer\ndescription: fixture\n---\n# Writer\n",
        "download/references/guide.md": "guide",
        "download/examples/sub-skill/SKILL.md": "---\nname: example-only\n---\n# Example\n",
    }), "market-id", "https://maas.ai-yuanjing.com/package")

    assert bundle.name == "office-writer"
    assert set(bundle.files) == {"SKILL.md", "references/guide.md", "examples/sub-skill/SKILL.md"}


def test_zip_bundle_rejects_multiple_peer_skill_roots():
    """没有唯一上层主入口的多技能合集不能被误装成其中任意一个技能。"""
    import pytest
    from hermes_cli.skill_market_install import MarketSkillInstallError, bundle_from_zip

    package = _skill_zip({
        "first/SKILL.md": "---\nname: first\n---\n",
        "second/SKILL.md": "---\nname: second\n---\n",
    })
    with pytest.raises(MarketSkillInstallError, match="多个并列"):
        bundle_from_zip(package, "market-id", "https://maas.ai-yuanjing.com/package")


def test_zip_bundle_rejects_path_traversal():
    """ZIP 路径穿越在写入隔离区之前即被拒绝。"""
    import pytest
    from hermes_cli.skill_market_install import MarketSkillInstallError, bundle_from_zip

    package = _skill_zip({
        "skill/SKILL.md": "---\nname: safe-skill\n---\n",
        "../outside.txt": "unsafe",
    })
    with pytest.raises(MarketSkillInstallError, match="不安全"):
        bundle_from_zip(package, "market-id", "https://maas.ai-yuanjing.com/package")


def test_install_route_returns_completed_install(monkeypatch):
    """安装接口等待安装链完成并把最终结果返回前端。"""
    from hermes_cli import web_server
    from hermes_cli.web_routers import skill_market

    calls = []

    def install(url, identifier, profile):
        """记录路由传给同步安装链的参数。"""
        calls.append((url, identifier, profile))
        return {"ok": True, "name": "office-writer", "install_path": "skills/office-writer"}

    monkeypatch.setattr(skill_market, "install_market_skill", install)
    with TestClient(web_server.app, headers={"Authorization": "Bearer " + web_server._SESSION_TOKEN}) as client:
        result = client.post("/api/skills/market/install?profile=work", json={
            "id": "fixture",
            "name": "智能写作",
            "download_url": "/uniwork/skills/fixture/package",
        })

    assert result.status_code == 200
    assert result.json()["name"] == "office-writer"
    assert calls == [("https://maas.ai-yuanjing.com/app/gateway/uniwork/skills/fixture/package", "fixture", "work")]


def test_install_route_accepts_fixed_market_package_host(monkeypatch):
    """市场目录公布的固定包托管域名可以进入相同安全安装链。"""
    from hermes_cli import web_server
    from hermes_cli.web_routers import skill_market

    monkeypatch.setattr(
        skill_market,
        "install_market_skill",
        lambda _url, _identifier, _profile: {"ok": True, "name": "fixture", "install_path": "fixture"},
    )
    with TestClient(web_server.app, headers={"Authorization": "Bearer " + web_server._SESSION_TOKEN}) as client:
        result = client.post("/api/skills/market/install", json={
            "id": "fixture",
            "download_url": "https://wry-manatee-359.convex.site/api/v1/download?slug=fixture",
        })

    assert result.status_code == 200


def test_market_download_follows_only_allowed_redirects(monkeypatch):
    """市场代理跳转到 ClawHub 后仍能下载，但不能跳转到任意主机。"""
    import httpx
    import pytest
    from hermes_cli import skill_market_install

    package = _skill_zip({"fixture/SKILL.md": "---\nname: fixture\n---\n# Fixture"})

    def handler(request):
        """模拟市场当前使用的 307 下载链。"""
        if request.url.host == "wry-manatee-359.convex.site":
            return httpx.Response(307, headers={"Location": "https://clawhub.ai/api/v1/download"})
        return httpx.Response(200, content=package, headers={"Content-Type": "application/zip"})

    real_client = httpx.Client
    monkeypatch.setattr(
        skill_market_install.httpx,
        "Client",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )
    result = skill_market_install.download_skill_package(
        "https://wry-manatee-359.convex.site/api/v1/download?slug=fixture"
    )
    assert result == package

    def unsafe_handler(_request):
        """模拟服务端把下载请求导向未授权主机。"""
        return httpx.Response(307, headers={"Location": "https://example.com/private"})

    monkeypatch.setattr(
        skill_market_install.httpx,
        "Client",
        lambda **kwargs: real_client(transport=httpx.MockTransport(unsafe_handler), **kwargs),
    )
    with pytest.raises(skill_market_install.MarketSkillInstallError, match="HTTPS 服务"):
        skill_market_install.download_skill_package(
            "https://wry-manatee-359.convex.site/api/v1/download?slug=fixture"
        )


def test_market_package_runs_real_scan_and_install_chain(tmp_path, monkeypatch):
    """真实隔离、扫描和落盘链能把安全市场包安装到指定用户目录。"""
    from hermes_cli import skill_market_install

    home = tmp_path / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(home))
    package = _skill_zip({
        "office-writer/SKILL.md": (
            "---\nname: office-writer\ndescription: Helps write office documents.\n---\n"
            "# Office Writer\nUse the user's requirements to draft a document.\n"
            "Example: `printenv DB_PASSWORD` after the user approves secret access.\n"
        ),
    })
    monkeypatch.setattr(skill_market_install, "download_skill_package", lambda _url: package)

    result = skill_market_install.install_market_skill(
        "https://maas.ai-yuanjing.com/app/gateway/uniwork/skills/fixture/package", "fixture"
    )

    assert result["ok"] is True
    assert result["name"] == "office-writer"
    assert (home / "skills" / "office-writer" / "SKILL.md").is_file()
