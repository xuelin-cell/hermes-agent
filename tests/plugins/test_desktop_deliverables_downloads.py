"""本机 HTTP 流式下载、生成工具白名单及失败保留原结果的真实边界。"""

import json
import os
from pathlib import Path

import pytest

from tests.plugins.desktop_deliverables_http_fixture import serving

from tests.plugins.test_desktop_deliverables_fallback import delivery, begin, finish  # noqa: F401


def call(plugin, name, result, **kwargs):
    """通过实际注册表和原生协程解析器调用钩子，缺少注册即保持原结果。"""
    from hermes_cli.plugins import resolve_plugin_command_result

    hooks = {}

    class Context:
        """只收集插件公开注册，避免绕过正式入口直接调用内部实现。"""

        def register_hook(self, name, handler):
            """与原生上下文一样保存具名钩子。"""
            hooks[name] = handler

    plugin.register(Context())
    handler = hooks.get("transform_tool_result")
    return (
        resolve_plugin_command_result(
            handler(
                tool_name=name, result=result, session_id="s", turn_id="t", **kwargs
            )
        )
        if handler
        else None
    )


@pytest.mark.parametrize(
    "tool,extension",
    [
        ("txt2img_generate", "png"),
        ("img2vid_generate", "mp4"),
        ("tts_synthesize", "wav"),
    ],
)
def test_generated_media_is_downloaded_and_carded_without_reply_path(
    delivery, monkeypatch, tool, extension
):
    """图片、视频和语音都由真实下载落盘，不需要结束语声明产物。"""
    plugin, work = delivery
    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    begin(plugin)
    with serving() as (base, requests):
        url = base + f"/生成.{extension}?signature=private"
        original = json.dumps({"url": url, "metadata": "keep"})
        result = call(plugin, "mcp__server__" + tool, original)
        assert result is not None
        data = json.loads(result)
        assert data["url"] == url and data["metadata"] == "keep"
        output = Path(data["desktop_deliverables"][0])
        assert output.parent == work / "outputs"
        assert output.suffix == "." + extension and output.read_bytes().startswith(
            b"file-content"
        )
        assert str(output) in finish(plugin)
        assert len(requests) == 1


def test_budget_duplicates_search_and_ssrf_boundaries(delivery, monkeypatch, caplog):
    """每轮最多四次尝试，重复不下载，搜索／伪工具不触网，默认拒绝内网。"""
    plugin, work = delivery
    begin(plugin)
    with serving() as (base, requests):
        text = json.dumps({"url": base + "/image.png?signature=private"})
        for name in ("image_search", "web_search", "not_txt2img_generate"):
            assert call(plugin, name, text) is None
        assert not requests
        assert call(plugin, "txt2img_generate", text) is None
        assert not requests
        assert "signature=private" not in caplog.text
        begin(plugin)
        monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
        for _ in range(2):
            assert call(plugin, "txt2img_generate", text)
        assert len(requests) == 1
        for index in range(7):
            call(plugin, "doc_translate", base + f"/report-{index}.pdf")
        assert len(requests) == 4
        assert len(list((work / "outputs").iterdir())) == 4


def test_failures_preserve_links_and_remove_partial_files(delivery, monkeypatch):
    """拒绝超限、空响应、失败、危险跳转、慢流及断网，不遗留半文件或伪卡。"""
    plugin, work = delivery
    from fallback_delivery import downloads

    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    monkeypatch.setattr(downloads, "MAX_BYTES", 20_000)
    monkeypatch.setattr(downloads, "TIMEOUT", 2)
    with serving() as (base, requests):
        for endpoint in (
            "declared",
            "stream",
            "empty",
            "failure",
            "bad-redirect",
            "slow",
        ):
            begin(plugin)
            original = base + f"/{endpoint}.png?signature=keep-original"
            assert call(plugin, "txt2img_generate", original) is None
            assert finish(plugin) is None
            assert not list((work / "outputs").iterdir())
        # 正常跳转仍可用，失败后的下一轮也不受影响。
        begin(plugin)
        monkeypatch.setattr(downloads, "TIMEOUT", 20)
        assert call(plugin, "txt2img_generate", base + "/redirect.png")
    begin(plugin)
    assert call(plugin, "txt2img_generate", base + "/offline.png") is None
    assert finish(plugin) is None


