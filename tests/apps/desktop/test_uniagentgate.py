"""UniWork 5G plugin: real discovery/config/secrets/HTTP/WS and Hermes text delivery.

No production credentials, model calls, SMS or mocked transport imports.
"""

import asyncio
from contextlib import contextmanager
import importlib
import json
import logging
from pathlib import Path
import socket
import subprocess

import pytest
import pytest_asyncio
import uvicorn

from agent.secret_scope import (
    build_profile_secret_scope, is_multiplex_active, reset_secret_scope,
    set_multiplex_active, set_secret_scope,
)
from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override


ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def bundled_tree(tmp_path_factory):
    out = tmp_path_factory.mktemp("desktop-plugin-build")
    subprocess.run(["node", str(ROOT / "apps/desktop/scripts/stage-python-plugins.mjs"),
                    "--source", str(ROOT), "--out", str(out)], check=True, capture_output=True, timeout=60)
    return out / "python-plugins"


@pytest.fixture(autouse=True)
def bundled_plugins(bundled_tree, monkeypatch):
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled_tree))


@contextmanager
def profile(home):
    token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(token)


async def until(predicate, timeout=10):
    async def wait():
        while not predicate():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(wait(), timeout)


class Gateway:
    def __init__(self):
        self.expected = {}
        self.registered = []
        self.http_requests = []
        self.connected = {}
        self.downlinks = asyncio.Queue()
        self.heartbeats = asyncio.Queue()
        self.acks = asyncio.Queue()
        self.reject = []
        self.ack_downlinks = True
        self.files = {}
        self.uploads = {}
        self.oss_calls = []
        self.fail_uploads = set()

    async def __call__(self, scope, receive, send):
        headers = {key.decode(): value.decode() for key, value in scope["headers"]}
        agent = headers.get("x-agent-id", "")
        if scope["type"] == "http":
            event = await receive()
            body = event.get("body", b"")
            while event.get("more_body"):
                event = await receive()
                body += event.get("body", b"")
            if scope["path"].startswith(("/files/", "/mcp")):
                await self.media_http(scope, body, send)
                return
            self.http_requests.append((scope["path"], headers, json.loads(body)))
            if scope["path"].endswith("/register"):
                assert headers["authorization"] == f"Bearer {self.expected[agent]}"
                assert headers["x-request-id"] and headers["x-agent-version"] and headers["x-request-timestamp"]
                self.registered.append(agent)
                body = {"agent_id": agent, "session_token": f"session-{agent}", "ttl_sec": 60}
                status = 200
            else:
                assert headers["authorization"] == f"Bearer session-{agent}"
                await self.heartbeats.put(agent)
                body, status = {"error": {"code": "session_expired"}}, 401
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": json.dumps(body).encode()})
            return
        assert scope["type"] == "websocket"
        assert headers["authorization"] == f"Bearer session-{agent}"
        assert headers["x-uag-protocol-version"] == "uag.agent.v1"
        await receive()
        await send({"type": "websocket.accept"})
        if self.reject:
            code = self.reject.pop(0)
            await send({"type": "websocket.send", "text": json.dumps({"type": "connection.rejected",
                        "payload": {"error": {"code": code}}})})
            await send({"type": "websocket.close", "code": 4001})
            return
        await send({"type": "websocket.send", "text": json.dumps({"type": "connection.accepted",
                    "connection_id": "fixture-connection", "agent_id": agent,
                    "payload": {"heartbeat_interval_sec": 1}})})
        self.connected[agent] = send
        try:
            while True:
                event = await receive()
                if event["type"] == "websocket.disconnect":
                    return
                envelope = json.loads(event["text"])
                kind = envelope["type"]
                if kind == "channel.message.send":
                    await self.downlinks.put(envelope)
                    if self.ack_downlinks:
                        await send({"type": "websocket.send", "text": json.dumps({"type": "ack",
                                    "in_reply_to": envelope["message_id"],
                                    "payload": {"ok": True, "downlink_msg_ids": ["downlink-fixture"]}})})
                elif kind == "ack":
                    await self.acks.put(envelope)
        finally:
            if self.connected.get(agent) is send:
                self.connected.pop(agent, None)

    async def media_http(self, scope, body, send):
        """本地文件/OSS/真实 MCP HTTP 协议夹具，不替换生产客户端实现。"""
        path = scope["path"]
        status, mime = 200, b"application/json"
        host = next(value.decode() for key, value in scope["headers"] if key == b"host")
        base = f"http://{host}"
        if path == "/mcp":
            if scope["method"] != "POST":
                status, data = 405, b""
            else:
                request = json.loads(body)
                method = request["method"]
                if "id" not in request:
                    status, data = 202, b""
                else:
                    result = {}
                    if method == "initialize":
                        result = {"protocolVersion": request["params"]["protocolVersion"],
                                  "capabilities": {"tools": {}},
                                  "serverInfo": {"name": "fixture-oss", "version": "1"}}
                    elif method == "tools/list":
                        result = {"tools": [{"name": name, "description": name,
                                  "inputSchema": {"type": "object", "properties": {key: {"type": "string"}},
                                                  "required": [key]}}
                                 for name, key in (("get_oss_upload_url", "fileName"),
                                                   ("confirm_oss_upload", "ossPath"))]}
                    elif method == "tools/call":
                        params = request["params"]
                        self.oss_calls.append((dict(scope["headers"]).get(b"x-profile-owner"), params))
                        if params["name"] == "get_oss_upload_url":
                            name = params["arguments"]["fileName"]
                            output = f"上传地址：{base}/files/{name}\nossPath：{name}\nContent-Type=application/octet-stream"
                        else:
                            name = params["arguments"]["ossPath"]
                            output = f"下载链接：{base}/files/{name}"
                        result = {"content": [{"type": "text", "text": output}]}
                    data = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode()
        elif scope["method"] == "PUT":
            if path in self.fail_uploads:
                status = 503
            else:
                self.uploads[path] = body
            data = b""
        elif path in self.files:
            data, mime = self.files[path]
        elif path in self.uploads:
            data, mime = self.uploads[path], b"application/octet-stream"
        else:
            status, data = 404, b""
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", mime)]})
        await send({"type": "http.response.body", "body": data})

    async def request(self, agent, message_id, phone="13800000000", inputs=None):
        await self.connected[agent]({"type": "websocket.send", "text": json.dumps({
            "type": "agent.request", "agent_id": agent, "message_id": message_id,
            "session_id": f"remote-session-{message_id}", "turn_id": f"remote-turn-{message_id}",
            "request_id": "request-fixture", "ack": {"mode": "required"},
            "channel": {"phone_number": phone},
            "payload": {"inputs": inputs if inputs is not None else [{"type": "text", "text": message_id}]},
        })})


