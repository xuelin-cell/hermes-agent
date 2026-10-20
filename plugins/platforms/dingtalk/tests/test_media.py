"""钉钉正式附件入口检查；所有上游响应受控，不访问真实平台或模型。"""

import json
import os
from pathlib import Path
import time
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio

# 在导入适配器前建立仓库的临时 Home，并复用原有安全夹具。
import tests.conftest  # noqa: F401
from dingtalk_stream import ChatbotMessage, Credential, DingTalkStreamClient

from gateway.config import PlatformConfig
from gateway.platforms.base import SendResult
from plugins.platforms.dingtalk.adapter import DingTalkAdapter

pytest_plugins = ("tests.conftest",)


@pytest.fixture
def delivery():
    """真实 HTTP 序列化配受控传输，SDK 只读取本账号缓存的测试 Token。"""
    requests, clients, responses = [], [], {}

    def respond(request):
        """记录真正构造的上传和发送请求；不回显任何用户凭据。"""
        requests.append(request)
        stage = "upload" if request.url.path == "/media/upload" else "send"
        value = responses.get(stage)
        if isinstance(value, Exception):
            raise value
        if isinstance(value, httpx.Response):
            return value
        status, body = value or (200, {"errcode": 0, "media_id": "@fixture-media"} if stage == "upload"
                                else {"processQueryKey": "fixture-receipt"})
        if isinstance(body, bytes):
            return httpx.Response(status, content=body)
        return httpx.Response(status, json=body)

    def make(label="a", group=False, *, extra=None):
        """只准备插件现有依赖和原版入站上下文，不启动网关。"""
        adapter = DingTalkAdapter(PlatformConfig(enabled=True, extra=extra if extra is not None else {
            "client_id": f"app-{label}", "client_secret": f"secret-{label}",
        }))
        adapter._http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)
        clients.append(adapter._http_client)
        adapter._stream_client = DingTalkStreamClient(Credential(adapter._client_id, adapter._client_secret))
        adapter._stream_client._access_token = {"accessToken": f"token-{label}", "expireTime": int(time.time()) + 3600}
        message = ChatbotMessage.from_dict({
            "msgId": f"inbound-{label}", "conversationId": f"cid-{label}", "conversationType": "2" if group else "1",
            "senderId": f"encrypted-{label}", "senderStaffId": f"staff-{label}", "robotCode": adapter._robot_code,
            "msgtype": "text", "text": {"content": "请发送附件"},
            "sessionWebhook": "https://oapi.dingtalk.com/robot/send?access_token=fixture-webhook",
        })
        adapter._message_contexts[f"cid-{label}"] = message
        return adapter, message

    yield make, requests, responses, clients


@pytest_asyncio.fixture(autouse=True)
async def close_clients(delivery):
    """每个测试关闭自己创建的 HTTP 客户端，不影响其它进程。"""
    yield
    for client in delivery[3]:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("group", [False, True])
@pytest.mark.parametrize("image", [False, True])
async def test_local_media_uses_native_upload_and_correct_recipient(delivery, tmp_path, group, image):
    """本地图片和文件从正式发送入口上传，单聊和群聊绝不混用目标 ID。"""
    make, requests, _, _ = delivery
    adapter, _ = make(group=group)
    file = tmp_path / ("结果.png" if image else "报告.pdf")
    file.write_bytes(b"fixture-document-bytes")
    method = adapter.send_image_file if image else adapter.send_document
    result = await method("cid-a", str(file))
    assert result.success, result.error
    assert result.message_id == "fixture-receipt"
    assert len(requests) == 2
    upload, send = requests
    assert upload.url.host == "oapi.dingtalk.com"
    assert dict(upload.url.params) == {"access_token": "token-a", "type": "image" if image else "file"}
    assert b'name="media"' in upload.content
    assert file.name.encode() in upload.content
    assert b"fixture-document-bytes" in upload.content
    assert send.headers["x-acs-dingtalk-access-token"] == "token-a"
    body = json.loads(send.content)
    assert body["robotCode"] == "app-a"
    assert body["msgKey"] == ("sampleImageMsg" if image else "sampleFile")
    params = json.loads(body["msgParam"])
    assert params == ({"photoURL": "@fixture-media"} if image else {
        "mediaId": "@fixture-media", "fileName": "报告.pdf", "fileType": "pdf"})
    assert send.url.path == ("/v1.0/robot/groupMessages/send" if group else "/v1.0/robot/oToMessages/batchSend")
    assert body.get("openConversationId") == ("cid-a" if group else None)
    assert body.get("userIds") == (None if group else ["staff-a"])
    assert "encrypted-a" not in send.content.decode()


