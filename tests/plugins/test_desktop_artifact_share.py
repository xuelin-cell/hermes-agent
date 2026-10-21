"""桌面发行插件通过真实发现链注册桌面会话专用的分享工具。"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path


def test_desktop_share_tool_is_scoped_to_desktop_toolset(tmp_path, monkeypatch):
    """真实发现和工具分发链只向桌面提供分享，并观测实际文件写入。"""
    import hermes_cli.plugins as plugins
    from model_tools import get_tool_definitions, handle_function_call
    from tools.terminal_tool import record_session_cwd
    from hermes_cli.lifecycle import invoke_hook

    events = []

    def bridge(request, timeout):
        """模拟桌面接收端，保留由真实钩子准备的来源事件。"""
        events.append(json.loads(request.data))
        return io.BytesIO(b'{"ok":true}')

    monkeypatch.setattr(urllib.request, "urlopen", bridge)
    monkeypatch.setenv("HERMES_ARTIFACT_SHARE_BRIDGE", "http://127.0.0.1:12345")
    monkeypatch.setenv("HERMES_ARTIFACT_SHARE_TOKEN", "test-token")

    source = Path(__file__).resolve().parents[2] / "apps/desktop/assets/artifact-share-plugin"
    home = tmp_path / "home"
    (home / "plugins").mkdir(parents=True)
    shutil.copytree(source, home / "plugins/desktop-artifact-share")
    (home / "config.yaml").write_text(
        "plugins:\n  enabled: [desktop-artifact-share]\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))

    plugins.discover_plugins(force=True)
    assert "HERMES_ARTIFACT_SHARE_TOKEN" not in os.environ

    def names(toolsets):
        """读取真实工具解析器返回的函数名称。"""
        return {
            item["function"]["name"]
            for item in get_tool_definitions(enabled_toolsets=toolsets, quiet_mode=True)
            if item.get("type") == "function"
        }

    assert "publish_artifact" in names(["desktop_ui"])
    assert "publish_artifact" not in names(["terminal"])
    names(["file", "terminal"])
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(workspace))
    record_session_cwd("origin-task", str(workspace))
    invoke_hook("pre_llm_call", session_id="s", task_id="origin-task", platform="desktop", is_first_turn=True, user_message="create a page")
    result = json.loads(handle_function_call("write_file", {"path": str(workspace / "page.html"), "content": "<p>model</p>"},
                                             task_id="origin-task", session_id="s", tool_call_id="write-1"))
    assert not result.get("error"), result
    assert any(event.get("files", [{}])[0].get("path") == str((workspace / "page.html").resolve()) for event in events if event.get("files"))
    result = json.loads(handle_function_call("terminal", {"command": "test -z \"$HERMES_ARTIFACT_SHARE_TOKEN\" && printf '<p>terminal</p>' > from-terminal.html"},
                                             task_id="origin-task", session_id="s", tool_call_id="terminal-1"))
    assert not result.get("error"), result
    assert any(file["path"] == str((workspace / "from-terminal.html").resolve()) for event in events for file in event.get("files", []))
    invoke_hook("post_llm_call", session_id="s", platform="desktop", assistant_response="```html\n<html>confirmed</html>\n```")
    assert events[-1]["contents"] == ["<html>confirmed</html>"]
    from hermes_state import SessionDB

    database = SessionDB(home / "state.db")
    database.create_session("s", source="desktop")
    database.create_session("continued", source="desktop", parent_session_id="s")
    database.close()
    invoke_hook("post_llm_call", session_id="continued", platform="desktop", assistant_response="```html\n<html>continued</html>\n```")
    assert events[-1]["parentSessionId"] == "s"
    invoke_hook("pre_llm_call", session_id="s", platform="desktop", user_message=[{"type": "image_url", "image_url": {"url": "data:image/png;base64,a"}}])
    assert events[-1]["hasUploads"] is True
    assert events[0]["profileHome"] == str(home)
    other = tmp_path / "other-home"
    (other / "plugins").mkdir(parents=True)
    shutil.copytree(source, other / "plugins/desktop-artifact-share")
    (other / "config.yaml").write_text("plugins:\n  enabled: [desktop-artifact-share]\n", encoding="utf-8")
    for current in (home, other, home):
        monkeypatch.setenv("HERMES_HOME", str(current))
        plugins.discover_plugins(force=True)
        invoke_hook("pre_llm_call", session_id="scope-test", platform="desktop", is_first_turn=True)
        assert events[-1]["profileHome"] == str(current)


def test_publish_uses_workspace_file_without_copy_and_rejects_escape(tmp_path, monkeypatch):
    """直接发布工作区根目录和子目录产物，越界路径不发起上传。"""
    from tools import terminal_tool

    source = Path(__file__).resolve().parents[2] / "apps/desktop/assets/artifact-share-plugin/__init__.py"
    spec = importlib.util.spec_from_file_location("desktop_share_test", source, submodule_search_locations=[str(source.parent)])
    plugin = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, plugin)
    spec.loader.exec_module(plugin)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "outputs").mkdir()
    monkeypatch.setattr(terminal_tool, "get_session_cwd", lambda task_id: str(workspace))
    monkeypatch.setenv("HERMES_ARTIFACT_SHARE_BRIDGE", "http://127.0.0.1:12345")
    monkeypatch.setenv("HERMES_ARTIFACT_SHARE_TOKEN", "bridge-test-token")
    sent = []

    def upload(route, payload, **kwargs):
        """记录真实工具准备的请求，不连接公网服务。"""
        if route == "/eligibility":
            return {"publishable": True}
        sent.append(payload)
        return {"shareId": "test-id", "url": "https://share.example/test", "version": 1, "expiresAt": "2030-01-02T00:00:00Z"}

    monkeypatch.setattr(plugin, "call_bridge", upload)
    for name in ("hello-world.html", "outputs/report.html"):
        (workspace / name).write_text("<p>hello</p>", encoding="utf-8")
        result = json.loads(plugin._handle_publish({"path": name, **({"ttl_days": 3} if name.startswith("outputs/") else {})}, task_id="task", session_id="session"))
        assert result["url"] == "https://share.example/test"
        assert result["expires_at"] == "2030-01-02T00:00:00Z"
        assert sent[-1].get("ttlDays") == (3 if name.startswith("outputs/") else None)
        assert sent[-1]["key"] == f"file:session:{(workspace / name).resolve()}"

    for invalid in (0, 8, 1.5, True):
        result = json.loads(plugin._handle_publish({"path": "hello-world.html", "ttl_days": invalid}, task_id="task", session_id="session"))
        assert "error" in result
    assert len(sent) == 2
    (tmp_path / "outside.html").write_text("<p>private</p>", encoding="utf-8")
    result = json.loads(plugin._handle_publish({"path": "../outside.html"}, task_id="task", session_id="session"))
    assert "error" in result
    assert len(sent) == 2
    monkeypatch.setattr(plugin, "call_bridge", lambda route, payload, **kwargs: {"publishable": False})
    result = json.loads(plugin._handle_publish({"path": "hello-world.html"}, task_id="task", session_id="session"))
    assert "来源" in result["error"]
