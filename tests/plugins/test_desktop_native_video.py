"""真实视频→终端抽帧→主模型HTTP图片，以及文字/编辑/搜索对照。"""

import base64
import json
import shlex
import shutil
import subprocess
from io import BytesIO

from PIL import Image
import pytest

from tests.plugins.test_desktop_native_images import native, TOOL, ANALYZE  # noqa: F401


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="真实视频链路需要ffmpeg")
@pytest.mark.parametrize("model", ["image", "text"])
def test_extracted_frames_reach_main_model_after_cd_without_breaking_mcp(
    native, monkeypatch, model
):
    """抽帧后cd不丢会话根；原图跨后续工具保留，文本和编辑仍按原方式上传。"""
    from hermes_cli import plugins
    from run_agent import AIAgent
    from tests.fakes.fake_llm_provider import FakeLLMServer, ToolCall, Text
    from tools.terminal_tool import (
        register_task_env_overrides,
        clear_task_env_overrides,
        get_session_cwd,
    )
    from tools.terminal_tool_lifecycle import cleanup_vm

    ffmpeg = shutil.which("ffmpeg")
    with native.scope("video-" + model, model=model) as state:
        work = state.home / "work"
        inputs = work / ".tmp" / "inputs"
        inspection = work / ".tmp" / "inspection"
        inputs.mkdir()
        inspection.mkdir()
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
        for i, color in enumerate(colors, 1):
            Image.new("RGB", (48, 32), color).save(inputs / f"{i}.png")
        video = work / ".tmp" / "sample.mkv"
        subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-framerate",
                "1",
                "-i",
                str(inputs / "%d.png"),
                "-c:v",
                "ffv1",
                str(video),
            ],
            check=True,
            capture_output=True,
            timeout=20,
        )
        frames = [state.path.parent / f"{i:02d}.png" for i in range(1, 4)]
        assert all(not p.exists() for p in frames)
        # 抽帧命令真正由Agent终端执行，切到兄弟目录后才读先前的帧。
        command = (
            shlex.join([
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(video),
                "-vf",
                "fps=1",
                str(state.path.parent / "%02d.png"),
            ])
            + " && cd "
            + shlex.quote(str(inspection))
            + " && pwd"
        )
        script = [ToolCall("terminal", {"command": command, "timeout": 20})]
        for i, frame in enumerate(frames):
            if model == "image":
                script.append(ToolCall(TOOL, {"path": str(frame)}))
            else:
                script.append(
                    ToolCall(
                        "tool_call",
                        {
                            "name": ANALYZE,
                            "arguments": {
                                "image_url_or_oss_path": str(frame),
                                "user_prompt": f"frame {i}",
                            },
                        },
                    )
                )
        script.extend([
            ToolCall(
                "tool_call",
                {
                    "name": "mcp__UniAI_Toolkit__image_edit",
                    "arguments": {"image": str(frames[0]), "prompt": "grayscale"},
                },
            ),
            ToolCall(
                "tool_call",
                {
                    "name": "mcp__UniAI_Toolkit__web_search",
                    "arguments": {"query": "frame reference"},
                },
            ),
            Text("done"),
        ])
        with FakeLLMServer(script) as server:
            monkeypatch.setattr(plugins, "get_plugin_manager", lambda: state.manager)
            state.manager._discovered = True
            cfg_file = state.home / "config.yaml"
            cfg = json.loads(cfg_file.read_text())
            cfg["model"].update({
                "provider": "custom",
                "default": model,
                "base_url": server.base_url,
                "context_length": 128000,
            })
            cfg["providers"]["custom"] = cfg["providers"]["custom:images"]
            cfg_file.write_text(json.dumps(cfg))
            register_task_env_overrides(
                "same-session", {"env_type": "local", "cwd": str(work)}
            )
            agent = AIAgent(
                provider="custom",
                model=model,
                base_url=server.base_url,
                api_key="sk-fake-video",
                platform="desktop",
                session_id="same-session",
                enabled_toolsets=["desktop_ui", "terminal", "native_image_test"],
                quiet_mode=True,
                skip_memory=True,
                skip_context_files=True,
                max_iterations=10,
            )
            try:
                result = agent.run_conversation(
                    "抽取此视频关键帧并分析，然后编辑第一帧并搜索参考资料："
                    + str(video),
                    task_id="same-session",
                )
                assert result["final_response"] == "done"
                assert get_session_cwd("same-session") == str(inspection)
                for frame, color in zip(frames, colors):
                    with Image.open(frame) as image:
                        assert image.convert("RGB").getpixel((24, 16)) == color
                requests = server.main_requests()
                assert len(requests) == len(script)
                final_tools = [
                    m for m in requests[-1]["messages"] if m["role"] == "tool"
                ]
                frame_results = final_tools[1:4]
                if model == "image":
                    for message, frame, color in zip(frame_results, frames, colors):
                        parts = message["content"]
                        assert isinstance(parts, list), parts
                        assert str(frame) in parts[0]["text"]
                        data = next(
                            p["image_url"]["url"]
                            for p in parts
                            if p["type"] == "image_url"
                        )
                        with Image.open(
                            BytesIO(base64.b64decode(data.split(",", 1)[1]))
                        ) as decoded:
                            assert (
                                decoded.size == (48, 32)
                                and decoded.convert("RGB").getpixel((24, 16)) == color
                            )
                    assert not any("user_prompt" in args for args in native.calls)
                else:
                    assert all(
                        isinstance(m["content"], str)
                        and "remote result" in m["content"]
                        for m in frame_results
                    )
                    assert len([a for a in native.calls if "user_prompt" in a]) == 3
                    assert not any("data:image/" in json.dumps(r) for r in requests)
                edited = next(a for a in native.calls if a.get("prompt") == "grayscale")
                assert edited["image"].startswith("app-agent-prod/temp/")
                assert native.calls[-1] == {"query": "frame reference"}
                assert len(native.puts) == (1 if model == "image" else 3)
                assert all("remote result" in m["content"] for m in final_tools[-2:])
                assert not any(
                    "data:image/" in json.dumps(r) for r in server.aux_requests()
                )
                system = [m for m in requests[0]["messages"] if m["role"] == "system"]
                assert all(
                    [m for m in r["messages"] if m["role"] == "system"] == system
                    for r in requests
                )
                assert requests[0]["tools"] == requests[-1]["tools"]
            finally:
                agent.close()
                cleanup_vm("same-session")
                clear_task_env_overrides("same-session")