@pytest_asyncio.fixture
async def gateway():
    fake = Gateway()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    listener.setblocking(False)
    # 只关闭本夹具的服务；MCP/故障测试的遗留连接不能无限阻塞退出。
    server = uvicorn.Server(uvicorn.Config(fake, lifespan="off", access_log=False, log_config=None,
                                         timeout_graceful_shutdown=2))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    await until(lambda: server.started)
    try:
        yield fake, f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        listener.close()


def install(home, url, agent, secret):
    home.mkdir(parents=True, exist_ok=True)
    assert not (home / "plugins/uniagentgate").exists()
    (home / ".env").write_text(f'UNIAGENTGATE_AGENT_SK="{secret}"\n', encoding="utf-8")
    (home / "config.yaml").write_text(json.dumps({
        "plugins": {"enabled": ["uniagentgate"]},
        "platforms": {"uniagentgate": {"enabled": True, "gateway_url": url,
                      "agent_id": agent, "allow_from": ["13800000000"], "typing_indicator": False}},
    }), encoding="utf-8")


def adapter_from_config():
    from gateway.config import Platform, load_gateway_config
    from gateway.platform_registry import platform_registry
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    discover_plugins()
    config = load_gateway_config()
    adapter = platform_registry.create_adapter("uniagentgate", config.platforms[Platform("uniagentgate")])
    assert adapter is not None
    loaded = get_plugin_manager()._plugins["uniagentgate"]
    assert loaded.manifest.source == "bundled"
    from hermes_cli.plugins import get_bundled_plugins_dir
    assert Path(importlib.import_module(adapter.__module__).__file__).resolve().parent == (
        get_bundled_plugins_dir() / "uniagentgate").resolve()
    return adapter


