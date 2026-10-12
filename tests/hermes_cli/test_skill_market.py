"""技能目录通过真实应用路由访问本地上游，回归合并遗漏。"""
import json
import threading
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