def test_trusted_generator_storage_matches_only_its_own_paths(delivery):
    """可信范围只认对象存储域名、https 和各工具的成品目录，其它一律照常检查。"""
    from fallback_delivery.downloads import trusted

    host = "https://obs-nmhhht6.cucloud.cn"
    signed = "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc"
    image = host + "/yuanjing-t2i-oss/mllm/yuanjingt2i/2026-10-19/a.png" + signed
    video = host + "/app-agent-prod/videos/5a25.mp4" + signed
    assert trusted("mcp__UniAI_Toolkit__txt2img_generate", image)
    assert trusted("mcp__1__txt2vid_generate", video)
    assert trusted("img2vid_generate", video)
    assert trusted("tts_synthesize", host + "/app-agent-prod/temp/a.wav")
    assert trusted("doc_translate", host + "/app-agent-prod/translate/a.pdf")
    for name, url in [
        ("txt2img_generate", video),
        ("txt2vid_generate", image),
        ("image_search", image),
        ("txt2vid_generate", video.replace("https://", "http://")),
        ("txt2vid_generate", video.replace("cucloud.cn", "cucloud.cn.evil.com")),
        ("txt2vid_generate", video.replace("obs-nmhhht6", "user@obs-nmhhht6")),
        ("txt2vid_generate", video.replace(".cn/", ".cn:8443/")),
        ("txt2vid_generate", video + "#x"),
        ("txt2vid_generate", host + "/app-agent-prod/videos/../temp/a.mp4"),
        ("txt2vid_generate", host + "/app-agent-prod/videos/%2e%2e/temp/a.mp4"),
        ("txt2vid_generate", "https://[::1"),
    ]:
        assert not trusted(name, url), url


def test_trusted_storage_skips_private_check_but_not_redirect_limits(
    delivery, monkeypatch
):
    """代理把可信成品解析成保留地址时仍能下载；跳出可信范围的跳转照样拒绝。"""
    plugin, work = delivery
    from fallback_delivery import downloads

    # 内网检查保持默认开启：不免检的本机链接必然被拒。httpx 会读 Windows 系统代理设置，
    # 本机地址因此走不受连接期检查的绕过通道；这里去掉系统代理，确保免检靠的是普通客户端。
    monkeypatch.setattr("httpx._client.get_environment_proxies", lambda: {})
    monkeypatch.setattr(
        downloads, "trusted", lambda name, url: "/video" in url or "/redirect" in url
    )
    with serving() as (base, requests):
        begin(plugin)
        result = call(plugin, "txt2vid_generate", base + "/video.mp4?signature=x")
        # 非 JSON 结果在原文后追加“已下载到本机”和本地路径。
        output = Path(result.rsplit("\n", 1)[-1])
        assert output.parent == work / "outputs" and output.read_bytes()
        assert len(requests) == 1

        begin(plugin)
        assert call(plugin, "txt2vid_generate", base + "/redirect.mp4") is None
        assert requests[-1].startswith("/redirect")
        assert len(list((work / "outputs").iterdir())) == 1

        begin(plugin)
        assert call(plugin, "txt2vid_generate", base + "/other.mp4") is None
        assert len(requests) == 2


def test_linked_outputs_directory_is_not_written(delivery, tmp_path, monkeypatch):
    """不能利用 outputs 联接把下载写到账号工作区之外。"""
    plugin, work = delivery
    import subprocess

    outside = tmp_path / "outside"
    outside.mkdir()
    if os.name == "nt":
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(work / "outputs"), str(outside)],
            check=True,
            capture_output=True,
        )
    else:
        (work / "outputs").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    begin(plugin)
    with serving() as (base, requests):
        assert call(plugin, "txt2img_generate", base + "/image.png") is None
        assert not requests
    assert not list(outside.iterdir())


def test_downloads_follow_the_owning_account_when_switching_back(
    delivery, tmp_path, monkeypatch
):
    """相同会话标识经过 A→B→A 时，下载与卡片只回到各自的工作目录。"""
    plugin, work = delivery
    original = os.environ["HERMES_HOME"]
    other = tmp_path / "B-work"
    other.mkdir()
    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    with serving() as (base, requests):
        begin(plugin)
        first = json.loads(
            call(plugin, "txt2img_generate", json.dumps({"url": base + "/A.png"}))
        )["desktop_deliverables"][0]
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "B-home"))
        monkeypatch.setenv("TERMINAL_CWD", str(other))
        begin(plugin)
        second = json.loads(
            call(plugin, "txt2img_generate", json.dumps({"url": base + "/B.png"}))
        )["desktop_deliverables"][0]
        assert Path(second).is_relative_to(other)
        response = finish(plugin)
        assert second in response and first not in response
        monkeypatch.setenv("HERMES_HOME", original)
        monkeypatch.setenv("TERMINAL_CWD", str(work))
        response = finish(plugin)
        assert Path(first).is_relative_to(work)
        assert first in response and second not in response


def test_failed_mcp_result_never_downloads_the_link(delivery, monkeypatch):
    """MCP 的 isError 标记即便携带可下载链接，也不能被当成成功成品。"""
    plugin, work = delivery
    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    begin(plugin)
    with serving() as (base, requests):
        result = json.dumps({
            "isError": True,
            "content": [{"type": "text", "text": base + "/partial.png"}],
        })
        assert call(plugin, "txt2img_generate", result) is None
        assert not requests