@pytest.mark.asyncio
@pytest.mark.parametrize(("hermes_version", "expected_version"), [
    ("0.0.0", "1.0.0"),
    ("0.22.2", "1.0.0"),
    ("unknown", "1.0.0"),
    ("", "1.0.0"),
    (None, "1.0.0"),
    ("invalid", "1.0.0"),
    ("1.0.0rc1", "1.0.0"),
    ("1.0.0", "1.0.0"),
    ("1.2.3", "1.2.3"),
    ("1.10.0", "1.10.0"),
    ("2.0.0", "2.0.0"),
])
async def test_gateway_version_preserves_release_with_minimum_for_development_builds(
    tmp_path, gateway, monkeypatch, hermes_version, expected_version,
):
    from hermes_cli import version_info

    stamp = tmp_path / "install-stamp.json"
    stamp.write_text(json.dumps({"commit": "a" * 40, "baseVersion": hermes_version,
                                 "updateMechanism": "electron-updater", "payload": "bundled"}), encoding="utf-8")
    monkeypatch.setattr(version_info, "_resolve_stamp_file", lambda: stamp)
    monkeypatch.setattr(version_info, "_cached_version_info", None)
    assert version_info.get_version_info().base_version == (hermes_version or "unknown")

    fake, url = gateway
    home = tmp_path / "account"
    install(home, url, "version-agent", "version-secret")
    fake.expected["version-agent"] = "version-secret"
    with profile(home):
        adapter = adapter_from_config()
        auth = importlib.import_module(adapter.__module__.rsplit(".", 1)[0] + ".auth")
        session = await auth.register(url, "version-agent", "version-secret")
        await auth.validate_credentials(url, "version-agent", "version-secret")
        # The fixture rejects heartbeats; verify the real request despite the response.
        with pytest.raises(auth.UniAgentGateAuthError, match="session_expired"):
            await auth.heartbeat(url, session.session_token, session.agent_id)

    assert len(fake.http_requests) == 3
    for path, headers, body in fake.http_requests:
        assert headers["x-agent-version"] == expected_version
        if path.endswith("/register"):
            assert body["version"] == auth.CONNECTOR_VERSION


