"""供网络回归与真实 Agent 复用的独立本机生成服务。"""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time


@contextmanager
def serving(payloads=None):
    """只提供独立本机响应，包含正常、重定向、超大、慢流和失败情况。"""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        """用真实 HTTP 而非模拟客户端验证网络与流式清理。"""

        def log_message(self, *args):
            """夹具不输出签名链接或无关访问日志。"""

        def do_GET(self):
            """按路径返回受控字节，不访问外网或磁盘用户文件。"""
            requests.append(self.path)
            if payloads is not None and self.path.split("?", 1)[0] in payloads:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(payloads[self.path.split("?", 1)[0]])
                return
            if self.path.startswith("/redirect"):
                self.send_response(302)
                self.send_header("Location", "/image.png")
                self.end_headers()
                return
            if self.path.startswith("/bad-redirect"):
                self.send_response(302)
                self.send_header("Location", "file:///secret.png")
                self.end_headers()
                return
            self.send_response(500 if self.path.startswith("/failure") else 200)
            if self.path.startswith("/declared"):
                self.send_header("Content-Length", str(33 * 1024 * 1024))
            self.end_headers()
            if self.path.startswith("/empty"):
                return
            try:
                count = 40 if self.path.startswith(("/stream", "/slow")) else 1
                for _ in range(count):
                    self.wfile.write(
                        b"x"
                        if self.path.startswith("/slow")
                        else b"file-content" * 1000
                    )
                    self.wfile.flush()
                    if self.path.startswith("/slow"):
                        time.sleep(0.5)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
