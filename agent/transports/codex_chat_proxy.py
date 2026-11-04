"""Session-owned loopback Responses bridge for chat-completions providers.

Protocol translation is adapted from HexAgent's code-mode bridge.
Upstream credentials stay in the owning process, never in Codex configuration.
"""

from __future__ import annotations

import hmac
import json
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

from agent.transports.codex_provider_adapter import endpoint_fingerprint
from agent.transports.codex_responses_adapter import (
    ResponsesStreamEncoder,
    build_chat_request,
)


class CodexChatProxy:
    def __init__(
        self, *, model: str, base_url: str, api_key: str, extra_body: dict | None = None
    ):
        self.token = secrets.token_urlsafe(32)
        owner = self
        protocol = (
            "deepseek-chat"
            if any(name in model.lower() for name in ("deepseek", "glm"))
            else "auto"
        )
        url = base_url.rstrip("/")
        if not url.endswith("/chat/completions"):
            url += "/chat/completions"

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                return

            def do_POST(self):
                if self.path != "/v1/responses" or not hmac.compare_digest(
                    self.headers.get("Authorization", ""), "Bearer " + owner.token
                ):
                    self.send_error(403)
                    return
                encoder = None
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 32 * 1024 * 1024:
                        self.send_error(413)
                        return
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise ValueError("Responses request must be an object")
                    build = build_chat_request(
                        body,
                        upstream_model=model,
                        base_url=base_url,
                        api_protocol=protocol,
                        model_identity=model,
                    )
                    build.payload.update({
                        k: v
                        for k, v in (extra_body or {}).items()
                        if k not in {"model", "messages", "stream", "tools"}
                    })
                    encoder = ResponsesStreamEncoder(
                        response_id="resp_" + uuid.uuid4().hex,
                        model=model,
                        namespaces=build.namespaces,
                        provider_protocol=build.protocol,
                        model_identity=model,
                        endpoint_identity=endpoint_fingerprint(
                            provider="", base_url=base_url
                        ),
                    )
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    with httpx.Client(
                        timeout=httpx.Timeout(900, connect=30), trust_env=False
                    ) as client:
                        with client.stream(
                            "POST",
                            url,
                            json=build.payload,
                            headers={"Authorization": "Bearer " + api_key},
                        ) as response:
                            response.raise_for_status()
                            for frame in encoder.start():
                                self.wfile.write(frame)
                            for line in response.iter_lines():
                                if not line.startswith("data:"):
                                    continue
                                data = line[5:].strip()
                                if data == "[DONE]":
                                    break
                                for frame in encoder.feed(json.loads(data)):
                                    self.wfile.write(frame)
                                self.wfile.flush()
                            frames = (
                                encoder.finish()
                                if encoder.finish_reason
                                in {"stop", "tool_calls", "function_call"}
                                else encoder.fail(
                                    "Model stream ended before completion",
                                    code="incomplete_stream",
                                )
                            )
                            for frame in frames:
                                self.wfile.write(frame)
                except (BrokenPipeError, ConnectionResetError):
                    return
                except (ValueError, httpx.HTTPError) as exc:
                    # Keep failures in the Responses protocol so Codex surfaces a failed turn.
                    if encoder is None:
                        self.send_error(400, "Invalid Responses request")
                        return
                    for frame in encoder.fail(str(exc), code="upstream_error"):
                        self.wfile.write(frame)
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def client_options(self):
        provider = {
            "name": "Hermes code mode",
            "base_url": self.base_url,
            "wire_api": "responses",
            "experimental_bearer_token": self.token,
        }
        args = []
        for key, value in provider.items():
            args.extend([
                "-c",
                f"model_providers.hermes_code.{key}={json.dumps(value)}",
            ])
        return {"extra_args": args}

    def client_factory(self, **kwargs):
        from agent.transports.codex_app_server import CodexAppServerClient

        return CodexAppServerClient(**kwargs, **self.client_options())
