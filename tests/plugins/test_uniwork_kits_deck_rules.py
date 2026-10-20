"""PPT 的版面检查和配图规则：只为真问题返工，不让看不到图的模型去看图。

版面检查走真实的 deck_geometry.measure；配图规则按测试 home 里真实的 config.yaml 判断看图能力。
"""

import os
import time

from tests.plugins.test_uniwork_kits_plugin import (  # noqa: F401 - fixtures
    _deck_with,
    _png,
    _pptx,
    _rewrite,
    _turn,
    _write,
    kits,
    profile_env,
)


def _line(shape_id: int, top_in: float, text: str) -> str:
    """一行 14 磅文字，左右对齐、内边距为 0，便于按位置控制上下间距。"""
    y = int(top_in * 914400)
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="t{shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="914400" y="{y}"/><a:ext cx="5486400" cy="457200"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>'
        f'<a:p><a:r><a:rPr sz="1400"/><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


def _filled(shape_id: int, x_in: float, y_in: float, w_in: float, h_in: float, prst: str = "ellipse") -> str:
    """一个实色填充、没有文字的形状（图标或卡片底色）。"""
    x, y, w, h = (int(v * 914400) for v in (x_in, y_in, w_in, h_in))
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="s{shape_id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'
        f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="1F3B57"/></a:solidFill></p:spPr></p:sp>'
    )


def test_a_shape_drawn_over_a_title_is_sent_back_but_a_card_under_text_is_not(kits, tmp_path):
    """后画的图标压住标题：必须改；字底下先画的卡片：正常。"""
    covered = tmp_path / "covered.pptx"
    _deck_with(covered, slide_extra=_line(11, 1.0, "AI 应用全景：从研发设计到物流交付") + _filled(12, 2.0, 0.95, 0.6, 0.6))
    report = kits.deck_geometry.measure(covered.read_bytes())
    assert any(item.kind == "covered_text" for item in report.problems), report.as_text()

    carded = tmp_path / "carded.pptx"
    _deck_with(carded, slide_extra=_filled(12, 0.8, 0.8, 6.4, 0.9, "rect") + _line(11, 1.0, "AI 应用全景：从研发设计到物流交付"))
    report = kits.deck_geometry.measure(carded.read_bytes())
    assert not any(item.kind == "covered_text" for item in report.problems), report.as_text()


def test_program_values_left_on_a_slide_are_sent_back_but_prose_is_not(kits, tmp_path):
    """页面上留着 [object Object]、或中文里夹着 NaN：脚本取数据写错了，必须改；英文正文里正常出现 undefined 不算。"""
    for text in ("[object Object],[object Object]", "同比增长NaN%"):
        deck = tmp_path / "bad.pptx"
        _deck_with(deck, slide_extra=_line(11, 1.0, text))
        report = kits.deck_geometry.measure(deck.read_bytes())
        assert any(item.kind == "bad_text" for item in report.problems), text

    prose = tmp_path / "prose.pptx"
    _deck_with(prose, slide_extra=_line(11, 1.0, "Avoid undefined behavior in C"))
    assert not any(item.kind == "bad_text" for item in kits.deck_geometry.measure(prose.read_bytes()).problems)


def test_an_old_deck_this_request_only_mentions_is_not_checked(kits, tmp_path):
    """工作区里以前的 PPT 只是被提到、没被改：不检查，不占退回次数；这一轮重写之后照常检查。"""
    kits.turns.clear()
    old = tmp_path / "old.pptx"
    _pptx(old, _png(20, 20), (914400, 914400), origin=(-2 * 914400, 0))  # 有出界问题的旧文件
    hour_ago = time.time_ns() - 3600 * 10**9
    os.utime(old, ns=(hour_ago, hour_ago))
    turn = _turn(kits)

    assert kits.deck_check.annotate("read_file", {"path": str(old)}, "1|const pptx = ...", turn) is None
    assert turn.bounces == 0

    _rewrite(old, _png(20, 20), (914400, 914400), origin=(-2 * 914400, 0))
    assert "没有交付" in kits.deck_check.annotate("write_file", {"path": str(old)}, "ok", turn)


def test_a_deck_request_asks_for_the_script_in_parts_but_its_subagents_only_write_their_part(kits, profile_env):
    """要做 PPT 的那一轮带着分份写脚本的规则；父任务派出的子任务只写自己那一份，不收这套规则，配图规则照给。"""
    context = kits.router.on_pre_llm_call(user_message="帮我做一份 20 页的幻灯片", platform="desktop")["context"]
    assert kits.deck_check.BUILD_RULES in context

    child = kits.router.on_pre_llm_call(
        user_message="写这份幻灯片第 5～9 页的分页文件 slides_2.js", platform="desktop",
        session_id="child-1", turn_id="t1", parent_session_id="parent-1",
    )["context"]
    assert kits.deck_check.BUILD_RULES not in child and "PPT 配图原则" in child


def test_the_deck_rules_point_at_a_layout_library_that_ships_with_the_plugin(kits):
    """做 PPT 的规则让模型 require 版式库、先读它的说明：两个路径都得是插件里真实存在的文件，移动了库就会在这里失败。"""
    rules = kits.deck_check.BUILD_RULES
    for path in (kits.deck_check.DECK_LIBRARY, kits.deck_check.DECK_LIBRARY_GUIDE):
        assert path in rules
        assert os.path.isfile(path), path


def test_the_uniai_watermark_stands_in_for_the_ai_label_but_other_generators_still_need_one(kits):
    """UniAI 生成的图自带水印：规则和交付前核对都不再要求另加「AI 生成」，改为别裁掉、别盖住水印；换成别的生图工具仍要加。"""
    ms = kits.media_slot
    uniai = ms.MediaSlot("mcp__UniAI_Toolkit__txt2img_generate", "", "mcp__UniAI_Toolkit__image_search", "UniAI-Toolkit")
    other = ms.MediaSlot("image_generate", "", "mcp__UniAI_Toolkit__image_search", "UniAI-Toolkit")

    rules = ms.picture_rules(uniai, can_see=False)
    assert ms.UNIAI_WATERMARK in rules and "一律标「AI 生成」" not in rules
    assert "一律标「AI 生成」" in ms.picture_rules(other, can_see=False)

    review = kits.deck_check.format_generated_review(["水墨风 孙悟空"], 0, watermarked=True)
    assert ms.UNIAI_WATERMARK in review and "一处「AI 生成」都没有" not in review
    assert "一处「AI 生成」都没有" in kits.deck_check.format_generated_review(["水墨风 孙悟空"], 0)


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
