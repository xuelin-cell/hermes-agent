"""PPT 的版面检查和配图规则：只为真问题返工，不让看不到图的模型去看图。

版面检查走真实的 deck_geometry.measure；配图规则按测试 home 里真实的 config.yaml 判断看图能力。
"""

from tests.plugins.test_uniwork_kits_plugin import _deck_with, _write, kits, profile_env  # noqa: F401 - fixtures


def _line(shape_id: int, top_in: float, text: str) -> str:
    """一行 14 磅文字，左右对齐、内边距为 0，便于按位置控制上下间距。"""
    y = int(top_in * 914400)
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="t{shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="914400" y="{y}"/><a:ext cx="5486400" cy="457200"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>'
        f'<a:p><a:r><a:rPr sz="1400"/><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


def test_text_that_only_sits_close_is_noted_while_overlapping_text_is_sent_back(kits, tmp_path):
    """两行字靠得近但没叠上：不退回，只在说明里提一句；真的叠上了：照旧必须改。"""
    close = tmp_path / "close.pptx"
    _deck_with(close, slide_extra=_line(11, 1.0, "第一行正文内容") + _line(12, 1.21, "第二行正文内容"))
    report = kits.deck_geometry.measure(close.read_bytes())
    assert report.ok, report.as_text()
    assert any("靠得很近" in note for note in report.notes)

    overlapping = tmp_path / "overlap.pptx"
    _deck_with(overlapping, slide_extra=_line(11, 1.0, "第一行正文内容") + _line(12, 1.1, "第二行正文内容"))
    report = kits.deck_geometry.measure(overlapping.read_bytes())
    assert not report.ok and any(item.kind == "crowded" for item in report.problems)


def test_picture_rules_ask_for_a_visual_check_only_when_the_vision_tool_can_see(kits, profile_env):
    """看图工具交给看不到图的主模型时，规则不让模型看图核对；配了看图模型后，看图核对回来。"""
    blind = kits.media_slot.picture_rules()
    assert "vision_analyze" in blind and "自己看图检查" not in blind

    config = profile_env / "config.yaml"
    _write(config, config.read_text(encoding="utf-8") + "auxiliary:\n  vision:\n    provider: openrouter\n")
    seeing = kits.media_slot.picture_rules()
    assert "自己看图检查" in seeing and "vision_analyze" not in seeing
