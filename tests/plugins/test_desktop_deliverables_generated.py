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
