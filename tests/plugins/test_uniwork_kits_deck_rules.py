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


def _tall_line(top_in: float, height_in: float, text: str) -> str:
    """一行字放在一个更高的框顶部，下面留空。"""
    y, h = int(top_in * 914400), int(height_in * 914400)
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="11" name="t11"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="914400" y="{y}"/><a:ext cx="5486400" cy="{h}"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/>'
        f'<a:p><a:r><a:rPr sz="1400"/><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


def _frame(shape_id: int, x_in: float, y_in: float, w_in: float, h_in: float) -> str:
    """一张有填充的卡片，用来当图片的外框。"""
    return _filled(shape_id, x_in, y_in, w_in, h_in, "roundRect")


def _picture(shape_id: int, x_in: float, y_in: float, w_in: float, h_in: float) -> str:
    """只占一个矩形的图片，不依赖真实图像字节。"""
    x, y, w, h = (int(value * 914400) for value in (x_in, y_in, w_in, h_in))
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{shape_id}" name="pic{shape_id}"/>'
        "<p:cNvPicPr/><p:nvPr/></p:nvPicPr>"
        '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def test_a_picture_stuck_to_the_top_of_its_card_is_sent_back(kits, tmp_path):
    """图贴在卡片上沿、下面留出大块空白：退回。四边只留一条细边：不退。"""
    stuck = tmp_path / "stuck.pptx"
    _deck_with(stuck, slide_extra=_frame(12, 6.0, 1.2, 5.2, 4.2) + _picture(13, 6.1, 1.3, 5.0, 3.0))
    report = kits.deck_geometry.measure(stuck.read_bytes())
    assert any(item.kind == "loose_frame" for item in report.problems), report.as_text()

    fitted = tmp_path / "fitted.pptx"
    _deck_with(fitted, slide_extra=_frame(12, 6.0, 1.2, 5.2, 3.6) + _picture(13, 6.08, 1.28, 5.04, 3.44))
    report = kits.deck_geometry.measure(fitted.read_bytes())
    assert not any(item.kind == "loose_frame" for item in report.problems), report.as_text()

    # 图上文下的图文卡片：下面那块空白放着说明文字，不是没铺满。
    captioned = tmp_path / "captioned.pptx"
    caption = _line(14, 4.5, "轻薄机身，续航十二小时").replace('x="914400"', f'x="{_emu(6.1)}"')
    _deck_with(captioned, slide_extra=_frame(12, 6.0, 1.2, 5.2, 4.2) + _picture(13, 6.1, 1.3, 5.0, 3.0) + caption)
    report = kits.deck_geometry.measure(captioned.read_bytes())
    assert not any(item.kind == "loose_frame" for item in report.problems), report.as_text()

    # 大块空白里只有一行来源小字，撑不起那块空白，仍然算没铺满。
    credited = tmp_path / "credited.pptx"
    credit = (
        '<p:sp><p:nvSpPr><p:cNvPr id="14" name="credit"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{_emu(6.1)}" y="{_emu(4.35)}"/><a:ext cx="{_emu(5.0)}" cy="{_emu(0.25)}"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square"/><a:p><a:r><a:rPr sz="800"/><a:t>图片来源：网络</a:t></a:r></a:p></p:txBody></p:sp>'
    )
    _deck_with(credited, slide_extra=_frame(12, 6.0, 1.2, 5.2, 4.2) + _picture(13, 6.1, 1.3, 5.0, 3.0) + credit)
    report = kits.deck_geometry.measure(credited.read_bytes())
    assert any(item.kind == "loose_frame" for item in report.problems), report.as_text()

    # 整页铺的背景色块不是这张图的卡片。
    backdrop = tmp_path / "backdrop.pptx"
    _deck_with(backdrop, slide_extra=_filled(12, 0, 0, 13.33, 7.5, "rect") + _picture(13, 5.2, 1.2, 4.2, 3.0))
    report = kits.deck_geometry.measure(backdrop.read_bytes())
    assert not any(item.kind == "loose_frame" for item in report.problems), report.as_text()