@pytest.mark.asyncio
async def test_attachment_turns_and_combined_media_use_owning_profile_mcp_a_b_a(tmp_path, gateway):
    """纯附件/图文走真实 Hermes 投递，OSS 凭据 A→B→A 不串，部分失败不多发短信。"""
    import base64
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers

    fake, url = gateway
    image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
    fake.files["/files/input.png"] = (image, b"image/png")
    fake.files["/files/input.pdf"] = (b"%PDF-fixture", b"application/pdf")
    fake.fail_uploads.add("/files/broken.pdf")
    homes = {name: tmp_path / name for name in ("A", "B")}
    active = is_multiplex_active()
    set_multiplex_active(True)
    try:
        for name, home in homes.items():
            fake.expected[f"media-{name}"] = f"secret-{name}"
            install(home, url, f"media-{name}", f"secret-{name}")
            config = json.loads((home / "config.yaml").read_text())
            config["mcp_servers"] = {"UniAI-Toolkit": {"url": f"{url}/mcp?scope={name}",
                                       "headers": {"X-Profile-Owner": name}}}
            (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        for index, name in enumerate(("A", "B", "A")):
            with profile(homes[name]):
                assert await asyncio.to_thread(discover_mcp_tools)
                adapter = adapter_from_config()
                produced = homes[name] / "workspace"
                produced.mkdir(exist_ok=True)
                outputs = {"answer.png": image, "report.pdf": b"%PDF-output", "broken.pdf": b"bad-upload"}
                for filename, data in outputs.items():
                    (produced / filename).write_bytes(data)
                # 原生媒体超限应跳过，不能被当作普通链接再上传。
                oversized = produced / "oversized.mp4"
                with oversized.open("wb") as stream:
                    stream.truncate(20 * 1024 * 1024 + 1)
                received = []

                async def handle(event):
                    received.append(event)
                    assert event.media_urls and all(Path(path).is_file() for path in event.media_urls)
                    assert all(path.startswith(str(homes[name])) for path in event.media_urls)
                    assert event.media_text_inlined == [False] * len(event.media_urls)
                    return "已完成\n" + "\n".join(f"MEDIA:{produced / filename}"
                                                    for filename in (*outputs, "oversized.mp4"))
                adapter.set_message_handler(handle)
                try:
                    assert await adapter.connect()
                    inputs = [{"type": "file_url", "url": f"{url}/files/input.png"}]
                    if index == 1:
                        inputs = [{"type": "file_url", "url": f"{url}/files/input.pdf"}]
                    elif index == 2:
                        inputs += [{"type": "text", "text": "解析附件"},
                                   {"type": "file_url", "url": f"{url}/files/input.pdf"}]
                    await fake.request(f"media-{name}", f"media-{index}", inputs=inputs)
                    sent = await asyncio.wait_for(fake.downlinks.get(), 30)
                    await until(lambda: not adapter._active_sessions)
                    assert len(received) == 1
                    assert len(received[0].media_urls) == (2 if index == 2 else 1)
                    assert sent["turn_id"] == f"remote-turn-media-{index}"
                    assert "已完成" in sent["payload"]["text"]
                    assert f"{url}/files/report.pdf" in sent["payload"]["text"]
                    assert len(sent["payload"]["media"]) == 1
                    assert sent["payload"]["media"][0]["kind"] == "image"
                    assert "broken.pdf" not in sent["payload"]["text"]
                    assert fake.downlinks.empty()
                    assert fake.uploads["/files/answer.png"] == image
                    assert fake.uploads["/files/report.pdf"] == b"%PDF-output"
                    assert "/files/oversized.mp4" not in fake.uploads
                    calls = fake.oss_calls[-5:]
                    assert calls and all(owner == name.encode() for owner, _ in calls)
                finally:
                    await adapter.disconnect()
    finally:
        await asyncio.to_thread(shutdown_mcp_servers)
        set_multiplex_active(active)


@pytest.mark.asyncio
async def test_reconnect_control_recovers_only_rcs_and_preserves_other_platforms(tmp_path, gateway, monkeypatch):
    """真实控制 socket 与注册/WS，覆盖忙碌拒绝、鉴权、终止后恢复及其它平台不变。"""
    from gateway.config import Platform, load_gateway_config
    from gateway.run import GatewayRunner

    fake, url = gateway
    home = tmp_path / "control"
    install(home, url, "control-agent", "control-secret")
    fake.expected["control-agent"] = "control-secret"
    monkeypatch.setenv("HERMES_HOME", str(home))
    with profile(home):
        runner = GatewayRunner(config=load_gateway_config())
        runner._running = True
        adapter = adapter_from_config()
        adapter.gateway_runner = runner
        other = object()
        runner.adapters = {Platform("uniagentgate"): adapter, Platform.TELEGRAM: other}
        runner.delivery_router.adapters = runner.adapters
        async def request(token=None, operation="reconnect"):
            record = json.loads((home / "uniagentgate-control.json").read_text())
            reader, writer = await asyncio.open_connection("127.0.0.1", record["port"])
            try:
                writer.write(json.dumps({"token": token or record["token"], "operation": operation}).encode() + b"\n")
                await writer.drain()
                return json.loads(await asyncio.wait_for(reader.readline(), 20))
            finally:
                writer.close()
                await writer.wait_closed()
        try:
            # release 的统一恢复入口必须识别动态注册的 5G；仅 5G 配置也不能启动空网关。
            messaging_api = importlib.import_module("plugins.desktop-messaging.dashboard.plugin_api")
            prepared = await messaging_api.prepare()
            assert prepared["configured"] and prepared["profiles"] == ["default"]
            assert await adapter.connect()
            assert (await request("wrong-token"))["status"] == "unauthorized"
            adapter._active_sessions["busy"] = asyncio.Event()
            assert (await request())["status"] == "busy"
            assert fake.registered == ["control-agent"]
            adapter._active_sessions.clear()
            assert (await request())["status"] == "connected"
            assert fake.registered == ["control-agent"]
            assert runner.adapters[Platform.TELEGRAM] is other
            assert runner.delivery_router.adapters is runner.adapters
            await fake.connected["control-agent"]({"type": "websocket.close", "code": 4003})
            await until(lambda: adapter.has_fatal_error)
            assert runner._running
            assert (await request())["status"] == "connected"
            assert len(fake.registered) == 2
            assert runner.adapters[Platform.TELEGRAM] is other

            # 同凭据不重复注册；轮换仅 SK 也须被识别。
            assert (await request(operation="apply_binding"))["status"] == "connected"
            assert len(fake.registered) == 2
            old_client = adapter._client
            started, finish = asyncio.Event(), asyncio.Event()

            async def handle_old_turn(event):
                started.set()
                await finish.wait()
                return "old-binding-answer"

            adapter.set_message_handler(handle_old_turn)
            await fake.request("control-agent", "before-rotation")
            await asyncio.wait_for(started.wait(), 5)
            (home / ".env").write_text('UNIAGENTGATE_AGENT_SK="rotated-secret"\n')
            fake.expected["control-agent"] = "rotated-secret"
            assert (await request(operation="apply_binding"))["status"] == "connecting"
            assert adapter._client is old_client and old_client.is_alive
            finish.set()
            reply = await asyncio.wait_for(fake.downlinks.get(), 10)
            assert reply["payload"]["text"] == "old-binding-answer"
            assert reply["turn_id"] == "remote-turn-before-rotation"
            await until(lambda: len(fake.registered) == 3 and adapter._client.health.state == "running")
            assert adapter._client is not old_client
            assert not old_client.is_alive

            # 明确撤销停连接，重新绑定仍使用原网关与原控制通道。
            file = home / "config.yaml"
            config = json.loads(file.read_text())
            config["platforms"]["uniagentgate"]["enabled"] = False
            file.write_text(json.dumps(config))
            assert (await request(operation="apply_binding"))["status"] == "unbound"
            assert adapter._client is None and runner._running
            config["platforms"]["uniagentgate"]["enabled"] = True
            file.write_text(json.dumps(config))
            assert (await request(operation="apply_binding"))["status"] == "connected"
            assert len(fake.registered) == 4
            assert runner.adapters[Platform.TELEGRAM] is other
        finally:
            adapter._control.close()
            await adapter.disconnect()
            runner._running = False
            if runner._session_db:
                await runner._session_db.close()


@pytest.mark.asyncio
async def test_real_wav_transcode_is_uploaded_as_mp3_and_bad_audio_does_not_drop_other_files(tmp_path, gateway):
    """使用真实 FFmpeg，验证转换出的字节及下发格式，不用伪造转码结果。"""
    import io
    import wave
    from hermes_platform.resolver import locate_command
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers

    if not locate_command("ffmpeg").found:
        pytest.skip("real FFmpeg must be provisioned on PATH for the audio integration test")
    fake, url = gateway
    home = tmp_path / "audio"
    install(home, url, "audio-agent", "audio-secret")
    config = json.loads((home / "config.yaml").read_text())
    config["mcp_servers"] = {"UniAI-Toolkit": {"url": f"{url}/mcp"}}
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 16000)
    with profile(home):
        adapter = adapter_from_config()
        media = importlib.import_module(adapter.__module__.rsplit(".", 1)[0] + ".media")
        (home / "voice.wav").write_bytes(data.getvalue())
        (home / "broken.wav").write_bytes(b"invalid wave")
        (home / "report.docx").write_bytes(b"document fixture")
        try:
            assert await asyncio.to_thread(discover_mcp_tools)
            delivered, links = await media.build_media([str(home / name) for name in
                                                       ("voice.wav", "broken.wav", "report.docx")])
            assert len(delivered) == 1
            assert delivered[0]["kind"] == "audio" and delivered[0]["mime_type"] == "audio/mpeg"
            assert delivered[0]["file_name"] == "voice.mp3"
            assert fake.uploads["/files/voice.mp3"].startswith(b"ID3")
            assert len(links) == 1 and "report.docx" in links[0]
            assert "/files/broken.mp3" not in fake.uploads
        finally:
            await asyncio.to_thread(shutdown_mcp_servers)


