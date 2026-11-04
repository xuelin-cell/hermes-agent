"""Real loopback requests exercise the Codex/package-model protocol boundary."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

from agent.transports.codex_chat_proxy import CodexChatProxy
from agent.transports.codex_app_server_session import CodexAppServerSession


def test_proxy_translates_responses_and_keeps_credentials_upstream():
    requests = []

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *args):
            return

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, self.headers.get("Authorization"), body))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            tool_turn = len(requests) == 1
            deltas = (
                [
                    {"reasoning_content": "Read the file before answering."},
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_read",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"example.txt"}',
                                },
                            }
                        ]
                    },
                    {},
                ]
                if tool_turn
                else [{"content": "fixture reply"}, {}]
            )
            for delta in deltas:
                data = {
                    "choices": [
                        {
                            "index": 0,
                            "delta": delta,
                            "finish_reason": ("tool_calls" if tool_turn else "stop")
                            if not delta
                            else None,
                        }
                    ]
                }
                self.wfile.write(("data: " + json.dumps(data) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    proxy = CodexChatProxy(
        model="deepseek-fixture",
        base_url=f"http://127.0.0.1:{upstream.server_port}/v1",
        api_key="fixture-secret",
    )
    lifetime = CodexAppServerSession(
        client_factory=proxy.client_factory, on_close=proxy.close
    )
    try:
        with httpx.Client(trust_env=False) as client:
            rejected = client.post(proxy.base_url + "/responses", json={"input": "hi"})
            assert rejected.status_code == 403
            response = client.post(
                proxy.base_url + "/responses",
                headers={"Authorization": "Bearer " + proxy.token},
                json={"input": "hi"},
            )
            assert response.status_code == 200
            assert "response.completed" in response.text
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            completed = next(
                event for event in events if event["type"] == "response.completed"
            )
            output = completed["response"]["output"]
            response = client.post(
                proxy.base_url + "/responses",
                headers={"Authorization": "Bearer " + proxy.token},
                json={
                    "input": [
                        {"role": "user", "content": "hi"},
                        *output,
                        {
                            "type": "function_call_output",
                            "call_id": "call_read",
                            "output": "example contents",
                        },
                    ]
                },
            )
            assert "fixture reply" in response.text
            assistant = next(
                message
                for message in requests[1][2]["messages"]
                if message["role"] == "assistant"
            )
            assert assistant["reasoning_content"] == "Read the file before answering."
            assert requests[1][2]["messages"][-1]["role"] == "tool"
        assert requests[0][0] == "/v1/chat/completions"
        assert requests[0][1] == "Bearer fixture-secret"
        assert requests[0][2]["messages"][-1]["content"] == "hi"
        assert "fixture-secret" not in str(proxy.client_options())
    finally:
        lifetime.close()
        assert not proxy.thread.is_alive()
        upstream.shutdown()
        upstream.server_close()
        thread.join()