def test_a_large_picture_that_clips_the_glyphs_is_sent_back_but_empty_padding_is_not(kits, tmp_path):
    """大图只切进墨迹一点点也要退回；只盖住文字框底下的空白不算压字。"""
    clipped = tmp_path / "clipped.pptx"
    _deck_with(clipped, slide_extra=_line(11, 1.0, "1918年出版") + _filled(12, 1.0, 1.16, 5.0, 3.0, "rect"))
    report = kits.deck_geometry.measure(clipped.read_bytes())
    assert any(item.kind == "covered_text" for item in report.problems), report.as_text()

    padded = tmp_path / "padded.pptx"
    _deck_with(padded, slide_extra=_tall_line(1.0, 2.0, "1918年出版") + _filled(12, 1.0, 2.4, 5.0, 1.0, "rect"))
    report = kits.deck_geometry.measure(padded.read_bytes())
    assert not any(item.kind == "covered_text" for item in report.problems), report.as_text()


def _text_on_black_picture(path, color: str) -> None:
    """黑底图上放一行指定字色的字。"""
    import zipfile

    _pptx(path, _png(40, 40), (4 * 914400, 3 * 914400), origin=(914400, 914400))
    extra = (
        '<p:sp><p:nvSpPr><p:cNvPr id="11" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="1097280" y="1097280"/><a:ext cx="1828800" cy="365760"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>'
        f'<a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:rPr>'
        "<a:t>书名</a:t></a:r></a:p></p:txBody></p:sp>"
    )
    with zipfile.ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    slide = files["ppt/slides/slide1.xml"].decode("utf-8")
    files["ppt/slides/slide1.xml"] = slide.replace("</p:spTree>", extra + "</p:spTree>").encode("utf-8")
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def test_dark_text_on_a_dark_picture_is_sent_back_but_light_text_is_not(kits, tmp_path):
    """字画在图上、颜色太接近就退回；白字在黑图上能看清，不退。"""
    dark = tmp_path / "dark.pptx"
    _text_on_black_picture(dark, "000000")
    report = kits.deck_geometry.measure(dark.read_bytes())
    assert any(item.kind == "low_contrast" for item in report.problems), report.as_text()

    light = tmp_path / "light.pptx"
    _text_on_black_picture(light, "FFFFFF")
    report = kits.deck_geometry.measure(light.read_bytes())
    assert not any(item.kind == "low_contrast" for item in report.problems), report.as_text()


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


def _spaced_box(spacing: str) -> str:
    """两段 14 磅文字的文本框，行距写成 spacing（一段 lnSpc 的内层 XML）。"""
    para = "".join(
        f'<a:p><a:pPr><a:lnSpc>{spacing}</a:lnSpc></a:pPr><a:r><a:rPr sz="1400"/><a:t>{text}</a:t></a:r></a:p>'
        for text in ("全球低空经济进入规模化阶段", "国内政策窗口持续打开")
    )
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="11" name="t11"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5486400" cy="914400"/></a:xfrm></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>{para}</p:txBody></p:sp>'
    )


def test_line_spacing_written_in_points_below_the_font_size_is_sent_back(kits, tmp_path):
    """lineSpacing 是磅：写成 1.2 就是 1.2 磅，比 14 磅的字还小，两行字叠成一团，要退回；按倍数写的 120% 正常。"""
    squeezed = tmp_path / "squeezed.pptx"
    _deck_with(squeezed, slide_extra=_spaced_box('<a:spcPts val="120"/>'))
    report = kits.deck_geometry.measure(squeezed.read_bytes())
    assert any(item.kind == "tight_spacing" for item in report.problems), report.as_text()

    normal = tmp_path / "normal.pptx"
    _deck_with(normal, slide_extra=_spaced_box('<a:spcPct val="120000"/>'))
    assert not any(item.kind == "tight_spacing" for item in kits.deck_geometry.measure(normal.read_bytes()).problems)


def _chart_deck(path, label_format: str, kind: str = "barChart") -> None:
    """一页带图表的 PPT：数值 18.6、21.3，数据标签显示数值、格式为 label_format；kind 为空时只有坐标轴没有图表。"""
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
        'Target="../slideLayouts/slideLayout1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" '
        'Target="../charts/chart1.xml"/></Relationships>'
    )
    series = (
        '<c:ser><c:dLbls>'
        f'<c:numFmt formatCode="{label_format}" sourceLinked="0"/><c:showVal val="1"/></c:dLbls>'
        '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>18.6</c:v></c:pt><c:pt idx="1"><c:v>21.3</c:v></c:pt>'
        '</c:numCache></c:numRef></c:val></c:ser>'
    )
    body = f"<c:{kind}>{series}</c:{kind}>" if kind else ""
    chart = (
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea>'
        f'{body}<c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx>'
        '</c:plotArea></c:chart></c:chartSpace>'
    )
    _deck_with(path, parts={"ppt/slides/_rels/slide1.xml.rels": rels, "ppt/charts/chart1.xml": chart})