@pytest.mark.asyncio
async def test_profile_a_b_a_keeps_credentials_and_tokens_owned(delivery, tmp_path):
    """真实秘密作用域创建两套适配器，交错发送仍使用各自机器人和 Token。"""
    from agent.secret_scope import reset_secret_scope, set_multiplex_active, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    make, requests, _, _ = delivery
    adapters = []
    set_multiplex_active(True)
    try:
        for name in ["a", "b"]:
            home = tmp_path / name
            home.mkdir()
            home_token = set_hermes_home_override(str(home))
            secret_token = set_secret_scope({"DINGTALK_CLIENT_ID": f"app-{name}", "DINGTALK_CLIENT_SECRET": f"secret-{name}"})
            try:
                adapters.append(make(name, extra={})[0])
            finally:
                reset_secret_scope(secret_token)
                reset_hermes_home_override(home_token)
        file = tmp_path / "report.pdf"
        file.write_bytes(b"same-safe-file")
        for index in [0, 1, 0]:
            result = await adapters[index].send_document(f"cid-{'ab'[index]}", str(file))
            assert result.success, result.error
    finally:
        set_multiplex_active(False)
    assert [json.loads(request.content)["robotCode"] for request in requests[1::2]] == ["app-a", "app-b", "app-a"]
    assert [request.url.params["access_token"] for request in requests[::2]] == ["token-a", "token-b", "token-a"]
    assert [adapter._stream_client.credential.client_secret for adapter in adapters] == ["secret-a", "secret-b"]


@pytest.mark.asyncio
@pytest.mark.parametrize("stage,status,body", [
    ("upload", 403, {"message": "PRIVATE-token-a-secret-a"}),
    ("upload", 429, {}),
    ("upload", 200, {"errcode": 40014, "errmsg": "PRIVATE-token-a"}),
    ("upload", 200, {}),
    ("upload", 200, b"not-json PRIVATE-token-a"),
    ("send", 400, {"code": "resource.not.found", "message": "PRIVATE-token-a"}),
    ("send", 200, {"code": "Forbidden", "message": "PRIVATE-token-a"}),
    ("send", 200, {"processQueryKey": "q", "invalidStaffIdList": ["staff-a"]}),
    ("send", 200, {"processQueryKey": "q", "flowControlledStaffIdList": ["staff-a"]}),
    ("send", 200, {}),
    ("send", 200, []),
])
async def test_api_rejection_is_failure_without_retry_or_secret_echo(delivery, tmp_path, caplog, stage, status, body):
    """上传成功不等于投递成功；错误不回显上游正文，也不自动重发。"""
    make, requests, responses, _ = delivery
    adapter, _ = make()
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    responses[stage] = (status, body)
    result = await adapter.send_document("cid-a", str(file))
    assert not result.success
    assert result.error
    assert not result.retryable
    assert len(requests) == (1 if stage == "upload" else 2)
    for secret in ["PRIVATE", "token-a", "secret-a", str(tmp_path)]:
        assert secret not in result.error + caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["context", "staff_id", "conversation", "type"])
async def test_missing_recipient_does_not_guess_or_upload(delivery, tmp_path, missing):
    """缺少可信收件上下文时先拒绝，不把聊天 ID 或加密发信人 ID 当员工 ID。"""
    make, requests, _, _ = delivery
    adapter, message = make()
    if missing == "context":
        adapter._message_contexts.clear()
    elif missing == "staff_id":
        message.sender_staff_id = None
    elif missing == "conversation":
        message.conversation_id = "other-chat"
    else:
        message.conversation_type = "unknown"
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    result = await adapter.send_document("cid-a", str(file), metadata={"userIds": ["wrong-user"]})
    assert not result.success
    assert not requests


@pytest.mark.asyncio
async def test_gateway_delivery_uses_plugin_entries_and_keeps_existing_inbound(delivery, tmp_path):
    """原版附件分发实际调用新入口，原版入站解析、文字及远程图片入口保留。"""
    make, requests, _, _ = delivery
    adapter, message = make()
    adapter._message_contexts.clear()
    adapter.handle_message = AsyncMock()
    await adapter._on_message(message)
    event = adapter.handle_message.call_args.args[0]
    assert event.text == "请发送附件"
    assert event.source.chat_id == "cid-a"
    assert event.source.user_id_alt == "staff-a"
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    outcomes = []
    await adapter._deliver_media_attachments(event, [], [str(file)], force_document_attachments=False,
                                            human_delay=0, metadata={}, record_delivery=outcomes.append)
    assert len(outcomes) == 1 and outcomes[0].success
    image = tmp_path / "image.png"
    image.write_bytes(b"image")
    assert (await adapter.send_multiple_images("cid-a", [(image.as_uri(), "")])).success
    adapter.send = AsyncMock(return_value=SendResult(success=True))
    assert (await adapter.send_image("cid-a", "https://example.com/image.png", caption="图片说明")).success
    adapter.send.assert_awaited_once()
    assert "https://example.com/image.png" in adapter.send.call_args.kwargs["content"]
    assert len(requests) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["missing", "directory", "empty", "large", "secret", "no_suffix", "not_image"])
