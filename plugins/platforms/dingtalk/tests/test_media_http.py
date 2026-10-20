"""真实本机 HTTP 与 SDK Token 交换；不是钉钉服务端或客户端渲染验收。"""

import asyncio
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import httpx
import pytest

import tests.conftest  # noqa: F401
from dingtalk_stream import ChatbotMessage, Credential, DingTalkStreamClient
import dingtalk_stream.stream as stream_sdk

from gateway.config import PlatformConfig
from plugins.platforms.dingtalk.adapter import DingTalkAdapter
from plugins.platforms.dingtalk import media

pytest_plugins = ("tests.conftest",)


class Handler(BaseHTTPRequestHandler):
    """只监听测试随机本地端口，模拟三种固定官方接口。"""

    def do_POST(self):  # noqa: N802
        """记录真实请求字节，返回测试 Token、媒体 ID 或投递回执。"""
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.events.append((self.path, dict(self.headers), body))
        if self.path.endswith("/oauth2/accessToken"):
            label = json.loads(body)["appKey"].removeprefix("app-")
            result = {"accessToken": f"token-{label}", "expireIn": 7200}
        elif self.path.startswith("/media/upload"):
            result = {"errcode": 0, "media_id": "@raw-media-id"}
        else:
            result = {"processQueryKey": "wire-receipt"}
        status = 403 if self.server.reject and "/robot/" in self.path else 200
        data = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        """测试不把带 Token 的请求路径写到标准错误。"""


@pytest.mark.asyncio
async def test_real_sdk_token_upload_and_send_over_loopback_a_b_a(tmp_path, monkeypatch):
    """真正经过 SDK、HTTP 字节、上传和投递，核对 A→B→A 缓存与失败传播。"""
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.events, server.reject = [], False
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(stream_sdk, "DINGTALK_OPENAPI_ENDPOINT", base)
    monkeypatch.setattr(media, "UPLOAD_URL", base + "/media/upload")
    monkeypatch.setattr(media, "DM_URL", base + "/v1.0/robot/oToMessages/batchSend")
    monkeypatch.setattr(media, "GROUP_URL", base + "/v1.0/robot/groupMessages/send")
    adapters = []
    try:
        for label, group in [("a", False), ("b", True)]:
            adapter = DingTalkAdapter(PlatformConfig(enabled=True, extra={
                "client_id": f"app-{label}", "client_secret": f"secret-{label}"}))
            adapter._http_client = httpx.AsyncClient(trust_env=False)
            adapter._stream_client = DingTalkStreamClient(Credential(adapter._client_id, adapter._client_secret))
            adapter._message_contexts[f"cid-{label}"] = ChatbotMessage.from_dict({
                "conversationId": f"cid-{label}", "conversationType": "2" if group else "1",
                "senderStaffId": f"staff-{label}", "senderId": f"encrypted-{label}",
            })
            adapters.append(adapter)
        pdf, image = tmp_path / "中文报告.pdf", tmp_path / "图片.png"
        pdf.write_bytes(b"%PDF-fixture-bytes")
        image.write_bytes(b"\x89PNG\r\n\x1a\nfixture-bytes")
        for index in [0, 1, 0]:
            method = adapters[index].send_image_file if index else adapters[index].send_document
            result = await method(f"cid-{'ab'[index]}", str(image if index else pdf))
            assert result.success, result.error
            assert result.message_id == "wire-receipt"
        token_requests = [event for event in server.events if "/oauth2/" in event[0]]
        assert [json.loads(event[2]) for event in token_requests] == [
            {"appKey": "app-a", "appSecret": "secret-a"}, {"appKey": "app-b", "appSecret": "secret-b"}]
        uploads = [event for event in server.events if event[0].startswith("/media/upload")]
        sends = [event for event in server.events if "/robot/" in event[0]]
        assert len(uploads) == len(sends) == 3
        for (url, headers, body), source, label in zip(uploads, [pdf, image, pdf], ["a", "b", "a"]):
            assert f"access_token=token-{label}" in url
            message = BytesParser(policy=policy.default).parsebytes(
                ("Content-Type: " + headers["Content-Type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
            parts = list(message.iter_parts())
            assert len(parts) == 1
            assert parts[0].get_param("name", header="content-disposition") == "media"
            assert parts[0].get_filename() == source.name
            assert parts[0].get_payload(decode=True) == source.read_bytes()
        for (url, headers, body), label in zip(sends, ["a", "b", "a"]):
            data = json.loads(body)
            assert headers["x-acs-dingtalk-access-token"] == f"token-{label}"
            assert data["robotCode"] == f"app-{label}"
            assert data.get("userIds") == (["staff-a"] if label == "a" else None)
            assert data.get("openConversationId") == ("cid-b" if label == "b" else None)
            assert json.loads(data["msgParam"]).get("mediaId", json.loads(data["msgParam"]).get("photoURL")) == "@raw-media-id"
        server.reject = True
        rejected = await adapters[0].send_document("cid-a", str(pdf))
        assert not rejected.success and not rejected.retryable
        assert len(server.events) == 10  # 两次取 Token，四次上传与四次投递，无重发。
    finally:
        for adapter in adapters:
            await adapter._http_client.aclose()
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        worker.join(timeout=3)
