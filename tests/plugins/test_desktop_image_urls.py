"""模型请求中的图片改成签名 URL，保留原图、历史及账号边界。"""

import base64
import copy
import json
import random
from types import SimpleNamespace

from PIL import Image
import pytest

from tests.plugins.test_desktop_native_images import native  # noqa: F401


def image_request(data, mode):
    """构造原生聊天、Responses 和 Anthropic 的图片部件。"""
    url = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    parts = {
        "chat": {"type": "image_url", "image_url": {"url": url, "detail": "high"}},
        "responses": {"type": "input_image", "image_url": url, "detail": "high"},
        "anthropic": {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": url.split(",", 1)[1],
            },
        },
    }
    return {
        "model": "image",
        "input" if mode == "responses" else "messages": [
            {"role": "system", "content": "frozen system"},
            {
                "role": "user",
                "content": [{"type": "text", "text": "分析图片"}, parts[mode]],
            },
        ],
    }


@pytest.mark.parametrize("mode", ["chat", "responses", "anthropic"])
def test_image_urls_preserve_pixels_history_and_profile_cache(
    native, monkeypatch, mode
):
    """原生中间件上传原字节，A→B→A复用本账号链接，过期后重新上传。"""
    from hermes_cli.middleware import apply_llm_request_middleware

    urls = []
    for profile in ("a", "account-b", "a"):
        with native.scope(profile) as state:
            original = image_request(state.path.read_bytes(), mode)
            before = copy.deepcopy(original)
            result = apply_llm_request_middleware(
                original, platform="desktop", model="image"
            ).payload
            assert original == before
            assert result["model"] == original["model"]
            assert "data:image/" not in json.dumps(result)
            key = "input" if mode == "responses" else "messages"
            assert result[key][0] == original[key][0]
            part = result[key][1]["content"][1]
            url = part["source"]["url"] if mode == "anthropic" else part["image_url"]
            if isinstance(url, dict):
                assert url["detail"] == "high"
                url = url["url"]
            assert url.startswith("https://obs-nmhhht6.cucloud.cn/app-agent-prod/temp/")
            urls.append(url)
            assert native.puts[-1] == state.path.read_bytes()
    assert urls[0] == urls[2] and urls[0] != urls[1]
    assert len(native.puts) == 2
    with native.scope("a") as state:
        from importlib import import_module

        module = import_module(state.module.__name__ + ".image_urls")
        real_time = module.time.time()
        monkeypatch.setattr(
            module, "time", SimpleNamespace(time=lambda: real_time + 7200)
        )
        refreshed = apply_llm_request_middleware(
            original, platform="desktop", model="image"
        ).payload
        assert "data:image/" not in json.dumps(refreshed)
        assert len(native.puts) == 3


def test_attached_image_reaches_real_model_http_as_url(native, monkeypatch):
    """新会话附图经真实 Agent 和 HTTP 发出 URL，存档保留本机图片引用。"""
    from agent.image_routing import build_native_content_parts
    from hermes_cli import plugins
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from tests.fakes.fake_llm_provider import FakeLLMServer, Text

    with (
        native.scope("wire-url") as state,
        FakeLLMServer([Text("图片已分析。")]) as server,
    ):
        # 难压缩的真实 PNG 使 Base64 超过 10 MB，覆盖这次网关拒收的体积条件。
        pixels = random.Random(2026).randbytes(2048 * 1365 * 3)
        Image.frombytes("RGB", (2048, 1365), pixels).save(state.path)
        monkeypatch.setattr(plugins, "get_plugin_manager", lambda: state.manager)
        state.manager._discovered = True
        cfg = json.loads((state.home / "config.yaml").read_text())
        cfg["model"].update({
            "provider": "custom",
            "base_url": server.base_url,
            "context_length": 128000,
        })
        cfg["providers"]["custom"] = cfg["providers"]["custom:images"]
        (state.home / "config.yaml").write_text(json.dumps(cfg))
        parts, skipped = build_native_content_parts("分析图片", [str(state.path)])
        assert not skipped
        before = copy.deepcopy(parts)
        with SessionDB(state.home / "state.db") as db:
            agent = AIAgent(
                provider="custom",
                model="image",
                base_url=server.base_url,
                api_key="sk-fake-e2e",
                platform="desktop",
                session_id="image-url-session",
                session_db=db,
                enabled_toolsets=["desktop_ui"],
                quiet_mode=True,
                skip_memory=True,
                skip_context_files=True,
                max_iterations=2,
            )
            try:
                result = agent.run_conversation(parts, task_id="same-session")
                assert result["final_response"] == "图片已分析。"
                request = server.main_requests()[0]
                images = [
                    p["image_url"]["url"]
                    for m in request["messages"]
                    if isinstance(m.get("content"), list)
                    for p in m["content"]
                    if p.get("type") == "image_url"
                ]
                assert len(images) == 1 and images[0].startswith(
                    "https://obs-nmhhht6.cucloud.cn/"
                )
                assert len(json.dumps(request).encode()) < 1024 * 1024
                assert native.puts == [state.path.read_bytes()]
                assert [p for p in parts if p.get("type") == "image_url"] == [
                    p for p in before if p.get("type") == "image_url"
                ]
                assert not any(
                    "image_url" in json.dumps(r) for r in server.aux_requests()
                )
                rows = db.get_messages("image-url-session")
                assert any(
                    row["role"] == "user" and str(state.path) in str(row["content"])
                    for row in rows
                )
                assert not any("Signature=" in str(row["content"]) for row in rows)
            finally:
                agent.close()