@pytest.mark.asyncio
async def test_profile_a_b_a_real_gateway_text_delivery_and_no_secret_fallback(tmp_path, monkeypatch, gateway, caplog):
    caplog.set_level(logging.INFO, logger="hermes_plugins.uniagentgate")
    fake, url = gateway
    homes = {name: tmp_path / name for name in ("A", "B")}
    for name, home in homes.items():
        fake.expected[f"agent-{name}"] = f"secret-{name}"
        install(home, url, f"agent-{name}", f"secret-{name}")
    # The launch process's value is deliberately wrong for BOTH served profiles.
    monkeypatch.setenv("UNIAGENTGATE_AGENT_SK", "wrong-launch-secret")
    active = is_multiplex_active()
    set_multiplex_active(True)
    events = []
    keys = []
    try:
        for index, name in enumerate(("A", "B", "A")):
            with profile(homes[name]):
                adapter = adapter_from_config()
                async def handle(event):
                    events.append(event)
                    keys.append((get_hermes_home(), adapter._event_session_key(event)))
                    return f"Answer [{event.text}](https://example.invalid/evidence)"
                adapter.set_message_handler(handle)
                try:
                    assert await adapter.connect()
                    request_id = f"request-{index}"
                    await fake.request(f"agent-{name}", request_id)
                    sent = await asyncio.wait_for(fake.downlinks.get(), 10)
                    assert sent["session_id"] == f"remote-session-{request_id}"
                    assert sent["turn_id"] == f"remote-turn-{request_id}"
                    assert sent["channel"]["phone_number"] == "13800000000"
                    assert "https://example.invalid/evidence" in sent["payload"]["text"]
                    await until(lambda: not adapter._active_sessions)
                    before = len(events)
                    await fake.request(f"agent-{name}", request_id)
                    # Both copies get a protocol ACK; only the first is admitted as a model turn.
                    first_ack = await asyncio.wait_for(fake.acks.get(), 5)
                    second_ack = await asyncio.wait_for(fake.acks.get(), 5)
                    assert first_ack["in_reply_to"] == second_ack["in_reply_to"] == request_id
                    assert len(events) == before
                    assert fake.downlinks.empty()
                finally:
                    await adapter.disconnect()
                    assert not adapter._contexts
        assert fake.registered == ["agent-A", "agent-B", "agent-A"]
        assert "uniAgentGate inbound received:" in caplog.text
        assert "uniAgentGate dispatch to Hermes:" in caplog.text
        assert "uniAgentGate reply accepted:" in caplog.text
        assert keys[0] == keys[2] and keys[0] != keys[1]
        with profile(homes["B"]):
            (homes["B"] / ".env").write_text("", encoding="utf-8")
        with profile(homes["B"]):
            from gateway.platform_registry import platform_registry
            from gateway.config import Platform, load_gateway_config
            assert platform_registry.create_adapter("uniagentgate", load_gateway_config().platforms[
                Platform("uniagentgate")]) is None
    finally:
        set_multiplex_active(active)