async def test_bad_file_fails_before_credentials_and_network(delivery, tmp_path, case):
    """不存在、空文件、大小、格式及原版凭据路径限制都在上传前生效。"""
    make, requests, _, _ = delivery
    adapter, _ = make()
    adapter._get_access_token = AsyncMock(return_value="token-a")
    file = tmp_path / "file.pdf"
    if case == "directory":
        file.mkdir()
    elif case == "secret":
        file = Path(os.environ["HERMES_HOME"]) / ".env"
        file.write_text("PRIVATE_CREDENTIAL=fixture-only", encoding="utf-8")
    elif case == "large":
        with file.open("wb") as stream:
            stream.truncate(20_000_001)
    elif case != "missing":
        file = tmp_path / "no-extension" if case == "no_suffix" else file
        file.write_bytes(b"" if case == "empty" else b"document")
    method = adapter.send_image_file if case == "not_image" else adapter.send_document
    result = await method("cid-a", str(file))
    assert not result.success
    assert not requests
    adapter._get_access_token.assert_not_awaited()
    assert str(file) not in result.error


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["upload", "send"])
async def test_timeout_does_not_retry_an_uncertain_delivery(delivery, tmp_path, stage):
    """读超时可能发生在服务端收件之后，不能盲目重发或切换另一种消息。"""
    make, requests, responses, _ = delivery
    adapter, _ = make()
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    responses[stage] = httpx.ReadTimeout("PRIVATE-token-a-secret-a")
    result = await adapter.send_document("cid-a", str(file))
    assert not result.success and not result.retryable
    assert "超时" in result.error and "重复" in result.error
    assert "PRIVATE" not in result.error
    assert len(requests) == (1 if stage == "upload" else 2)


@pytest.mark.asyncio
async def test_redirect_never_carries_token_or_file_to_another_host(delivery, tmp_path):
    """即使现有客户端允许重定向，附件入口仍明确禁止。"""
    make, requests, responses, _ = delivery
    adapter, _ = make()
    adapter._http_client.follow_redirects = True
    responses["upload"] = httpx.Response(307, headers={"Location": "https://foreign.example/collect"})
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    assert not (await adapter.send_document("cid-a", str(file))).success
    assert len(requests) == 1
    assert requests[0].url.host == "oapi.dingtalk.com"


@pytest.mark.asyncio
async def test_display_filename_and_caption_do_not_hide_partial_failure(delivery, tmp_path):
    """显示名不能带本机目录，说明失败不冒充附件失败或自动重复上传。"""
    make, requests, responses, _ = delivery
    adapter, _ = make()
    file = tmp_path / "source.pdf"
    file.write_bytes(b"document")
    adapter.send = AsyncMock(return_value=SendResult(success=False, error="PRIVATE-caption-error"))
    result = await adapter.send_document("cid-a", str(file), file_name=r"C:\private\中文报告.pdf", caption="说明")
    assert not result.success and result.raw_response == {"attachment_sent": True}
    assert result.message_id == "fixture-receipt"
    assert "PRIVATE" not in result.error
    assert len(requests) == 2
    assert json.loads(json.loads(requests[1].content)["msgParam"])["fileName"] == "中文报告.pdf"
    assert "中文报告.pdf".encode() in requests[0].content
    responses["upload"] = (403, {})
    adapter.send.return_value = SendResult(success=True)
    assert not (await adapter.send_document("cid-a", str(file), caption="文件失败也保留文字")).success
    assert adapter.send.call_args.args[1] == "文件失败也保留文字"


@pytest.mark.asyncio
async def test_missing_token_and_disconnected_client_do_not_upload(delivery, tmp_path):
    """断开状态和取 Token 失败只返回附件失败，不寻找其它账号凭据。"""
    make, requests, _, _ = delivery
    adapter, _ = make()
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    adapter._get_access_token = AsyncMock(return_value=None)
    assert not (await adapter.send_document("cid-a", str(file))).success
    adapter._get_access_token = AsyncMock(side_effect=TimeoutError("PRIVATE-token-a"))
    timeout = await adapter.send_document("cid-a", str(file))
    assert not timeout.success and "超时" in timeout.error and "PRIVATE" not in timeout.error
    adapter._http_client = None
    assert not (await adapter.send_image_file("cid-a", str(file))).success
    assert not requests


@pytest.mark.asyncio
async def test_discovered_platform_factory_delivers_through_the_new_entry(delivery, tmp_path):
    """通过原版插件发现和注册工厂创建适配器，防止新增能力未进入正式插件。"""
    from gateway.platform_registry import platform_registry
    from hermes_cli.plugins import discover_plugins

    discover_plugins(force=True)
    make, requests, _, _ = delivery
    transport, _ = make()
    adapter = platform_registry.create_adapter("dingtalk", PlatformConfig(enabled=True, extra={
        "client_id": "app-a", "client_secret": "secret-a"}))
    assert adapter is not None
    adapter._http_client = transport._http_client
    adapter._stream_client = transport._stream_client
    adapter._message_contexts = transport._message_contexts
    file = tmp_path / "report.pdf"
    file.write_bytes(b"document")
    result = await adapter.send_document("cid-a", str(file))
    assert result.success, result.error
    assert len(requests) == 2
