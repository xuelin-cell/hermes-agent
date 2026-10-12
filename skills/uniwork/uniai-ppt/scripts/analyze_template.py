# -*- coding: utf-8 -*-
"""
analyze_template.py — 把用户上传的 .pptx 拆解成"可复刻"的结构化资料。

它做的事，正是人工复刻一套品牌模板时要做的全部前置工作：
  1) 读画布尺寸（EMU -> 英寸），判断该用哪种 pptxgenjs layout
  2) 读主题配色(clrScheme) + 字体(fontScheme)
  3) 统计每页真实用到的颜色（srgbClr 直方图）-> 猜品牌主色/辅助色
  4) 抽取所有媒体(logo/背景图)到 assets/
  5) 逐页 dump 每个形状的 名称/坐标(英寸)/几何/填充/描边/文字(内容·字号·粗细·颜色·字体·对齐)
  6) 产出 theme.json（可直接喂 theme_generator.js）+ ANALYSIS.md（给 agent 照着写 pptxgenjs）

用法：
    python scripts/analyze_template.py <input.pptx> [--out <dir>]

默认输出到 <input同名>_analysis/ 下：assets/、theme.json、ANALYSIS.md
"""

import argparse
import json
import shutil
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"a": A, "p": P, "r": R}
EMU = 914400.0


def inch(v):
    try:
        return round(int(v) / EMU, 3)
    except (TypeError, ValueError):
        return None


def _hex_ok(c):
    return isinstance(c, str) and len(c) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in c)


def _txt(el):
    return "".join(t.text or "" for t in el.findall(".//a:t", NS))


def parse_shape(el):
    """从一个 sp/pic/cxnSp/grpSp 里抽出结构化信息。"""
    tag = el.tag.split("}")[-1]
    cnv = (el.find(".//p:cNvPr", NS))
    name = cnv.get("name") if cnv is not None else "?"
    info = {"kind": tag, "name": name}

    xfrm = el.find(".//a:xfrm", NS)
    if xfrm is not None:
        off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
        if off is not None and ext is not None:
            info["x"], info["y"] = inch(off.get("x")), inch(off.get("y"))
            info["w"], info["h"] = inch(ext.get("cx")), inch(ext.get("cy"))
        if xfrm.get("rot"):
            info["rot"] = round(int(xfrm.get("rot")) / 60000.0, 1)

    prst = el.find(".//a:prstGeom", NS)
    if prst is not None:
        info["geom"] = prst.get("prst")

    spPr = el.find("./p:spPr", NS)
    fills = []
    if spPr is not None:
        for sf in spPr.findall(".//a:solidFill/a:srgbClr", NS):
            fills.append(sf.get("val"))
        for sc in spPr.findall(".//a:solidFill/a:schemeClr", NS):
            lm = sc.find("a:lumMod", NS)
            fills.append("scheme:" + sc.get("val") + (("*" + lm.get("val")) if lm is not None else ""))
        ln = spPr.find("a:ln", NS)
        if ln is not None:
            lc = ln.find(".//a:srgbClr", NS)
            info["line"] = {"w": inch(ln.get("w")), "color": lc.get("val") if lc is not None else None}
    if fills:
        info["fill"] = fills

    runs = []
    for pgraph in el.findall(".//a:p", NS):
        ppr = pgraph.find("a:pPr", NS)
        algn = ppr.get("algn") if ppr is not None else None
        for run in pgraph.findall("a:r", NS):
            t = run.find("a:t", NS)
            text = t.text if t is not None else ""
            if not text:
                continue
            rpr = run.find("a:rPr", NS)
            r = {"text": text, "align": algn}
            if rpr is not None:
                if rpr.get("sz"):
                    r["pt"] = round(int(rpr.get("sz")) / 100.0, 1)
                r["bold"] = rpr.get("b") == "1"
                cc = rpr.find(".//a:solidFill/a:srgbClr", NS)
                if cc is not None:
                    r["color"] = cc.get("val")
                lat = rpr.find("a:latin", NS)
                ea = rpr.find("a:ea", NS)
                face = (lat.get("typeface") if lat is not None else None) or (ea.get("typeface") if ea is not None else None)
                if face:
                    r["font"] = face
            runs.append(r)
    if runs:
        info["text"] = runs
    return info


def slide_shapes(root):
    tree = root.find(".//p:cSld/p:spTree", NS)
    out = []
    if tree is None:
        return out
    for el in tree:
        if el.tag.split("}")[-1] in ("sp", "pic", "cxnSp", "grpSp"):
            out.append(parse_shape(el))
    return out