@pytest.mark.asyncio
async def test_inbound_diagnostics_distinguish_drops_without_logging_message_or_sender(tmp_path, gateway, caplog):
    caplog.set_level(logging.INFO, logger="hermes_plugins.uniagentgate")
    fake, url = gateway
    home = tmp_path / "home"
    fake.expected["agent-diagnostics"] = "fixture-secret-never-log"
    install(home, url, "agent-diagnostics", fake.expected["agent-diagnostics"])
    events = []
    with profile(home):
        adapter = adapter_from_config()

        async def handle(event):
            events.append(event)
            return "fixture response"

        adapter.set_message_handler(handle)
        try:
            assert await adapter.connect()
            send = fake.connected["agent-diagnostics"]

            async def frame(message_id, agent="agent-diagnostics", phone="13800000000", text="private-message-body"):
                await send({"type": "websocket.send", "text": json.dumps({
                    "type": "agent.request", "message_id": message_id, "agent_id": agent,
                    "channel": {"phone_number": phone}, "payload": {"inputs": [{"type": "text", "text": text}]},
                })})

            await frame("13800000000-private-request-one", agent="another-agent")
            await frame("private-request-three", text="")
            await send({"type": "websocket.send", "text": "not-json"})
            await until(lambda: all(reason in caplog.text for reason in (
                "reason=agent_mismatch",
                "reason=empty_text_or_attachment_only", "reason=invalid_envelope")))
            assert not events
            diagnostics = "\n".join(record.getMessage() for record in caplog.records
                                    if record.name.startswith("hermes_plugins.uniagentgate"))
            for private in ("13800000000", "private-message-body", "private-request", "fixture-secret-never-log"):
                assert private not in diagnostics
        finally:
            await adapter.disconnect()


