"""正式 Agent、插件协作、生成工具结果、下载和历史持久化的链路验证。"""

import pytest

from tests.plugins.desktop_deliverables_generated_fixture import run_scenario


@pytest.mark.parametrize("kind", ["fallback", "image", "video", "audio", "offline"])
def test_generated_result_survives_actual_conversation_and_database_reopen(
    tmp_path, kind
):
    """仅生成服务和模型响应受控，插件、工具、网络、文件和数据库均真实执行。"""
    receipt = run_scenario(tmp_path, kind)
    assert receipt["text"].count("MEDIA:") == (0 if kind == "offline" else 1)


@pytest.mark.parametrize(
    "kind",
    ["background-translation", "background-podcast", "background-video", "background-image-video", "background-other"],
)
def test_native_subagent_caches_deliverable_before_parent_receives_result(tmp_path, kind):
    """原生委派、工具调用、真实 HTTP 缓存和父会话持久化共同完成预览交付。"""
    receipt = run_scenario(tmp_path, kind)
    assert receipt["text"].count("MEDIA:") == (0 if kind == "background-other" else 1)


@pytest.mark.parametrize("platform,kind,available", [
    ("weixin", "background-podcast", True),
    ("weixin", "background-translation", True),
    ("telegram", "background-podcast", True),
    ("weixin", "background-podcast", False),
    ("weixin", "background-other", True),
    ("weixin", "background-video", True),
    ("weixin", "background-image-video", True),
    ("feishu", "background-video", True),
    ("wecom", "background-image-video", True),
    ("weixin", "background-video", False),
    ("dingtalk", "background-video", True),
    ("telegram", "background-video", True),
])
def test_message_background_delivers_only_cached_business_artifacts(tmp_path, platform, kind, available):
    """消息父会话沿原生子代理链路缓存后台成品；钉钉和其他平台的视频、其他工具不下载，失败保留链接。"""
    from pathlib import Path

    receipt = run_scenario(tmp_path, kind, platform=platform, download_available=available)
    videos = {"background-video", "background-image-video"}
    expected = available and (
        kind in {"background-podcast", "background-translation"}
        or (kind in videos and platform in {"weixin", "feishu", "wecom"})
    )
    assert receipt["text"].count("MEDIA:") == int(expected)
    if expected:
        assert Path(receipt["path"]).is_file()
        from gateway.platforms.base import BasePlatformAdapter, validate_media_delivery_path

        media, text = BasePlatformAdapter.extract_media(receipt["text"])
        assert media == [(receipt["path"], False)]
        assert "MEDIA:" not in text
        assert validate_media_delivery_path(receipt["path"]) == receipt["path"]
    else:
        assert receipt["url"] in receipt["text"]
        assert not list((tmp_path / "workspace").rglob("*.part"))