def read_theme(z):
    """clrScheme + fontScheme。"""
    colors, fonts = {}, {}
    try:
        root = ET.fromstring(z.read("ppt/theme/theme1.xml"))
    except KeyError:
        return colors, fonts
    cs = root.find(".//a:clrScheme", NS)
    if cs is not None:
        for child in cs:
            key = child.tag.split("}")[-1]
            srgb = child.find("a:srgbClr", NS)
            sysc = child.find("a:sysClr", NS)
            if srgb is not None:
                colors[key] = srgb.get("val")
            elif sysc is not None:
                colors[key] = sysc.get("lastClr")
    fs = root.find(".//a:fontScheme", NS)
    if fs is not None:
        for kind in ("majorFont", "minorFont"):
            f = fs.find("a:" + kind, NS)
            if f is not None:
                lat = f.find("a:latin", NS)
                ea = f.find("a:ea", NS)
                fonts[kind] = {
                    "latin": lat.get("typeface") if lat is not None else "",
                    "ea": ea.get("typeface") if ea is not None else "",
                }
    return colors, fonts


def _rgb(c):
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _lum(c):
    r, g, b = _rgb(c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _sat(c):
    r, g, b = _rgb(c)
    mx, mn = max(r, g, b), min(r, g, b)
    return 0.0 if mx == 0 else (mx - mn) / float(mx)


def _mix(a, b, k):
    ra, ga, ba = _rgb(a); rb, gb, bb = _rgb(b)
    return "%02X%02X%02X" % (int(ra + (rb - ra) * k), int(ga + (gb - ga) * k), int(ba + (bb - ba) * k))


def build_theme_json(dims, clr, fonts, hist, name, slides=None, bgs=None):
    """从**幻灯片里真实用到的**颜色与字体反推 theme.json。

    早期版本直接读 theme1.xml 的 clrScheme/fontScheme，结果几乎全是 Office 默认值
    （实测一份墨绿+金的模板被推成 accent2 橙 + 微软雅黑），照着做出来跟模板毫无关系。
    现在改成：颜色按**覆盖面积**加权（整幅背景 >> 一根 0.04" 的细线），字体取**实际 run**
    里最大字号的那个做标题字、正文字号段里最常见的那个做正文字。
    """
    slides = slides or []
    bgs = bgs or []
    page_area = max(1.0, (dims.get("w") or 10) * (dims.get("h") or 5.625))

    area = {}          # 颜色 -> 覆盖面积（平方英寸）
    for c in bgs:      # 幻灯片背景算整页面积
        if _hex_ok(c):
            area[c.upper()] = area.get(c.upper(), 0) + page_area
    for sl in slides:
        for sh in sl.get("shapes", []):
            fills = [f for f in (sh.get("fill") or []) if _hex_ok(f)]
            if not fills:
                continue
            a = max(0.0, float(sh.get("w") or 0)) * max(0.0, float(sh.get("h") or 0))
            if a <= 0:
                continue
            area[fills[0].upper()] = area.get(fills[0].upper(), 0) + a

    runs = []
    for sl in slides:
        for sh in sl.get("shapes", []):
            for r in (sh.get("text") or []):
                runs.append(r)

    def by_area(pred):
        cand = [(c, v) for c, v in area.items() if pred(c)]
        cand.sort(key=lambda kv: -kv[1])
        return cand[0][0] if cand else None

    bg_light = by_area(lambda c: _lum(c) >= 200) or "FFFFFF"
    # 深色底：先找真正的深色；模板的深色主色可能并不很暗（青绿 #0F766E 亮度就有 95），
    # 所以退而求其次取"用得最多的偏暗色"，再不行才认 clrScheme —— 那基本是 Office 默认值，等于没推。
    bg_dark = (by_area(lambda c: _lum(c) <= 90)
               or by_area(lambda c: _lum(c) <= 140 and area.get(c, 0) >= page_area * 0.05)
               or (clr.get("dk2") or "1A1A1A").upper())
    # 主色：面积最大的"有颜色"块（排除纸白/纯灰）；模板的主色往往就是大面积色块本身
    primary = by_area(lambda c: _lum(c) < 235 and (_sat(c) >= 0.12 or _lum(c) <= 90))
    if not primary:
        ranked = [c for c, _ in hist.most_common() if _hex_ok(c) and _sat(c.upper()) >= 0.2]
        primary = (ranked[0].upper() if ranked else (clr.get("accent1") or "C00000").upper())
    # 强调色：饱和度最高且不是主色的那个（金/橙/红这类点缀色面积都很小，按面积排永远选不到）
    acc = [(c, _sat(c)) for c in area if c != primary and _sat(c) >= 0.35 and 40 <= _lum(c) <= 220]
    acc.sort(key=lambda kv: -kv[1])
    accent = acc[0][0] if acc else _mix(primary, "FFFFFF", 0.35)
    secondary = acc[1][0] if len(acc) > 1 else accent

    txt_cols = [r["color"].upper() for r in runs if _hex_ok(r.get("color") or "")]
    dark_txt = [c for c in txt_cols if _lum(c) <= 120]
    text_on_light = min(dark_txt, key=_lum) if dark_txt else "1A1A1A"
    light_txt = [c for c in txt_cols if _lum(c) >= 180]
    text_on_dark = max(light_txt, key=_lum) if light_txt else "FFFFFF"
    mid = [c for c in txt_cols if 110 <= _lum(c) <= 185]
    text_muted = max(set(mid), key=mid.count) if mid else _mix(text_on_light, bg_light, 0.45)

    # 要求有真实面积，否则会把一根 0.02" 的浅色分隔线当成卡片底色
    other_light = by_area(lambda c: _lum(c) >= 200 and c != bg_light
                          and area.get(c, 0) >= page_area * 0.03)
    card_bg = other_light or ("FFFFFF" if bg_light.upper() == "FFFFFF" else _mix(bg_light, "FFFFFF", 0.62))

    def font_of(pred, fallback):
        fs = [r["font"] for r in runs if r.get("font") and pred(r)]
        return max(set(fs), key=fs.count) if fs else fallback
    big = [r for r in runs if (r.get("pt") or 0) >= 20]
    title_font = (max(big, key=lambda r: r.get("pt") or 0).get("font") if big else None)         or font_of(lambda r: (r.get("pt") or 0) >= 20, None)         or (fonts.get("majorFont", {}) or {}).get("latin") or "Microsoft YaHei"
    body_font = font_of(lambda r: 0 < (r.get("pt") or 0) <= 16, None)         or (fonts.get("minorFont", {}) or {}).get("latin") or title_font
    accent_font = font_of(lambda r: (r.get("pt") or 0) <= 13 and r.get("bold"), body_font)

    theme = {
        "name": name,
        "display_name": name,
        "tags": ["custom", "uploaded"],
        "colors": {
            "primary": primary, "secondary": secondary, "accent": accent,
            "bg_dark": bg_dark, "bg_light": bg_light,
            "text_on_dark": text_on_dark, "text_on_light": text_on_light,
            "text_muted": text_muted,
            # 卡片底：优先取模板里**另一个**大面积浅色（多数模板就是用它做卡的）；
            # 没有就从纸色往白里提一档 —— 卡片底等于纸色的话，卡片在页面上整个"隐身"
            "card_bg": card_bg,
            "card_border": _mix(text_on_light, card_bg, 0.80),
        },
        "fonts": {"title": title_font, "body": body_font, "accent": accent_font},
        "motif": "custom-uploaded",
        "description": "Auto-derived from uploaded template. Canvas %sx%s in." % (dims["w"], dims["h"]),
    }
    for k, v in theme["colors"].items():
        if not _hex_ok(v):
            theme["colors"][k] = "808080"
        else:
            theme["colors"][k] = v.upper()
    return theme


def main():
    ap = argparse.ArgumentParser(description="Analyze a .pptx template into reproducible assets.")
    ap.add_argument("pptx")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    src = Path(args.pptx)
    if not src.exists():
        raise SystemExit(f"Not found: {src}")
    out = Path(args.out) if args.out else src.with_name(src.stem + "_analysis")
    out.mkdir(parents=True, exist_ok=True)
    assets = out / "assets"
    assets.mkdir(exist_ok=True)

    z = zipfile.ZipFile(src)

    # 尺寸
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    sz = pres.find(".//p:sldSz", NS)
    dims = {"w": inch(sz.get("cx")), "h": inch(sz.get("cy"))}
    ratio = round(dims["w"] / dims["h"], 3) if dims["h"] else None

    # 主题
    clr, fonts = read_theme(z)

    # 幻灯片 + 颜色直方图
    slide_names = sorted(
        [n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")],
        key=lambda n: int("".join(ch for ch in n.split("/")[-1] if ch.isdigit())),
    )
    slides, hist, bgs = [], Counter(), []
    for sn in slide_names:
        root = ET.fromstring(z.read(sn))
        shapes = slide_shapes(root)
        slides.append({"file": sn.split("/")[-1], "shapes": shapes})
        bgel = root.find(".//p:cSld/p:bg//a:srgbClr", NS)
        if bgel is not None and _hex_ok(bgel.get("val") or ""):
            bgs.append(bgel.get("val").upper())
        for m in ("".join(z.read(sn).decode("utf-8", "ignore")).split("srgbClr val=\"")[1:]):
            v = m[:6]
            if _hex_ok(v):
                hist[v.upper()] += 1

    # 抽取媒体
    media = []
    for n in z.namelist():
        if n.startswith("ppt/media/") and not n.endswith("/"):
            fn = n.split("/")[-1]
            if not fn:
                continue
            with z.open(n) as fsrc, open(assets / fn, "wb") as fdst:
                shutil.copyfileobj(fsrc, fdst)
            media.append(fn)

    # theme.json
    theme = build_theme_json(dims, clr, fonts, hist, src.stem, slides, bgs)
    (out / "theme.json").write_text(json.dumps(theme, ensure_ascii=False, indent=2), encoding="utf-8")

    # 布局建议
    if ratio and abs(ratio - 13.333 / 7.5) < 0.05:
        layout = 'pres.defineLayout({name:"CUSTOM",width:%s,height:%s}); pres.layout="CUSTOM";' % (dims["w"], dims["h"])
    elif ratio and abs(ratio - 10 / 5.625) < 0.05:
        layout = 'pres.layout = "LAYOUT_16x9";'
    else:
        layout = 'pres.defineLayout({name:"CUSTOM",width:%s,height:%s}); pres.layout="CUSTOM";' % (dims["w"], dims["h"])

    # ANALYSIS.md
    lines = []
    lines.append(f"# 模板分析：{src.name}\n")
    lines.append(f"- **画布**：{dims['w']} x {dims['h']} 英寸（宽高比 {ratio}）")
    lines.append(f"- **pptxgenjs layout**：`{layout}`")
    lines.append(f"- **幻灯片数**：{len(slides)}")
    lines.append(f"- **媒体资源**（已抽到 `assets/`）：{', '.join(media) if media else '无'}")
    if clr:
        lines.append(f"- **主题色板 clrScheme**：" + ", ".join(f"{k}=#{v}" for k, v in clr.items()))
    if fonts:
        maj = fonts.get("majorFont", {})
        mnf = fonts.get("minorFont", {})
        lines.append(f"- **字体**：标题 latin={maj.get('latin')} / ea={maj.get('ea')}；正文 latin={mnf.get('latin')} / ea={mnf.get('ea')}")
    top = ", ".join(f"#{c}×{n}" for c, n in hist.most_common(8))
    lines.append(f"- **幻灯片实际用色 Top8**：{top}")
    lines.append(f"- **生成的起始主题**：`theme.json`（可 `node scripts/theme_generator.js {out.name}/theme.json` 生成 theme.js）\n")
    lines.append("> 复刻建议：用上面的 layout + theme.json 的配色/字体，参照下方逐页坐标，用 pptxgenjs 重画；logo/背景图用 `assets/` 里的文件。\n")

    for i, s in enumerate(slides, 1):
        lines.append(f"\n## 第 {i} 页（{s['file']}）")
        if not s["shapes"]:
            lines.append("_（本页形状继承自母版/版式，slide 本身为空）_")
        for sh in s["shapes"]:
            pos = ""
            if "x" in sh:
                pos = f"x={sh['x']} y={sh['y']} w={sh['w']} h={sh['h']}"
            extra = []
            if sh.get("geom"):
                extra.append(f"geom={sh['geom']}")
            if sh.get("fill"):
                extra.append(f"fill={sh['fill']}")
            if sh.get("line"):
                extra.append(f"line={sh['line']}")
            lines.append(f"- **[{sh['kind']}]** {sh['name']}  `{pos}`  {' '.join(extra)}")
            for r in sh.get("text", []):
                meta = f"{r.get('pt','?')}pt{' bold' if r.get('bold') else ''}"
                col = f" #{r['color']}" if r.get("color") else ""
                fnt = f" [{r['font']}]" if r.get("font") else ""
                al = f" align={r['align']}" if r.get("align") else ""
                lines.append(f"    - TXT: \"{r['text']}\"  ({meta}{col}{fnt}{al})")

    (out / "ANALYSIS.md").write_text("\n".join(lines), encoding="utf-8")

    # stdout 摘要
    print(f"OK -> {out}")
    print(f"  canvas: {dims['w']} x {dims['h']} in (ratio {ratio})")
    print(f"  slides: {len(slides)}, media: {len(media)}")
    print(f"  brand colors (guess): primary #{theme['colors']['primary']}, secondary #{theme['colors']['secondary']}")
    print(f"  fonts: {theme['fonts']['title']} / {theme['fonts']['body']}")
    print(f"  wrote: theme.json, ANALYSIS.md, assets/({len(media)})")


if __name__ == "__main__":
    main()