@pytest.mark.platforms("posix")
def test_registered_work_root_keeps_sensitive_and_resolved_path_boundaries(native):
    """扩大到登记根后，跨账号目录和指向根外的链接仍不能加载。"""
    from tools.terminal_tool import (
        register_task_env_overrides,
        record_session_cwd,
        clear_task_env_overrides,
    )

    with native.scope("work-root-boundary") as state:
        work = state.home / "work"
        child = work / ".tmp" / "inspection"
        child.mkdir()
        foreign = work / "another-home"
        foreign.mkdir()
        (foreign / "config.yaml").write_text("{}", encoding="utf-8")
        (foreign / "state.db").touch()
        other_image = foreign / "frame.png"
        other_image.write_bytes(state.path.read_bytes())
        outside = state.home.parent / "outside-frame.png"
        outside.write_bytes(state.path.read_bytes())
        alias = work / "outside-link.png"
        alias.symlink_to(outside)
        register_task_env_overrides(
            "same-session", {"env_type": "local", "cwd": str(work)}
        )
        record_session_cwd("same-session", str(child))
        try:
            for path in [other_image, alias]:
                result = json.loads(native.execute(TOOL, {"path": str(path)}))
                assert "error" in result
                assert (
                    "别的账号" in result["error"]
                    if path == other_image
                    else "范围" in result["error"]
                )
            assert not native.calls and not native.puts
        finally:
            clear_task_env_overrides("same-session")