@pytest.mark.asyncio
@pytest.mark.parametrize("sender", ["8613800000000", "sa_fixture_external_session"])
async def test_non_mobile_sender_reaches_hermes_and_preserves_reply_context(tmp_path, gateway, sender):
    """真实 Hermes 授权须接受已认证 Agent 的不透明发送者标识。"""
    from gateway.authz_mixin import GatewayAuthorizationMixin
    from gateway.config import Platform, load_gateway_config
    from gateway.session import SessionSource

    fake, url = gateway
    home = tmp_path / "account"
    fake.expected["agent-A"] = "secret-A"
    install(home, url, "agent-A", "secret-A")
    events = []
    decisions = []
    with profile(home):
        adapter = adapter_from_config()
        authorization = GatewayAuthorizationMixin()
        authorization.config = load_gateway_config()
        authorization.config.multiplex_profiles = False
        authorization.adapters = {Platform("uniagentgate"): adapter}
        unconnected_source = SessionSource(platform=Platform("uniagentgate"),
                                           chat_id=sender, user_id=sender, chat_type="dm")
        assert not authorization._is_user_authorized(unconnected_source)

        async def handle(event):
            events.append(event)
            allowed = authorization._is_user_authorized(event.source)
            decisions.append(allowed)
            return "fixture response" if allowed else None

        adapter.set_message_handler(handle)
        try:
            assert await adapter.connect()
            await fake.connected["agent-A"]({"type": "websocket.send", "text": json.dumps({
                "type": "agent.request", "agent_id": "agent-A", "message_id": "non-mobile-message",
                "session_id": "original-session", "turn_id": "original-turn",
                "channel": {"external_session_id": sender},
                "payload": {"inputs": [{"type": "text", "text": "fixture question"}]},
            })})
            await until(lambda: bool(decisions))
            assert decisions == [True]
            # This platform's delegated authorization must not grant access on other platforms.
            assert not authorization._is_user_authorized(SessionSource(
                platform=Platform.TELEGRAM, chat_id=sender, user_id=sender, chat_type="dm"))
            sent = await asyncio.wait_for(fake.downlinks.get(), 3)
            assert len(events) == 1
            assert events[0].source.user_id == sender
            assert sent["channel"]["phone_number"] == sender
            assert sent["session_id"] == "original-session"
            assert sent["turn_id"] == "original-turn"
        finally:
            await adapter.disconnect()
            assert not authorization._is_user_authorized(unconnected_source)


@pytest.mark.asyncio
async def test_auth_recovery_heartbeat_takeover_and_uncertain_ack_are_bounded(tmp_path, monkeypatch, gateway):
    fake, url = gateway
    home = tmp_path / "account"
    fake.expected["agent-A"] = "secret-A"
    install(home, url, "agent-A", "secret-A")
    with profile(home):
        adapter = adapter_from_config()
        package = type(adapter).__module__.rsplit(".", 1)[0]
        stream = importlib.import_module(f"{package}.stream")
        monkeypatch.setattr(stream, "HTTP_HEARTBEAT_INTERVAL_SEC", 1)
        fake.reject = ["unauthorized"]
        try:
            assert await adapter.connect()
            assert len(fake.registered) == 2
            assert await asyncio.wait_for(fake.heartbeats.get(), 5) == "agent-A"
            assert adapter._client.health.state == "running" and len(fake.registered) == 2
            reconnected = asyncio.Event()
            on_health_change = adapter._client.health.on_change

            def health_changed(state):
                on_health_change(state)
                if state == "running":
                    reconnected.set()

            adapter._client.health.on_change = health_changed
            await fake.connected["agent-A"]({"type": "websocket.close", "code": 4004})
            # HTTP 注册已完成不代表新 WS 握手完成；等待这次握手的 running 通知。
            await asyncio.wait_for(reconnected.wait(), 10)
            assert len(fake.registered) == 3
            fake.ack_downlinks = False
            monkeypatch.setattr(stream, "ACK_WAIT_SECONDS", 0.05)
            result = await adapter._send_with_retry("13800000000", "one billable message")
            assert not result.success and not result.retryable
            assert (await asyncio.wait_for(fake.downlinks.get(), 5))["payload"]["text"] == "one billable message"
            assert fake.downlinks.empty()
            await fake.connected["agent-A"]({"type": "websocket.close", "code": 4003})
            await until(lambda: adapter.has_fatal_error)
            assert not adapter.fatal_error_retryable
            assert not adapter._client.is_alive
            assert len(fake.registered) == 3
        finally:
            await adapter.disconnect()
        # A new explicit connection is the recovery action after a terminal stop.
        fake.reject = ["session_expired"] * 4
        retry = adapter_from_config()
        try:
            assert not await retry.connect()
            assert not retry.fatal_error_retryable
            assert len(fake.registered) == 7
        finally:
            await retry.disconnect()