def test_a_chart_whose_decimals_are_labelled_as_whole_numbers_is_sent_back(kits, tmp_path):
    """pptxgenjs 默认的标签格式 #,##0 会把 18.6 标成 19，图和正文对不上，要退回；标签带一位小数就照实显示。"""
    rounded = tmp_path / "rounded.pptx"
    _chart_deck(rounded, "#,##0")
    report = kits.deck_geometry.measure(rounded.read_bytes())
    assert any(item.kind == "chart_rounding" for item in report.problems), report.as_text()

    exact = tmp_path / "exact.pptx"
    _chart_deck(exact, "0.0")
    assert not any(item.kind == "chart_rounding" for item in kits.deck_geometry.measure(exact.read_bytes()).problems)


def test_a_chart_with_axes_but_no_chart_is_refused_as_unopenable(kits, tmp_path):
    """类型名写错（如 'donut'）时 pptxgenjs 只写出坐标轴，PowerPoint 打不开整个文件：要退回；正常的柱状图不算。"""
    empty = tmp_path / "empty.pptx"
    _chart_deck(empty, "0.0", kind="")
    report = kits.deck_geometry.measure(empty.read_bytes())
    assert any(item.kind == "broken_chart" for item in report.problems), report.as_text()

    bar = tmp_path / "bar.pptx"
    _chart_deck(bar, "0.0")
    assert not any(item.kind == "broken_chart" for item in kits.deck_geometry.measure(bar.read_bytes()).problems)


def test_a_bounce_points_at_the_script_line_that_wrote_the_text(kits, tmp_path):
    """退回清单里的问题文字，标出它在生成脚本里的文件和行号，模型可以直接 patch 那一行。"""
    kits.turns.clear()
    project = tmp_path / "proj"
    deck = project / "deck.pptx"
    _deck_with(deck, slide_extra=_line(11, 1.0, "第一行正文内容") + _line(12, 1.1, "第二行正文内容"))
    _write(project / "slides_1.js", "module.exports = function (pptx) {\n  const s = pptx.addSlide()\n"
                                    "  s.addText('第一行正文内容', { x: 1, y: 1 })\n}\n")
    turn = _turn(kits)
    out = kits.deck_check.annotate(
        "terminal", {"command": f'cd "{project.as_posix()}" && node build.js'}, f"saved {deck.as_posix()}", turn,
    )
    assert "没有交付" in out and "slides_1.js 第 3 行" in out, out


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


def _two_lines(shape_id: int, top_in: float, spacing: str) -> str:
    """两段 14 磅文字的文本框；spacing 非空时每段写明行距倍数（pptxgenjs 的 lineSpacingMultiple 就这样写）。"""
    y = int(top_in * 914400)
    ppr = f'<a:pPr><a:lnSpc><a:spcPct val="{spacing}"/></a:lnSpc></a:pPr>' if spacing else ""
    para = "".join(f'<a:p>{ppr}<a:r><a:rPr sz="1400"/><a:t>{text}</a:t></a:r></a:p>' for text in ("第一段正文", "第二段正文"))
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="t{shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="914400" y="{y}"/><a:ext cx="5486400" cy="640080"/></a:xfrm></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>{para}</p:txBody></p:sp>'
    )


def test_writing_single_line_spacing_out_measures_the_same_as_leaving_it_default(kits, tmp_path):
    """行距倍数乘在单倍行距上：明写 100% 和不写是同一个行距，压在两段字下半截的文字两种写法都要查出来。"""
    verdicts = []
    for spacing in ("", "100000"):
        deck = tmp_path / f"spacing{spacing or 'default'}.pptx"
        # 第二个框的顶边在第一个框两行字的 2.15 倍字号处：单倍行距下两行要占 2.4 倍字号，叠上了
        _deck_with(deck, slide_extra=_two_lines(11, 1.0, spacing) + _line(12, 1.0 + 2.15 * 14 / 72, "下一块文字"))
        report = kits.deck_geometry.measure(deck.read_bytes())
        verdicts.append(any(item.kind == "crowded" for item in report.problems))
    assert verdicts == [True, True]


