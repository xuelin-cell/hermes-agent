"""我们依赖的 hermes 行为。合并上游 hermes 之后跑一遍：这里红了，说明某个假设变了，
入口、转发器或垫片里对应的那处要跟着改。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

web = pytest.importorskip("hermes_cli.web_server")
from fastapi import HTTPException  # noqa: E402

from hermes_cli.web_models import ManagedFileDelete  # noqa: E402


@pytest.fixture
def instance_layout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """照实例的布局：HERMES_HOME 在本地盘，home 下的 workspace 是指向卷的链接；
    沙箱镜像（Dockerfile.cube）把 HERMES_DASHBOARD_FILES_ROOT 设成这个链接。"""
    home = tmp_path / "opt-data"
    volume_workspace = tmp_path / "mnt-u" / "workspace"
    home.mkdir()
    volume_workspace.mkdir(parents=True)
    (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    try:
        os.symlink(str(volume_workspace), str(home / "workspace"), target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("这台机器不允许建符号链接")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_DASHBOARD_FILES_ROOT", str(home / "workspace"))
    return home, volume_workspace.resolve()


@pytest.mark.asyncio
async def test_delete_is_confined_to_the_workspace_on_the_volume(instance_layout: tuple[Path, Path]) -> None:
    """浏览器版的「删除」调 DELETE /api/files（垫片 trashPath）。hermes 解开链接后把卷上的
    工作区当受管目录：文件树里给的就是卷上的真实路径，删得掉；工作区以外删不掉。"""
    home, workspace = instance_layout
    (workspace / "a.txt").write_text("x", encoding="utf-8")
    (workspace / "dir").mkdir()
    (workspace / "dir" / "b.txt").write_text("y", encoding="utf-8")
    (workspace / "c.txt").write_text("z", encoding="utf-8")

    await web.delete_managed_file(ManagedFileDelete(path=str(workspace / "a.txt")), None)
    assert not (workspace / "a.txt").exists()

    # 文件夹连同内容一起删（垫片总是带 recursive）。
    await web.delete_managed_file(ManagedFileDelete(path=str(workspace / "dir"), recursive=True), None)
    assert not (workspace / "dir").exists()

    # 经 home 下的链接给路径也行。
    await web.delete_managed_file(ManagedFileDelete(path=str(home / "workspace" / "c.txt")), None)
    assert not (workspace / "c.txt").exists()

    # 工作区以外（配置、对话库所在的 HERMES_HOME）一律 403，垫片据此提示「只能删除工作区里的文件」。
    with pytest.raises(HTTPException) as outside:
        await web.delete_managed_file(ManagedFileDelete(path=str(home / "config.yaml")), None)
    assert outside.value.status_code == 403
    assert (home / "config.yaml").exists()

    # 工作区根目录本身删不掉。
    with pytest.raises(HTTPException) as root:
        await web.delete_managed_file(ManagedFileDelete(path=str(workspace), recursive=True), None)
    assert root.value.status_code == 400
    assert workspace.is_dir()

    # 已经不在的路径回 404，垫片把它当成删除成功。
    with pytest.raises(HTTPException) as missing:
        await web.delete_managed_file(ManagedFileDelete(path=str(workspace / "gone.txt")), None)
    assert missing.value.status_code == 404


# ---- 第 2 批（10-09）新依赖的 hermes 行为 ----------------------------------------------------


def test_per_model_context_length_is_read_from_the_providers_block() -> None:
    """E5：入口把套餐的 context_window 写成 providers.<key>.models.<模型>.context_length；
    hermes 启动和切模型时都靠 get_custom_provider_context_length 读它，决定什么时候压缩上下文。"""
    from hermes_cli.config import get_compatible_custom_providers, get_custom_provider_context_length

    cfg = {
        "model": {"default": "m1", "provider": "yuanjing", "base_url": "http://plan/v1"},
        "providers": {"yuanjing": {"api": "http://plan/v1", "key_env": "K", "transport": "chat_completions",
                                   "models": {"m1": {"context_length": 300000}, "m2": {}}}},
    }
    providers = get_compatible_custom_providers(cfg)
    assert get_custom_provider_context_length("m1", "http://plan/v1", providers) == 300000
    assert get_custom_provider_context_length("m2", "http://plan/v1", providers) is None


def test_reasoning_override_per_model_and_spelling_tolerance() -> None:
    """E4：agent.reasoning_overrides 按模型盖过全局默认；转发器判断「用户自己设过」时把点和横线当一样，
    依据是 hermes 匹配时也这么宽。"""
    from hermes_constants import parse_reasoning_effort, resolve_reasoning_config

    cfg = {"agent": {"reasoning_overrides": {"deepseek-v4.1-flash": "high"}}}
    assert resolve_reasoning_config(cfg, "deepseek-v4.1-flash") == parse_reasoning_effort("high")
    assert resolve_reasoning_config(cfg, "deepseek-v4-1-flash") == parse_reasoning_effort("high")
    assert resolve_reasoning_config(cfg, "glm-5.2") == parse_reasoning_effort("")


def test_platform_policy_keys_exist_in_hermes_defaults() -> None:
    """E5：平台策略写的开关是 hermes 真认的键（改名了这里会红）。"""
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    assert DEFAULT_CONFIG["model_catalog"]["enabled"] is True
    assert DEFAULT_CONFIG["security"]["allow_lazy_installs"] is True
    assert DEFAULT_CONFIG["onboarding"]["profile_build"] == "ask"

    # 首次对话：profile_build 为 off 时只给简短自我介绍的提示，不提出建用户画像。
    from agent.onboarding import profile_build_mode

    assert profile_build_mode({"onboarding": {"profile_build": "off"}}) == "off"
    assert profile_build_mode(DEFAULT_CONFIG) == "ask"

    # 默认推理强度：没有按模型设置的模型，用 agent.reasoning_effort（它不在 DEFAULT_CONFIG 里，hermes 读时缺省为空）。
    from hermes_constants import parse_reasoning_effort, resolve_reasoning_config

    cfg = {"agent": {"reasoning_effort": "high", "reasoning_overrides": {"glm-5.2": "max"}}}
    assert resolve_reasoning_config(cfg, "glm-5.3-flash") == parse_reasoning_effort("high")
    assert resolve_reasoning_config(cfg, "glm-5.2") == parse_reasoning_effort("max")


def test_orphan_reap_grace_env_var_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    """F9：断线后会话保留多久，沙箱镜像用环境变量统一设，不改每个用户的 config.yaml。"""
    server = pytest.importorskip("tui_gateway.server")  # Windows 上缺 concurrent_log_handler，到 Linux 里验

    monkeypatch.setenv("HERMES_TUI_WS_ORPHAN_REAP_GRACE_S", "3600")
    assert server._resolve_ws_orphan_reap_grace() == 3600.0


def test_environment_hint_env_var_reaches_the_system_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    """E8：镜像里的 HERMES_ENVIRONMENT_HINT 原样进 agent 的系统提示。"""
    from agent.prompt_builder import build_environment_hints

    monkeypatch.setenv("HERMES_ENVIRONMENT_HINT", "The user works in a web page; never suggest file:// URLs.")
    assert "never suggest file:// URLs" in build_environment_hints()


YUANJING_MCP_URL = "https://maas.example/mcp?key=${HERMES_CUSTOM_YUANJING_API_KEY}&client_id=UniWork"


def test_mcp_url_takes_the_key_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """E11：内置元景 MCP 的地址里只写 ${HERMES_CUSTOM_YUANJING_API_KEY}，hermes 连接时换成 .env 里的 key。"""
    mcp_tool = pytest.importorskip("tools.mcp_tool")

    monkeypatch.setenv("HERMES_CUSTOM_YUANJING_API_KEY", "sk-test-0000")
    resolved = mcp_tool._interpolate_env_vars({"url": YUANJING_MCP_URL, "timeout": 600})
    assert resolved == {"url": "https://maas.example/mcp?key=sk-test-0000&client_id=UniWork", "timeout": 600}


def test_saving_the_config_keeps_the_key_placeholder() -> None:
    """E11：hermes 读配置时把 ${…} 展开；用户改了别的设置、hermes 存回去时，那个地址照原样写回 ${…}，key 不落进 config.yaml。"""
    from hermes_cli.config import _preserve_env_ref_templates

    expanded = YUANJING_MCP_URL.replace("${HERMES_CUSTOM_YUANJING_API_KEY}", "sk-test-0000")
    raw = {"mcp_servers": {"yuanjing": {"url": YUANJING_MCP_URL}}, "display": {"personality": "kawaii"}}
    loaded = {"mcp_servers": {"yuanjing": {"url": expanded}}, "display": {"personality": "kawaii"}}
    saved = {"mcp_servers": {"yuanjing": {"url": expanded}}, "display": {"personality": "concise"}}
    kept = _preserve_env_ref_templates(saved, raw, loaded)
    assert kept == {"mcp_servers": {"yuanjing": {"url": YUANJING_MCP_URL}}, "display": {"personality": "concise"}}


def test_logs_mask_an_sk_key_in_an_mcp_address() -> None:
    """E11：hermes 的 HTTP 日志会打出整个地址；写进日志文件前，sk- 开头的 key 按前缀打码。"""
    from agent.redact import redact_sensitive_text

    key = "sk-" + "0a1b2c3d" * 4
    line = f"HTTP Request: POST https://maas.example/mcp?key={key}&client_id=UniWork \"HTTP/1.1 200 OK\""
    masked = redact_sensitive_text(line)
    assert key not in masked and "client_id=UniWork" in masked