def test_picture_rules_ask_for_a_visual_check_only_when_the_vision_tool_can_see(kits, profile_env):
    """看图工具交给看不到图的主模型时，规则不让模型看图核对；配了看图模型后，看图核对回来。"""
    blind = kits.media_slot.picture_rules()
    assert "vision_analyze" in blind and "自己看图检查" not in blind

    config = profile_env / "config.yaml"
    _write(config, config.read_text(encoding="utf-8") + "auxiliary:\n  vision:\n    provider: openrouter\n")
    seeing = kits.media_slot.picture_rules()
    assert "自己看图检查" in seeing and "vision_analyze" not in seeing


def test_picture_rules_point_at_the_photo_notes_only_where_the_profile_has_them(kits, profile_env):
    """通用名词去 Commons 的取法每份都给；本档案的自学技能里攒了配图经验文件才指过去，没有的档案不提一个不存在的文件。"""
    ms = kits.media_slot
    slot = ms.MediaSlot("mcp__UniAI_Toolkit__txt2img_generate", "", "mcp__UniAI_Toolkit__image_search", "UniAI-Toolkit")
    bare = ms.picture_rules(slot, can_see=False)
    assert "commons_images.py" in bare and "skill_view(" not in bare

    _write(profile_env / "skills" / "office" / "pptx-scripted-decks" / "references" / "photo-sourcing.md", "# notes\n")
    rules = ms.picture_rules(slot, can_see=False)
    assert 'skill_view(name="office/pptx-scripted-decks", file_path="references/photo-sourcing.md")' in rules


def _emu(inches: float) -> int:
    """英寸换成 EMU。"""
    return int(inches * 914400)


def _table(rows: int, frame_h: float, row_h: float) -> str:
    """一张表：外框高 frame_h 英寸，每一行高 row_h 英寸。行高之和大于外框时，多出来的行会画到框外。"""
    row = (
        f'<a:tr h="{_emu(row_h)}"><a:tc><a:txBody><a:bodyPr/><a:p>'
        '<a:r><a:rPr sz="1400"/><a:t>本部门文档梳理与导入</a:t></a:r></a:p></a:txBody></a:tc></a:tr>'
    )
    return (
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="40" name="tbl"/>'
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        f'<p:xfrm><a:off x="{_emu(0.8)}" y="{_emu(1.0)}"/><a:ext cx="{_emu(8)}" cy="{_emu(frame_h)}"/></p:xfrm>'
        f'<a:graphic><a:graphicData><a:tbl>{row * rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    )


def _circle_label(text_y: float) -> str:
    """一个直径 2.7 英寸的圆，加一个垂直居中的数字框。text_y 是数字框的顶边。"""
    circle = _filled(21, 1.25, 2.25, 2.70, 2.70, "ellipse")
    y = _emu(text_y)
    label = (
        '<p:sp><p:nvSpPr><p:cNvPr id="22" name="n"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{_emu(1.40)}" y="{y}"/><a:ext cx="{_emu(2.40)}" cy="{_emu(0.90)}"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/>'
        '<a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="3200"/><a:t>7.5 小时</a:t></a:r></a:p></p:txBody></p:sp>'
    )
    return circle + label


def test_table_rows_taller_than_the_frame_are_sent_back(kits, tmp_path):
    """表格外框只有 1 英寸、五行却共 3.6 英寸：多出来的行会压住下面的内容，要退回；外框容得下行高则不报。"""
    tall = tmp_path / "tall.pptx"
    _deck_with(tall, slide_extra=_table(5, 1.0, 0.72))
    report = kits.deck_geometry.measure(tall.read_bytes())
    assert any(item.kind == "table_overflow" for item in report.problems), report.as_text()

    fit = tmp_path / "fit.pptx"
    _deck_with(fit, slide_extra=_table(2, 1.6, 0.72))
    assert not any(item.kind == "table_overflow" for item in kits.deck_geometry.measure(fit.read_bytes()).problems)


def test_a_centered_label_below_the_circle_center_is_sent_back(kits, tmp_path):
    """圆里的数字框自己是居中的，但框的中心比圆心低：要退回。框的中心和圆心重合则不报。"""
    low = tmp_path / "low.pptx"
    _deck_with(low, slide_extra=_circle_label(3.50))
    report = kits.deck_geometry.measure(low.read_bytes())
    assert any(item.kind == "off_center" for item in report.problems), report.as_text()

    # 圆顶 2.25、直径 2.70，圆心在 3.60；框高 0.90，顶边 3.15 时框心也在 3.60。
    aligned = tmp_path / "aligned.pptx"
    _deck_with(aligned, slide_extra=_circle_label(3.15))
    assert not any(item.kind == "off_center" for item in kits.deck_geometry.measure(aligned.read_bytes()).problems)

    # 圆里数字下面还有一行说明时，数字本来就该偏上。
    captioned = tmp_path / "captioned.pptx"
    caption = (
        '<p:sp><p:nvSpPr><p:cNvPr id="23" name="c"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{_emu(1.40)}" y="{_emu(3.95)}"/><a:ext cx="{_emu(2.40)}" cy="{_emu(0.40)}"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" anchor="ctr"/>'
        '<a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1200"/><a:t>平均续航</a:t></a:r></a:p></p:txBody></p:sp>'
    )
    _deck_with(captioned, slide_extra=_circle_label(2.85) + caption)
    assert not any(item.kind == "off_center" for item in kits.deck_geometry.measure(captioned.read_bytes()).problems)


def test_a_long_label_in_a_row_of_equal_chips_is_sent_back(kits, tmp_path):
    """同一排同样宽的小标签里，有一格字数明显长过其他格：这排会挤、会对不齐，要退回。字数差不多的不报。"""
    def chip(shape_id: int, x_in: float, text: str) -> str:
        x = _emu(x_in)
        return (
            f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="c{shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{x}" y="{_emu(0.6)}"/><a:ext cx="{_emu(1.16)}" cy="{_emu(0.40)}"/></a:xfrm>'
            '<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="E8EEF2"/></a:solidFill></p:spPr>'
            '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/>'
            f'<a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1000"/><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
        )

    uneven = tmp_path / "uneven.pptx"
    _deck_with(uneven, slide_extra=chip(11, 7.79, "10.27") + chip(12, 9.05, "导入旧文档") + chip(13, 10.31, "11.10") + chip(14, 11.57, "11.17"))
    report = kits.deck_geometry.measure(uneven.read_bytes())
    assert any(item.kind == "chip_label" for item in report.problems), report.as_text()

    even = tmp_path / "even.pptx"
    _deck_with(even, slide_extra=chip(11, 7.79, "10.27") + chip(12, 9.05, "11.03") + chip(13, 10.31, "11.10") + chip(14, 11.57, "11.17"))
    assert not any(item.kind == "chip_label" for item in kits.deck_geometry.measure(even.read_bytes()).problems)


def _box(shape_id: int, x_in: float, y_in: float, w_in: float, h_in: float, text: str, autofit: str = "") -> str:
    """一个文字框。autofit 写成 bodyPr 里的自动缩排标签，例如 <a:normAutofit/>。"""
    x, y, w, h = (_emu(value) for value in (x_in, y_in, w_in, h_in))
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="b{shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0">{autofit}</a:bodyPr>'
        f'<a:p><a:r><a:rPr sz="1800"/><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


def test_template_tokens_left_on_a_slide_or_in_notes_are_sent_back(kits, tmp_path):
    """页面或备注里留着 {{title}}、%DATE%：必须改。普通百分数不是模板记号。"""
    marked = tmp_path / "marked.pptx"
    _deck_with(marked, slide_extra=_line(11, 1.0, "标题：{{title}}"))
    report = kits.deck_geometry.measure(marked.read_bytes())
    assert any(item.kind == "leftover_token" for item in report.problems), report.as_text()

    dated = tmp_path / "dated.pptx"
    _deck_with(dated, slide_extra=_line(11, 1.0, "日期 %REPORT_DATE%"))
    assert any(item.kind == "leftover_token" for item in kits.deck_geometry.measure(dated.read_bytes()).problems)

    percent = tmp_path / "percent.pptx"
    _deck_with(percent, slide_extra=_line(11, 1.0, "营收增长 15.6%"))
    assert not any(item.kind == "leftover_token" for item in kits.deck_geometry.measure(percent.read_bytes()).problems)

    notes = tmp_path / "notes.pptx"
    _deck_with(notes, parts={
        "ppt/notesSlides/notesSlide1.xml":
            '<p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{{title}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    })
    assert any(item.kind == "leftover_token" for item in kits.deck_geometry.measure(notes.read_bytes()).problems)


def test_an_empty_title_placeholder_is_sent_back_but_an_empty_date_is_not(kits, tmp_path):
    """标题占位符空着，观众看到的是空白页，要退回。日期占位符空着是版式默认，不报。"""
    blank = tmp_path / "blank-title.pptx"
    title = (
        '<p:sp><p:nvSpPr><p:cNvPr id="50" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{_emu(1)}" y="{_emu(0.5)}"/><a:ext cx="{_emu(8)}" cy="{_emu(0.8)}"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr/><a:p><a:endParaRPr sz="3200"/></a:p></p:txBody></p:sp>'
    )
    _deck_with(blank, slide_extra=title)
    report = kits.deck_geometry.measure(blank.read_bytes())
    assert any(item.kind == "empty_text" and "标题" in item.detail for item in report.problems), report.as_text()

    date = tmp_path / "blank-date.pptx"
    _deck_with(date, slide_extra=title.replace('type="title"', 'type="dt"'))
    assert not any(item.kind == "empty_text" for item in kits.deck_geometry.measure(date.read_bytes()).problems)


def test_text_that_needs_twice_the_box_is_sent_back_unless_it_autofits(kits, tmp_path):
    """框只有 0.25 英寸、文字却要排成好几行：末尾会被裁掉，要退回。开了自动缩字号，或只是略紧，不拦。"""
    long_text = "门店复盘要把净增、营收、杯量和复购率逐项写清楚并且每项都给出来源"
    clipped = tmp_path / "clipped.pptx"
    _deck_with(clipped, slide_extra=_box(11, 1.0, 1.0, 2.0, 0.25, long_text))
    report = kits.deck_geometry.measure(clipped.read_bytes())
    assert any(item.kind == "text_overflow" for item in report.problems), report.as_text()

    fitting = tmp_path / "fitting.pptx"
    _deck_with(fitting, slide_extra=_box(11, 1.0, 1.0, 2.0, 0.25, long_text, "<a:normAutofit/>"))
    assert not any(item.kind == "text_overflow" for item in kits.deck_geometry.measure(fitting.read_bytes()).problems)

    snug = tmp_path / "snug.pptx"
    _deck_with(snug, slide_extra=_box(11, 1.0, 1.0, 2.0, 0.9, long_text))
    snug_report = kits.deck_geometry.measure(snug.read_bytes())
    assert not any(item.kind == "text_overflow" for item in snug_report.problems), snug_report.as_text()


def test_a_shape_inside_a_group_is_measured_on_the_page(kits, tmp_path):
    """组合里的文字框要换算到页面坐标：组被推到页外要退回，组在页内不报，整组隐藏的不报。"""
    def grouped(off_x: int, hidden: str = "") -> str:
        return (
            "<p:grpSp><p:nvGrpSpPr>"
            f'<p:cNvPr id="30" name="g"{hidden}/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            "<p:grpSpPr><a:xfrm>"
            f'<a:off x="{off_x}" y="{_emu(1)}"/><a:ext cx="{_emu(3)}" cy="{_emu(0.5)}"/>'
            f'<a:chOff x="0" y="0"/><a:chExt cx="{_emu(3)}" cy="{_emu(0.5)}"/>'
            "</a:xfrm></p:grpSpPr>"
            + _box(31, 0, 0, 3, 0.5, "组内标题")
            + "</p:grpSp>"
        )

    past = tmp_path / "past.pptx"
    _deck_with(past, slide_extra=grouped(_emu(12)))
    report = kits.deck_geometry.measure(past.read_bytes())
    assert any(item.kind == "off_slide" for item in report.problems), report.as_text()

    inside = tmp_path / "inside.pptx"
    _deck_with(inside, slide_extra=grouped(_emu(1)))
    assert not any(item.kind == "off_slide" for item in kits.deck_geometry.measure(inside.read_bytes()).problems)

    hidden = tmp_path / "hidden.pptx"
    _deck_with(hidden, slide_extra=grouped(_emu(12), ' hidden="1"'))
    assert not any(item.kind == "off_slide" for item in kits.deck_geometry.measure(hidden.read_bytes()).problems)


def test_one_box_shifted_out_of_its_column_is_sent_back(kits, tmp_path):
    """一列里已经有三格左边对齐，有一格偏出 0.25 英寸：要退回。整列对齐则不报。"""
    def stack(shift: float) -> str:
        boxes = "".join(
            _box(20 + index, 1.0, 1.0 + index * 0.7, 3.0, 0.45, f"条目{index}")
            for index in range(3)
        )
        return boxes + _box(30, 1.0 + shift, 3.2, 3.0, 0.45, "偏了的一条")

    shifted = tmp_path / "shifted.pptx"
    _deck_with(shifted, slide_extra=stack(0.25))
    report = kits.deck_geometry.measure(shifted.read_bytes())
    assert any(item.kind == "misaligned" for item in report.problems), report.as_text()

    straight = tmp_path / "straight.pptx"
    _deck_with(straight, slide_extra=stack(0.0))
    assert not any(item.kind == "misaligned" for item in kits.deck_geometry.measure(straight.read_bytes()).problems)


def _stacked_text(count: int, salt: str = "") -> str:
    """count 个文字框，全部放在页面起点，模拟写文字时没把坐标传进去。"""
    boxes = []
    for index in range(count):
        boxes.append(
            f'<p:sp><p:nvSpPr><p:cNvPr id="{20 + index}" name="t{index}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm></p:spPr>'
            f'<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>句子{salt}{index}</a:t></a:r></a:p></p:txBody></p:sp>'
        )
    return "".join(boxes)


def test_text_piled_at_the_origin_is_sent_back_and_never_released(kits, tmp_path):
    """八处以上文字叠在同一个起点：是脚本没传坐标，退回三次也不能交给用户。"""
    piled = tmp_path / "piled.pptx"
    _deck_with(piled, slide_extra=_stacked_text(8))
    report = kits.deck_geometry.measure(piled.read_bytes())
    assert any(item.kind == "text_unplaced" for item in report.problems), report.as_text()

    spaced = tmp_path / "spaced.pptx"
    _deck_with(spaced, slide_extra="".join(_line(20 + index, 1.0 + index * 0.6, f"句子{index}") for index in range(8)))
    assert not any(item.kind == "text_unplaced" for item in kits.deck_geometry.measure(spaced.read_bytes()).problems)

    kits.turns.clear()
    turn = _turn(kits, session="pile")
    script = tmp_path / "theme.js"
    script.write_text(
        f'writeFileSync("{piled.as_posix()}", "")\n'
        "function txt(ps, text, o) { slide.addText(text, { fontSize: o.size, w: o.w, h: o.h }); }\n",
        encoding="utf-8",
    )
    args = {"command": f'node "{script}"'}
    replies = []
    for index in range(3):
        _deck_with(piled, slide_extra=_stacked_text(8, salt=str(index) * (index + 1)))
        replies.append(kits.deck_check.annotate("terminal", args, "exit 0", turn))
    assert all("没有交付" in reply and "可以交给用户" not in reply for reply in replies)
    assert "theme.js" in replies[0]
    assert not piled.exists()


def _with_crop(path, src_rect: str, frame: tuple[float, float]) -> None:
    """一张不贴边的内容图。frame 是画框英寸，比例要和裁完之后的图一致，避免被算成拉伸。"""
    import zipfile

    width, height = (int(value * 914400) for value in frame)
    _pptx(path, _png(100, 100), (width, height), origin=(914400, 914400))
    with zipfile.ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    slide = files["ppt/slides/slide1.xml"].decode("utf-8")
    files["ppt/slides/slide1.xml"] = slide.replace(
        "<a:stretch><a:fillRect/></a:stretch>",
        f"<a:srcRect {src_rect}/><a:stretch><a:fillRect/></a:stretch>",
        1,
    ).encode("utf-8")
    with zipfile.ZipFile(path, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)


def test_a_product_crop_that_cuts_the_subject_or_misses_the_center_is_sent_back(kits, tmp_path):
    """内容图裁掉超过两成，或只裁一边：主体会被切到画面外，要退回。正中的轻微裁切和 contain 留白不报。"""
    chopped = tmp_path / "chopped.pptx"
    _with_crop(chopped, 't="0" b="28000"', (2.78, 2.0))
    report = kits.deck_geometry.measure(chopped.read_bytes())
    assert any(item.kind == "cropped" for item in report.problems), report.as_text()

    heavy = tmp_path / "heavy.pptx"
    _with_crop(heavy, 'l="15000" r="15000"', (1.4, 2.0))
    assert any(item.kind == "cropped" for item in kits.deck_geometry.measure(heavy.read_bytes()).problems)

    light = tmp_path / "light.pptx"
    _with_crop(light, 'l="4000" r="4000"', (1.84, 2.0))
    assert not any(item.kind == "cropped" for item in kits.deck_geometry.measure(light.read_bytes()).problems)

    contained = tmp_path / "contained.pptx"
    _with_crop(contained, 'l="-12000" r="-12000"', (2.48, 2.0))
    assert not any(item.kind == "cropped" for item in kits.deck_geometry.measure(contained.read_bytes()).problems)





def _badge(shape_id: int, x_in: float, size_in: float, fill: str, text: str, size_pt: int, bold: bool) -> str:
    """一个实色圆点，上面压一段写明了 RGB 字色的白字（彩色圆底上的编号、徽标）。"""
    disc = _filled(shape_id, x_in, 2.0, size_in, size_in).replace("1F3B57", fill)
    label = (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id + 1}" name="n{shape_id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{_emu(x_in)}" y="{_emu(2.0)}"/><a:ext cx="{_emu(size_in)}" cy="{_emu(size_in)}"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:p><a:pPr algn="ctr"/>'
        f'<a:r><a:rPr sz="{size_pt * 100}"{" b=\"1\"" if bold else ""}><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'
        f'<a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    )
    return disc + label


def test_big_white_numbers_on_amber_pass_but_small_white_text_on_amber_does_not(kits, tmp_path):
    """橙底白字（对比度约 2.2）：20 磅加粗的编号看得清，不退回；10 磅的小字看不清，照样退回。"""
    big = tmp_path / "big.pptx"
    _deck_with(big, slide_extra=_badge(30, 1.0, 0.9, "F59E0B", "04", 20, True))
    assert not any(item.kind == "low_contrast" for item in kits.deck_geometry.measure(big.read_bytes()).problems)

    small = tmp_path / "small.pptx"
    _deck_with(small, slide_extra=_badge(30, 1.0, 0.9, "F59E0B", "小字说明文字", 10, False))
    report = kits.deck_geometry.measure(small.read_bytes())
    assert any(item.kind == "low_contrast" for item in report.problems), report.as_text()


def test_a_decorative_circle_may_bleed_off_the_page_but_text_may_not(kits, tmp_path):
    """封面上露半个的装饰圆是常见设计，不退回；整个跑到页面外的形状、出界的文字照样退回。"""
    bleed = tmp_path / "bleed.pptx"
    _deck_with(bleed, slide_extra=_filled(40, 11.8, -1.2, 3.0, 3.0))
    assert not any(item.kind == "off_slide" for item in kits.deck_geometry.measure(bleed.read_bytes()).problems)

    lost = tmp_path / "lost.pptx"
    _deck_with(lost, slide_extra=_filled(40, 14.0, 1.0, 2.0, 2.0))
    assert any(item.kind == "off_slide" for item in kits.deck_geometry.measure(lost.read_bytes()).problems)

    words = tmp_path / "words.pptx"
    _deck_with(words, slide_extra=_line(41, -0.6, "标题被推出了页面"))
    assert any(item.kind == "off_slide" for item in kits.deck_geometry.measure(words.read_bytes()).problems)


def test_the_same_footer_failing_on_many_pages_is_reported_once(kits):
    """页脚、页码每页都报一次会让模型逐页去改：三页以上的同一段字合成一条，种类不变；只出两页的照常分开列。"""
    Problem = kits.deck_geometry.Problem
    problems = [Problem(page, "low_contrast", "「课程介绍 · 第一章」和底下的颜色太接近，字看不清") for page in (2, 3, 4, 5)]
    problems += [Problem(page, "low_contrast", f"「{page}」和底下的颜色太接近，字看不清") for page in (2, 3, 4)]
    problems += [Problem(page, "covered_text", "「本页标题」被后画的 1 个图形压住了") for page in (6, 7)]
    condensed = kits.deck_geometry._condense(problems)

    footer = [item for item in condensed if "课程介绍" in item.detail]
    assert len(footer) == 1 and "2、3、4、5" in footer[0].detail and footer[0].kind == "low_contrast"
    numbers = [item for item in condensed if item.kind == "low_contrast" and "课程介绍" not in item.detail]
    assert len(numbers) == 1 and "2、3、4" in numbers[0].detail
    assert [item.slide for item in condensed if item.kind == "covered_text"] == [6, 7]


def test_layout_problems_are_counted_per_page_so_new_pages_still_get_checked(kits):
    """分批构建时打回按页计数：一页的观感问题退回够次数后放行；新写的页照样要改；确定的错一直要改。"""
    Problem = kits.deck_geometry.Problem
    problems = (
        Problem(3, "low_contrast", "「第三页标题」和底下的颜色太接近，字看不清"),
        Problem(7, "low_contrast", "「第七页标题」和底下的颜色太接近，字看不清"),
        Problem(3, "invalid_value", "字号 0.2 磅超出规范"),
    )
    to_fix, settled = kits.deck_check._triage(problems, {3: kits.deck_check.MAX_BOUNCES})
    assert [(item.slide, item.kind) for item in settled] == [(3, "low_contrast")]
    assert {(item.slide, item.kind) for item in to_fix} == {(7, "low_contrast"), (3, "invalid_value")}
