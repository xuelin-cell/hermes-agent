/**
 * pptkit.js — uniai-ppt 出稿套件（唯一需要 require 的文件）
 * ============================================================================
 * 设计目标：**把版式计算从模型脑子里搬到代码里**。
 * 你（模型）只负责「给数据 + 说放在哪个区域」，所有坐标/字号/图层/间距由本文件负责。
 *
 * 用法（slides.js 开头 6 行，照抄）：
 *
 *   const pptxgen = require("pptxgenjs");
 *   const THEME   = require("./theme.js");
 *   let pres = new pptxgen();
 *   pres.layout = "LAYOUT_16x9";                 // 联通模板见 unicom-template.md
 *   const K = require("./pptkit.js")(pres, THEME);
 *   const { contentSlide, rowsOf, colsOf, featureRow, statRow } = K;   // 按需解构
 *
 * 三条保证（由本文件在 writeFile 前统一体检并自动修）：
 *   1. 文字永不溢出：按文本框真实宽高反算最大可用字号，走设计字号阶梯。
 *   2. 字号自动统一：同页平行元素（一排卡的标题 / 一排 KPI）取组内最小字号。
 *   3. 排版体检：越界 / 元素交叉 / 文字探出卡片 / 内容被色块盖住 → 控制台 ⚠ 告警。
 *      **看到 ⚠ 必须改完再继续下一页。**
 */

"use strict";

/* ═══════════════ 1. 度量引擎（不依赖 fit:"shrink"，那玩意 WPS/LO 不执行） ═══════════════ */

var LADDER = [72, 66, 60, 54, 48, 44, 40, 36, 32, 28, 26, 24, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8];
// LINE_H 实测标定：LibreOffice/PowerPoint 单倍行距 = 1.20×字号（见 opt-lab 行高标定），
// 这里取 1.30 留 8% 余量，宁可算高也不能算矮（算矮 = 文字被卡片切掉）。
var LINE_H = 1.30, SAFETY = 0.96, MIN_SIZE = 8;
// 正文/要点用 1.15 倍行距（实测单倍=1.20×字号 → 实际约 1.38，中文舒适区）；
// 用了它的文本框在测高时必须换成 LINE_H_LOOSE，否则算矮了就会把最后一行挤出卡片。
var LOOSE = 1.10, LINE_H_LOOSE = 1.38;

function charEm(cp) {
  if (cp >= 0x1100 && (cp <= 0x115f ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6))) return 1.0;
  if (cp === 32) return 0.28;
  if (cp >= 0x41 && cp <= 0x5a) return 0.70;
  if (cp >= 0x61 && cp <= 0x7a) return 0.53;
  if (cp >= 0x30 && cp <= 0x39) return 0.58;
  if (cp === 0x25 || cp === 0x40 || cp === 0x23 || cp === 0x2b) return 0.72;
  return 0.42;
}
function textEm(s, bold) {
  s = String(s == null ? "" : s);
  var w = 0, prev = null;
  for (var i = 0; i < s.length; i++) {
    var cp = s.codePointAt(i); if (cp > 0xffff) i++;
    var wide = charEm(cp) === 1.0;
    // 中西文边界渲染器会自动加间距；数字侧比字母侧窄，分开估更贴近实际（否则卡片会被算高）
    if (prev !== null && prev !== wide && cp !== 32) w += (cp >= 0x30 && cp <= 0x39) ? 0.06 : 0.15;
    w += charEm(cp); prev = wide;
  }
  return bold ? w * 1.03 : w;
}
/** 宽 wIn 英寸内单行能放下的最大阶梯字号 */
function fitOne(text, wIn, base, min) {
  var em = textEm(text, true), floor = min || MIN_SIZE;
  if (!em) return base;
  for (var i = 0; i < LADDER.length; i++) {
    var v = LADDER[i];
    if (v > base) continue;
    if (v < floor) break;
    if (em * v <= wIn * 72 * SAFETY) return v;
  }
  return floor;
}
function insets(o) {
  var m = o.margin;
  if (m == null) return { x: 0.20, y: 0.10 };
  if (typeof m === "number") return { x: 2 * m / 72, y: 2 * m / 72 };
  if (Array.isArray(m)) return { x: ((m[1] || 0) + (m[3] || 0)) / 72, y: ((m[0] || 0) + (m[2] || 0)) / 72 };
  return { x: 0.20, y: 0.10 };
}
function toParas(runs, base) {
  var paras = [], cur = [];
  (runs || []).forEach(function (r) {
    if (!r) return;
    var op = r.options || {};
    String(r.text == null ? "" : r.text).split("\n").forEach(function (p, i) {
      if (i > 0) { paras.push(cur); cur = []; }
      cur.push({ s: p, size: op.fontSize || base, bold: !!op.bold });
    });
    if (op.breakLine) { paras.push(cur); cur = []; }
  });
  if (cur.length) paras.push(cur);
  return paras.length ? paras : [[{ s: "", size: base, bold: false }]];
}
function heightAt(paras, scale, availWpt, gap, loose) {
  var LH = loose ? LINE_H_LOOSE : LINE_H;
  var total = 0;
  for (var i = 0; i < paras.length; i++) {
    var wpt = 0, mx = 0;
    for (var j = 0; j < paras[i].length; j++) {
      var r = paras[i][j], sz = r.size * scale;
      wpt += textEm(r.s, r.bold) * sz; if (sz > mx) mx = sz;
    }
    if (!mx) mx = 12 * scale;
    total += Math.max(1, Math.ceil(wpt / (availWpt * SAFETY))) * mx * LH;
    total += gap;   // ⚠️ paraSpaceAfter 在**最后一段之后也会生效**，少算这一份就会把最后一行挤出卡片
  }
  return total;
}
/** 破行检测：某段折行后「末行只剩一两个字」（孤字）。这是肉眼最刺眼的排版毛病。 */
function orphanBreak(paras, scale, availWpt) {
  var per = availWpt * SAFETY;
  for (var i = 0; i < paras.length; i++) {
    var w = 0;
    for (var j = 0; j < paras[i].length; j++) w += textEm(paras[i][j].s, paras[i][j].bold) * paras[i][j].size * scale;
    if (w <= per) continue;
    var lines = Math.ceil(w / per);
    if ((w - (lines - 1) * per) / per < 0.32) return true;
  }
  return false;
}
/** 把一段文字手工均分成 n 行（插入 \n），彻底消灭「末行只剩一个字」——
 *  行数与自动折行完全相同，所以高度不变，只是断点更均衡。 */
function balanceText(s, perPt, sizePt) {
  s = String(s == null ? "" : s);
  var total = textEm(s, false) * sizePt;
  var n = Math.ceil(total / perPt);
  if (n < 2 || !s.length) return s;
  var NO_HEAD = "，。、；：？！）】》」』%…·,.;:?!)>%";      // 避头：这些字符不能出现在行首
  var NO_TAIL = "（【《「『(<";                                // 避尾：这些字符不能出现在行尾
  var target = total / n, out = [], cur = "", w = 0;
  for (var i = 0; i < s.length; i++) {
    var cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    var cw = charEm(cp) * sizePt;
    var brk = w + cw > target && out.length < n - 1 && cur.length > 1;
    if (brk && NO_HEAD.indexOf(ch) >= 0) brk = false;                       // 标点不许挂行首
    if (brk && NO_TAIL.indexOf(cur.charAt(cur.length - 1)) >= 0) brk = false; // 开括号不许留行尾
    if (brk) { out.push(cur); cur = ch; w = cw; }
    else { cur += ch; w += cw; }
  }
  out.push(cur);
  return out.join("\n");
}
function widthAt(paras, scale) {
  var mx = 0;
  paras.forEach(function (p) {
    var w = 0; p.forEach(function (r) { w += textEm(r.s, r.bold) * r.size * scale; });
    if (w > mx) mx = w;
  });
  return mx;
}

/* ═══════════════ 2. 排版体检 ═══════════════ */

function rectOf(o) {
  if (!o || typeof o.x !== "number" || typeof o.y !== "number") return null;
  var w = typeof o.w === "number" ? o.w : 0, h = typeof o.h === "number" ? o.h : 0;
  return (w <= 0 || h <= 0) ? null : { x: o.x, y: o.y, w: w, h: h };
}
function inter(a, b) {
  var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  var x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return (x2 <= x || y2 <= y) ? 0 : (x2 - x) * (y2 - y);
}
function contains(o, i, tol) {
  tol = tol == null ? 0.04 : tol;
  return i.x >= o.x - tol && i.y >= o.y - tol &&
         i.x + i.w <= o.x + o.w + tol && i.y + i.h <= o.y + o.h + tol;
}
function opaque(o) {
  if (!o || !o.fill) return false;
  var t = (typeof o.fill === "object") ? o.fill.transparency : null;
  return !(typeof t === "number" && t >= 20);
}
function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }
function plainOf(obj) { return (obj.text || []).map(function (r) { return r && r.text; }).join(" "); }

function audit(pres, quiet, TH) {
  // 用**副本**：页级检查是每次 audit 从当前 slide 状态重新推导出来的，
  // 直接往 pres.__pptkitIssues 上追加会让「连调两次 audit 就有两条」，
  // 更糟的是页面补好内容之后历史记录还在，writeFile 依旧拒绝 —— 模型会卡死在改不动的循环里。
  // 绘制期登记的区块问题是一次性事实，仍然从 pres 上取。
  var warns = [], shrunk = 0, issues = (pres.__pptkitIssues || []).slice();
  var L = pres.presLayout || {};
  var SW = L.width ? L.width / 914400 : 10, SH = L.height ? L.height / 914400 : 5.625;

  var paper = (((TH || {}).bg_light) || "FFFFFF").toUpperCase(), papered = 0;

  (pres.slides || []).forEach(function (slide, si) {
    var objs = slide._slideObjects || [], no = si + 1, texts = [], seen = {};

    // 页眉画完后一个元素都没再加 => 整页正文缺失（sectionSlide / page.photo / page.statement
    // 不走 contentSlide，没有这个标记，天然不会被误判）
    if (typeof slide.__pptkitHdrObjs === "number" && objs.length <= slide.__pptkitHdrObjs)
      issues.push("第 " + no + " 页只有页眉、正文区一个元素都没有 —— " +
        "contentSlide/page.* 建了页但没画任何区块（或 blocks 是空数组）");

    // --- 字面量 undefined / NaN / null 兜底 ---
    // 键名写错时渲染器读到 undefined，String() 一转就把 "undefined" 五个字母印到页面上。
    // 逐项校验只覆盖枚举过的字段，这里从渲染结果反查，任何漏网的调用点都跑不掉。
    // 只匹配**整段文字恰好等于**这些词，避免误伤真的在讲 undefined 的技术类 PPT。
    var _junk = {};
    objs.forEach(function (obj) {
      if (obj._type !== "text" || !obj.text) return;
      var raw = obj.text;
      var t = typeof raw === "string" ? raw
            : (raw || []).map(function (r) { return r && r.text != null ? String(r.text) : ""; }).join("");
      t = String(t).trim();
      if (t === "undefined" || t === "NaN" || t === "null" || t === "[object Object]") _junk[t] = (_junk[t] || 0) + 1;
    });
    Object.keys(_junk).forEach(function (k) {
      issues.push("第 " + no + " 页印出了 " + _junk[k] + " 处字面量 `" + k + "` —— " +
        "这是**数据键名写错**的典型症状：渲染器按自己的字段名去取值（比如 statStrip 取 `value`/`label`、" +
        "barsBlock 取 `name`/`v`），你给的对象里没有那个字段，取出来就是 undefined。" +
        "对照 components.md 的键名速查表改字段名，别改数据");
    });
    function warn(msg) { var k = "P" + no + msg; if (seen[k]) return; seen[k] = 1; warns.push("P" + no + " " + msg); }

    // --- 页底色兜底 ---
    // pptxgenjs 不设 background 就是纯白。主题纸色不是白的时候（多见于复刻用户上传的模板），
    // 漏设一页就白得很扎眼，而模型手写版式时几乎必忘。这里统一补上，页面自己铺了满版色块也不受影响。
    if (paper !== "FFFFFF" && !slide.background) { slide.background = { color: paper }; papered++; }

    // --- 反算字号 ---
    objs.forEach(function (obj) {
      if (obj._type !== "text" || !obj.text) return;
      var o = obj.options || {};
      if (o.autofit === false || typeof o.w !== "number" || o.w <= 0) return;
      var base = o.fontSize || 18, ins = insets(o);
      var availW = o.w - ins.x - (o.bullet ? 0.34 : 0);
      var paras = toParas(obj.text, base);
      // ⚠️ charSpacing 是逐字额外加的字距（pt），不计进宽度就会把末尾几个字符挤出框外
      if (o.charSpacing) {
        var nch = 0;
        paras.forEach(function (pa) { pa.forEach(function (r) { nch += String(r.s).length; }); });
        availW -= o.charSpacing * Math.max(0, nch - 1) / 72;
      }
      if (availW <= 0.12) return;
      if (!paras.map(function (p) { return p.map(function (r) { return r.s; }).join(""); }).join("").trim()) return;
      var gap = (o.paraSpaceAfter || 0) + (o.paraSpaceBefore || 0);
      var floor = Math.max(MIN_SIZE, o.minFontSize || 0);
      var hasH = typeof o.h === "number" && o.h > 0, availH = hasH ? (o.h - ins.y) * 72 : null;
      var cands = LADDER.filter(function (v) { return v <= base && v >= floor; });
      if (!cands.length || cands[0] !== base) cands.unshift(base);
      var pick = cands[cands.length - 1], firstFit = -1;
      for (var i = 0; i < cands.length; i++) {
        var sc = cands[i] / base;
        var ok = hasH ? (heightAt(paras, sc, availW * 72, gap, !!o.lineSpacingMultiple) <= availH)
                      : (paras.length > 1 || widthAt(paras, sc) <= availW * 72 * SAFETY);
        if (ok) { firstFit = i; pick = cands[i]; break; }
      }
      // 再往下最多找 3 档，换一个「不出现孤字破行」的字号（用户点名的「最后一个字被挤下去」）
      if (firstFit >= 0 && orphanBreak(paras, cands[firstFit] / base, availW * 72)) {
        for (var q = firstFit; q < Math.min(firstFit + 4, cands.length); q++) {
          var sq = cands[q] / base;
          var fitsQ = hasH ? (heightAt(paras, sq, availW * 72, gap, !!o.lineSpacingMultiple) <= availH) : true;
          if (fitsQ && !orphanBreak(paras, sq, availW * 72)) { pick = cands[q]; break; }
        }
      }
      // ★ 决定性检查：连最小字号都塞不进这个框 → 渲染时一定会溢出框外（体检看不到渲染，只能靠算）
      // 容差 1.12：测高模型刻意偏保守（LINE_H 1.30 vs 实测 1.20，自带 +8% 余量），
      // 所以"预测超出 <12%"在真实渲染里必然还装得下——按 1.04 报会全是假警报（实测确认过渲染无溢出）。
      if (hasH && heightAt(paras, pick / base, availW * 72, gap, !!o.lineSpacingMultiple) > availH * 1.12) {
        warn("文字塞不进框(会溢出到框外): 「" + clip(plainOf(obj), 18) + "」 需要 " +
             (heightAt(paras, pick / base, availW * 72, gap, !!o.lineSpacingMultiple) / 72).toFixed(2) + "\" / 框只有 " + o.h.toFixed(2) +
             "\" → 精简文案、调大区域，或去掉 minFontSize 限制");
      }
      texts.push({ obj: obj, base: base, pick: pick, floor: floor, o: o,
                   fitSize: firstFit >= 0 ? cands[firstFit] : pick });
    });

    // --- 平行元素字号统一 ---
    var groups = {};
    texts.forEach(function (t) {
      var o = t.o;
      var k = [Math.round(o.w * 100), Math.round((o.h || 0) * 100), t.base,
               o.bold ? 1 : 0, o.fontFace || "", o.align || "", o.bullet ? 1 : 0].join("|");
      (groups[k] = groups[k] || []).push(t);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k]; if (g.length < 2) return;
      var mn = Math.min.apply(null, g.map(function (t) { return t.pick; }));
      g.forEach(function (t) { t.pick = mn; });
    });
    // 任何需要折行的单行文本，一律手工均分断行。
    // 这样"渲染出来的断点"就等于"我算出来的断点"，孤字破行在数学上不可能发生
    //（只在明确会折行时才动手：总宽超过一行的 6% 以上，避免把本来一行的标题误拆成两行）。
    texts.forEach(function (t) {
      var o = t.o;
      if (o.bullet || !t.obj.text || t.obj.text.length !== 1) return;   // 只处理单 run 纯文本
      var availW2 = o.w - insets(o).x;
      if (availW2 <= 0.12) return;
      var paras2 = toParas(t.obj.text, t.base);
      if (paras2.length !== 1) return;
      var per = availW2 * 72 * SAFETY;
      var total = widthAt(paras2, t.pick / t.base);
      if (total <= per * 1.06) return;
      t.obj.text[0].text = balanceText(t.obj.text[0].text, per, t.pick);
    });

    texts.forEach(function (t) {
      if (t.pick >= t.base) return;
      shrunk++;
      var k = t.pick / t.base;
      // 只在「小到看不清」（≤9pt）或「腰斩」时报警。11→10 这种一档回退是设计内的正常行为，
      // 按 ≤10 报会把一半的正常页面标成问题页，反而淹掉真正要修的东西。
      if (t.fitSize <= 9 || t.fitSize / t.base < 0.5) {
        var lab = clip((t.obj.text || []).map(function (x) { return x && x.text; }).join(" "), 18);
        warn("文案过长(字号被迫 " + t.base + "→" + t.pick + "pt): 「" + lab + "」→ 精简文案或给它更大区域");
      }
      t.obj.options.fontSize = t.pick;
      (t.obj.text || []).forEach(function (r) {
        if (r && r.options && r.options.fontSize) r.options.fontSize = Math.max(t.floor, Math.round(r.options.fontSize * k));
      });
    });

    // --- 几何体检 ---
    var items = [];
    objs.forEach(function (obj, oi) {
      var o = obj.options || {}, r = rectOf(o); if (!r) return;
      var isText = obj._type === "text" && !!obj.text;
      // 旋转元素的矩形不是它的视觉外框（先排版再整体旋转），几何体检对它无意义，按装饰跳过
      items.push({ r: r, oi: oi, isText: isText, type: obj._type, opaque: opaque(o), decor: !!o._decor || !!o.rotate,
        label: isText ? clip((obj.text || []).map(function (x) { return x && x.text; }).join(""), 14) : "" });
    });
    items.forEach(function (it) {
      if (it.decor) return;
      if (!it.isText && !it.opaque && it.type !== "image") return;
      if (it.r.x < -0.03 || it.r.x + it.r.w > SW + 0.03 || it.r.y < -0.03 || it.r.y + it.r.h > SH + 0.03)
        warn("越界: " + (it.label ? "「" + it.label + "」" : it.type) +
             " [" + it.r.x.toFixed(2) + "," + it.r.y.toFixed(2) + " " + it.r.w.toFixed(2) + "x" + it.r.h.toFixed(2) + "] 画布 " + SW.toFixed(2) + "x" + SH.toFixed(2));
    });
    for (var a = 0; a < items.length; a++) for (var b = a + 1; b < items.length; b++) {
      var A = items[a], B = items[b];
      if (A.decor || B.decor) continue;
      var ov = inter(A.r, B.r); if (ov <= 0) continue;
      var ratio = ov / Math.min(A.r.w * A.r.h, B.r.w * B.r.h);
      if (A.isText && B.isText && A.label && B.label && ratio > 0.3) { warn("文字互相压盖: 「" + A.label + "」×「" + B.label + "」"); continue; }
      // 被后画的不透明块盖住 → 以「文字自身面积」为分母，避免细装饰线误报
      if (A.isText && A.label && B.opaque && !B.isText && ov / (A.r.w * A.r.h) > 0.55) { warn("图层错(内容被盖成空白卡): 「" + A.label + "」"); continue; }
      if (A.opaque && B.opaque && !A.isText && !B.isText && ratio > 0.12 && !contains(A.r, B.r) && !contains(B.r, A.r))
        warn("色块交叉重叠: [" + A.r.x.toFixed(2) + "," + A.r.y.toFixed(2) + "] × [" + B.r.x.toFixed(2) + "," + B.r.y.toFixed(2) + "]");
    }
    var cards = items.filter(function (i) { return i.opaque && !i.isText && !i.decor && i.r.w > 0.9 && i.r.h > 0.5; });
    items.filter(function (i) { return i.isText && i.label && !i.decor; }).forEach(function (t) {
      var host = null, best = 0;
      cards.forEach(function (c) { if (c.oi > t.oi) return; var ov = inter(c.r, t.r); if (ov > best) { best = ov; host = c; } });
      if (host && best / (t.r.w * t.r.h) > 0.3 && !contains(host.r, t.r, 0.06)) warn("文字探出卡片: 「" + t.label + "」");
    });
  });

  if (!quiet) {
    if (shrunk) console.log("[pptkit] 自动收字号 " + shrunk + " 处（已按阶梯统一）");
    // --- 版式坍缩 ---
  // 一份稿子里同一种正文结构反复出现三次以上，读者的第一感受就是"每页长得一样"。
  // 这是文档规则最管不住的一类问题：模型很容易写一个整页函数然后调 N 次，只换文字。
  // 用**几何指纹**判断（元素类型 + 位置尺寸取 0.25" 网格），所以不管用的是 page.* / compose /
  // 还是手写坐标都认得出来。复刻模板时页面共有的那套框（侧栏/页眉页脚）只占指纹的一小部分，
  // 不会把"框一样、瓤不同"误判成坍缩。
  function _fp(slide) {
    var fp = [];
    (slide._slideObjects || []).forEach(function (o) {
      var op = o.options || {};
      if (typeof op.x !== "number" || typeof op.w !== "number") return;
      var q = function (v) { return Math.round(v * 4) / 4; };
      fp.push((o._type || "?") + ":" + q(op.x) + "," + q(op.y) + "," + q(op.w) + "," + q(op.h));
    });
    return fp.sort();
  }
  function _jac(a, b) {
    var m = {}, inter = 0;
    a.forEach(function (k) { m[k] = (m[k] || 0) + 1; });
    b.forEach(function (k) { if (m[k] > 0) { m[k]--; inter++; } });
    var uni = a.length + b.length - inter;
    return uni ? inter / uni : 0;
  }
  var groups = [], divider = 0;
  (pres.slides || []).forEach(function (slide, si) {
    var rc = slide.__recipe || "";
    if (/^(cover|toc|section|closing)/.test(rc)) return;        // 封面/目录/过渡/结束页本来就该长一样
    var objs = slide._slideObjects || [];
    if (objs.length < 6) return;                                // 元素太少（大字页/整幅图页）没有"结构"可言
    // 章节过渡页/大字页本来就该长一样，得先摘出去。判据是**字数 + 字的分布**：
    // 过渡页字少（几十字）且几乎全集中在标题那一个框里；内容页字多且摊在很多框里。
    // （只看元素个数不行——装饰点阵能堆出几十个元素；只看总字数也不行——图表页本来字就少。）
    var chars = 0, maxOne = 0;
    objs.forEach(function (o) {
      if (o._type !== "text") return;
      var tx = o.text, n = 0;
      if (typeof tx === "string") n = tx.length;
      else if (Array.isArray(tx)) tx.forEach(function (r) { n += String((r && r.text) || "").length; });
      chars += n; if (n > maxOne) maxOne = n;
    });
    var lean = chars < 60 && maxOne / chars > 0.45;
    // 严格意义的"过渡页"：字少、字全挤在标题一个框里、且没有图表/图片/表格。
    // 不能把"图表页字本来就少"也算进去，否则数据型的稿子会被整片误报。
    // 首尾两页是封面和结束页，天然就是"大字少内容"，不能算进过渡页的账
    var edge = si === 0 || si === (pres.slides || []).length - 1;
    if (lean && !edge && !objs.some(function (o) { return /chart|image|table/.test(o._type || ""); })) divider++;
    if (lean) return;
    var fp = _fp(slide), kinds = (slide.__kinds || []).slice().sort().join("+"), hit = null;
    for (var g = 0; g < groups.length; g++) {
      // 两条判据取或：几何指纹高度重合，**或**区块组合完全相同。
      // 后者是必要的补充——同样是"四张卡+一条提示"，卡里行数差一行就会让几何相似度掉下去，
      // 但读者眼里那仍然是同一页。
      if (_jac(groups[g].fp, fp) >= 0.82 || (kinds && groups[g].kinds === kinds)) { hit = groups[g]; break; }
    }
    if (hit) hit.pages.push(si + 1);
    else groups.push({ fp: fp, pages: [si + 1], kinds: kinds });
  });
  // 过渡页/大字页占比过高：实测见过模型为了"每页不一样"在每张内容页前塞一张章节页，
  // 15 页里 6 页是过渡页——翻起来像在看目录，信息量还不如原来 10 页的版本。
  var nSlides = (pres.slides || []).length;
  if (divider >= 4 && divider > nSlides * 0.3) {
    warns.push("过渡页太多：全篇 " + nSlides + " 页里有 " + divider +
      " 页是几乎没内容的章节页/大字页 —— 章节页每 3–4 页内容配一张就够，" +
      "别拿它来充「版式变化」，变化要做在内容页里");
  }

  groups.forEach(function (g) {
    if (g.pages.length >= 3) {
      warns.push("版式坍缩：第 " + g.pages.join("/") + " 页的版式几乎完全一样" +
        (g.kinds ? "（" + g.kinds + "）" : "") + " —— 同一种结构最多用两次，请把其中 " +
        (g.pages.length - 2) + " 页换成别的区块组合（timeline / process / compare / matrix / quote / " +
        "table / photos / chart / layers 等）——「每页都长一样」是读者最先感觉到的问题");
    }
  });

  if (papered) console.log("[pptkit] 补页底色 " + papered + " 页（主题纸色 #" + paper + "，漏设会露白）");
    if (issues.length) {
      console.warn("[pptkit] ✗ 内容缺失 " + issues.length + " 处 —— 这些块一个字都没画出来，必须修完再继续：");
      issues.forEach(function (w) { console.warn("   - " + w); });
    }
    if (warns.length) {
      console.warn("[pptkit] ⚠ 排版问题 " + warns.length + " 处，必须修完再继续：");
      warns.slice(0, 25).forEach(function (w) { console.warn("   - " + w); });
      if (warns.length > 25) console.warn("   … 其余 " + (warns.length - 25) + " 条");
    }
    if (!issues.length && !warns.length) console.log("[pptkit] ✅ 体检通过：无溢出、无越界、无重叠");
  }
  return { shrunk: shrunk, warns: warns, issues: issues };
}

/* ═══════════════ 3. 套件主体 ═══════════════ */

module.exports = function pptkit(pres, THEME, cfg) {
  cfg = cfg || {};
  var C = Object.assign({}, THEME.colors), F = THEME.fonts;
  // 中文 deck 建议统一字体（拉丁字体在中文回退时会出现字重/字形不一致）：
  //   require("./pptkit.js")(pres, THEME, { font: "Microsoft YaHei" })   Linux: "Noto Sans CJK SC"
  if (cfg.font) F = { title: cfg.font, body: cfg.font, accent: F.accent || cfg.font };
  var BRAND = cfg.brand || null;                 // "unicom" 走联通品牌页型
  var LOGOS = cfg.logos || {};

  function cv() { var L = pres.presLayout || {}; return { w: L.width ? L.width / 914400 : 10, h: L.height ? L.height / 914400 : 5.625 }; }
  var WIDE = function () { return cv().w > 12; };
  function M() { return WIDE() ? 0.62 : 0.5; }          // 页边距
  function shadow(op) { return { type: "outer", color: "000000", blur: 12, offset: 3, angle: 90, opacity: op || 0.09 }; }
  // 图表配色：相邻系列色相必须拉得开。联通主题的 primary/secondary/accent 都是红，
  // 直接按主题顺序上色会出现"两根柱都是红、根本分不清"，所以做一次去近色。
  function _rgb(h) { h = String(h || "").replace("#", ""); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; }
  function _far(a, b) { var x = _rgb(a), y = _rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) > 90; }
  function chartPalette() {
    var out = [];
    [C.primary, C.accent, C.text_muted, C.secondary, C.text_on_light].forEach(function (c) {
      if (c && out.every(function (p) { return _far(p, c); })) out.push(c);
    });
    ["5B5B5B", "9E9E9E", "3C3C3C", "C8C8C8"].forEach(function (c) {
      if (out.length < 6 && out.every(function (p) { return _far(p, c); })) out.push(c);
    });
    return out;
  }
  function _hex(n) { n = Math.max(0, Math.min(255, Math.round(n))); return ("0" + n.toString(16)).slice(-2).toUpperCase(); }
  /** 把颜色按比例向白色调淡（0=原色，1=纯白） */
  function tint(c, k) { var x = _rgb(c); return _hex(x[0] + (255 - x[0]) * k) + _hex(x[1] + (255 - x[1]) * k) + _hex(x[2] + (255 - x[2]) * k); }
  // ★ 次级文字对比度：多数主题的 text_muted 对白底只有 3.5:1（低于 WCAG AA 4.5），
  //   整页读起来"发糊、像线框图"。这里把它朝正文色压深一档，得到约 7:1 的中间层。
  function _mix(a, b, k) { var x = _rgb(a), y = _rgb(b);
    return _hex(x[0] + (y[0] - x[0]) * k) + _hex(x[1] + (y[1] - x[1]) * k) + _hex(x[2] + (y[2] - x[2]) * k); }
  C.text_muted = _mix(C.text_muted || "808080", C.text_on_light || "1A1A1A", 0.45);   // 次级正文
  C.text_faint = _mix(C.text_muted, C.card_bg || "FFFFFF", 0.42);                     // 页码/出处这种真·弱化
  // 语义色：涨/跌/警示。图表和数字要能一眼看出好坏，否则整页只有"黑蓝灰"三档
  C.up = C.up || "1B8A5A"; C.down = C.down || "C0392B"; C.warn = C.warn || "B7791F";
  // 语义色：tone:"up"|"down"|"warn" → 绿/红/琥珀。数字带 +/↑ 或 -/↓ 时自动判定
  function TONE(k) { return k === "up" ? C.up : k === "down" ? C.down : k === "warn" ? C.warn : null; }
  function autoTone(v) { v = String(v == null ? "" : v).trim();
    if (/^[+↑▲]/.test(v)) return "up"; if (/^[-−↓▼]/.test(v)) return "down"; return null; }
  function decor(o) { o._decor = true; return o; }      // 标记为装饰（体检不计越界/重叠）
  // ⚠️ 主题可移植性：有些主题的 accent 恰好和 bg_dark 很接近（如 coral-energy 的 accent=藏蓝、bg_dark 也是藏蓝），
  // 直接拿 accent 画在深色封面上会**整个看不见**。这里挑第一个与背景拉得开的颜色。
  function onBg(bg) {
    var cand = [C.accent, C.secondary, C.primary, C.text_on_dark];
    for (var i = 0; i < cand.length; i++) if (cand[i] && _far(bg, cand[i])) return cand[i];
    return C.text_on_dark || "FFFFFF";
  }
  var S = function () {                                  // 字号基准（随画布放大）
    var k = WIDE() ? 1.15 : 1;
    return { coverTitle: Math.round(44 * k), coverSub: Math.round(20 * k), pageTitle: Math.round(26 * k),
             cardTitle: Math.round(18 * k), body: Math.round(14 * k), cap: Math.round(11 * k),
             kpi: Math.round(40 * k), sectionNo: Math.round(120 * k) };
  };

  /* ---------- 布局网格 ---------- */
  function bodyArea(o) {
    o = o || {}; var c = cv(), m = o.m != null ? o.m : M();
    var top = o.top != null ? o.top : (BRAND === "unicom" ? 1.20 : HDR().bodyTop);
    var bot = o.bottom != null ? o.bottom : (WIDE() ? 0.50 : 0.40);
    return { x: m, y: top, w: c.w - 2 * m, h: c.h - top - bot };
  }
  // rowsOf / colsOf **都同时接受**「份数」和「比例数组」：
  //   rowsOf(a, 2)  rowsOf(a, [1, 1.6])   colsOf(a, 3)  colsOf(a, [1, 1.2])
  // （曾经 rowsOf 收比例、colsOf 收份数，模型必然写混，写混就直接算出 NaN 矩形 → 元素乱叠。）
  function _parts(spec, who) {
    if (Array.isArray(spec) && spec.length) {
      var ok = spec.every(function (v) { return typeof v === "number" && isFinite(v) && v > 0; });
      if (ok) return spec.slice();
    }
    if (typeof spec === "number" && isFinite(spec) && spec >= 1) {
      var out = []; for (var i = 0; i < Math.floor(spec); i++) out.push(1); return out;
    }
    console.warn("[pptkit] ⚠ " + who + " 收到无效的划分参数（" + JSON.stringify(spec) + "），已按 2 等分处理：" +
      "第二个参数要么是份数（如 2），要么是比例数组（如 [1, 1.6]）");
    return [1, 1];
  }
  function rowsOf(a, parts, gap) {
    gap = gap == null ? 0.34 : gap;
    parts = _parts(parts, "rowsOf");
    var sum = parts.reduce(function (s, v) { return s + v; }, 0);
    var usable = a.h - gap * (parts.length - 1), y = a.y, out = [];
    parts.forEach(function (p) { var h = usable * p / sum; out.push({ x: a.x, y: y, w: a.w, h: h }); y += h + gap; });
    return out;
  }
  function colsOf(a, parts, gap) {
    gap = gap == null ? 0.32 : gap;
    parts = _parts(parts, "colsOf");
    var sum = parts.reduce(function (s, v) { return s + v; }, 0);
    var usable = a.w - gap * (parts.length - 1), x = a.x, out = [];
    parts.forEach(function (p) { var w = usable * p / sum; out.push({ x: x, y: a.y, w: w, h: a.h }); x += w + gap; });
    return out;
  }
  function padOf(a, p) { p = p == null ? 0.25 : p; return { x: a.x + p, y: a.y + p, w: a.w - 2 * p, h: a.h - 2 * p }; }
  /** 顶部切一条**固定高度**的带（比例切法会让 KPI 大数字被压小），返回 [带, 余下]。 */
  function bandTop(a, hh, gap, minRest) {
    gap = gap == null ? 0.34 : gap;
    hh = Math.min(hh, a.h * 0.62);
    if (minRest) hh = Math.min(hh, Math.max(1.05, a.h - gap - minRest));   // 下半块该有的高度优先保证
    return [{ x: a.x, y: a.y, w: a.w, h: hh },
            { x: a.x, y: a.y + hh + gap, w: a.w, h: a.h - hh - gap }];
  }
  function KPI_H() { return WIDE() ? 1.88 : 1.64; }   // KPI 瓦片的理想高度（够放 40pt 大数字）

  /* ---------- 基础件 ---------- */
  function card(s, a, o) {
    o = o || {};
    var r = o.radius != null ? o.radius : 0.10;
    var base = { x: a.x, y: a.y, w: a.w, h: a.h, fill: { color: o.fill || C.card_bg },
                 line: { color: o.border || C.card_border, width: 0.75 }, shadow: shadow(o.shadow) };
    // ⚠️ rectRadius:0 会被 pptxgenjs 当 falsy 忽略 → 渲染成默认大圆角，所以直角必须用 RECTANGLE
    if (r > 0) s.addShape(pres.shapes.ROUNDED_RECTANGLE, Object.assign({ rectRadius: r }, base));
    else s.addShape(pres.shapes.RECTANGLE, base);
    // 左侧品牌色导轨：商用 deck 让卡片"有归属"的最省力手段
    if (o.rail) s.addShape(pres.shapes.RECTANGLE, { x: a.x, y: a.y + (r > 0 ? 0.09 : 0), w: 0.055,
      h: a.h - (r > 0 ? 0.18 : 0), fill: { color: o.rail === true ? C.primary : o.rail } });
  }
  function bullets(lines) {
    return (lines || []).map(function (t, i) {
      // indent 收紧到 8pt：默认缩进太宽，会白白吃掉一行的可用宽度导致提前折行
      return { text: String(t), options: { bullet: { code: "2022", indent: 8 }, breakLine: i < lines.length - 1 } };
    });
  }

  /* ---------- 页型 ---------- */
  // 联通品牌页眉（坐标逐一实测自源模板 数智公司PPT模版-联通元景，勿改）
  function unicomFrame(s, title, pageNo) {
    var c = cv();
    // 竖条底端与红规则线上沿严格对齐（越过去会在左上角出现"十字"穿帮）
    s.addShape(pres.shapes.RECTANGLE, { x: 0.06, y: 0.06, w: 0.11, h: 0.72, fill: { color: C.primary } });
    s.addShape(pres.shapes.LINE, { x: 0.20, y: 0.06, w: 0, h: 0.72, line: { color: C.primary, width: 1.5 } });
    if (title) s.addText(String(title), { x: 0.40, y: 0.17, w: 8.9, h: 0.52, valign: "middle",
      fontFace: F.title, fontSize: 24, bold: true, color: "000000", margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0.78, w: c.w, h: 0.045, fill: { color: C.primary } });
    if (LOGOS.dual) s.addImage({ path: LOGOS.dual, x: 9.558, y: 0.158, w: 3.601, h: 0.86 });
    if (pageNo != null) s.addText(String(pageNo), { x: c.w - 1.15, y: c.h - 0.47, w: 0.9, h: 0.3,
      align: "right", valign: "middle", fontFace: F.body, fontSize: 12, color: "808080", margin: 0 });
  }
  // 页眉纵向刻度（一处定义，bodyArea 也用它，保证分隔线永远在标题框下方、内容区上方）
  function HDR() {
    var w = WIDE();
    return { kickerY: w ? 0.40 : 0.36, kickerH: w ? 0.30 : 0.28,
             titleY: w ? 0.76 : 0.66, titleH: w ? 0.80 : 0.66,
             rule: w ? 1.62 : 1.38, bodyTop: w ? 1.74 : 1.48 };
  }
  function genericHeader(s, o) {
    var c = cv(), m = M(), H = HDR();
    if (o.kicker) {
      // kicker 做成品牌色小胶囊（商用 deck 的标准做法），比一行灰色小字有分量
      var kw = Math.min(c.w * 0.42, textEm(String(o.kicker), true) * 11 / 72 + 0.46);
      // 用实色淡化（tint）而不是 transparency：暖色/浅色主题下透明叠加会淡到看不见胶囊形状
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: m, y: H.kickerY, w: kw, h: H.kickerH, rectRadius: 0.14,
        fill: { color: tint(C.primary, 0.84) } });
      s.addText(String(o.kicker).toUpperCase(), { x: m, y: H.kickerY, w: kw, h: H.kickerH, align: "center", valign: "middle",
        fontFace: F.accent, fontSize: 10, bold: true, color: C.primary, charSpacing: 1.5, margin: 0 });
    }
    s.addShape(pres.shapes.RECTANGLE, { x: m, y: H.titleY + 0.05, w: 0.075, h: H.titleH - 0.10, fill: { color: C.primary } });
    // 页码在左下角不在右上 → 标题可吃满宽度；框留两行高 + 字号下限 20，长标题优先折两行而不是无限缩小
    s.addText(o.title || "", { x: m + 0.22, y: H.titleY, w: c.w - 2 * m - 0.42, h: H.titleH,
      valign: "middle", fontFace: F.title, fontSize: S().pageTitle, bold: true, color: C.text_on_light,
      margin: 0, minFontSize: 20 });
    // 页眉下的细分隔线：必须在标题框**下方**（否则长标题会被这根线穿过去）
    s.addShape(pres.shapes.RECTANGLE, decor({ x: m, y: H.rule, w: c.w - 2 * m, h: 0.012, fill: { color: C.card_border } }));
    if (o.pageNo != null) s.addText(String(o.pageNo) + (o.of ? "  /  " + o.of : ""),
      { x: c.w - m - 1.1, y: c.h - 0.46, w: 1.1, h: 0.3, align: "right",
        fontFace: F.accent, fontSize: 10, color: C.text_faint, charSpacing: 1, margin: 0 });
    // 页眉右侧的章节指示（running header）：读者翻到第 8 页也知道自己在第几章
    if (o.chapter) s.addText(String(o.chapter), { x: c.w - m - 3.2, y: H.kickerY, w: 3.2, h: H.kickerH,
      align: "right", valign: "middle", fontFace: F.body, fontSize: 10, color: C.text_faint, margin: 0 });
    // 数据出处脚注：商用稿的标配，同时把页面底部的空白用掉
    if (o.source) s.addText(String(o.source), { x: m, y: c.h - 0.46, w: c.w - 2 * m - 1.3, h: 0.3, valign: "middle",
      fontFace: F.body, fontSize: 9, color: C.text_faint, margin: 0 });
  }

  /** 内容页：返回 { s, a } —— s=slide，a=版心区域。之后只需要切 a，绝不手算坐标。 */
  // 复刻用户上传的模板时注册一次：FRAME(slide, o) 负责画模板每页都有的"框"
  // （侧栏 / 顶部色带 / 页眉页脚 / 编号 / logo），并返回正文可用区 {x,y,w,h}。
  // 注册之后所有内置页型都改用它 —— 模型继续用 contentSlide/page.* 就自动带上模板的脸，
  // 不必也不该去手写整页。（实测：只在文档里叮嘱"自己写 frame"，模型照旧调 contentSlide，
  // 于是模板最认脸的顶部色带整份丢失。这种事得给个正规入口，不能靠自觉。）
  var FRAME = null;
  function setFrame(fn) { FRAME = typeof fn === "function" ? fn : null; }

  function contentSlide(o) {
    o = o || {};
    var s = pres.addSlide();
    s.background = { color: o.bg || (BRAND === "unicom" ? "FFFFFF" : C.bg_light) };
    if (FRAME) {
      var a = FRAME(s, o);
      _markContent(s);
      if (o.note) s.addNotes(o.note);
      return { s: s, a: (a && typeof a.h === "number" && a.h > 0) ? a : bodyArea(o.area || {}) };
    }
    if (BRAND === "unicom") unicomFrame(s, o.title, o.pageNo); else genericHeader(s, o);
    _markContent(s);
    if (o.note) s.addNotes(o.note);
    return { s: s, a: bodyArea(o.area || {}) };
  }

  function coverSlide(o) {
    o = o || {};
    var c = cv(), m = M(), s = pres.addSlide();
    if (BRAND === "unicom") {
      // 严格复刻源模板封面：纯白底 + 右上双 logo + 居中大红标题 + 左侧亮红条 + 单位/日期
      s.background = { color: "FFFFFF" };
      if (LOGOS.dual) s.addImage({ path: LOGOS.dual, x: 8.266, y: 0.494, w: 4.778, h: 1.141 });
      s.addText(o.title || "", { x: 1.0, y: 2.613, w: c.w - 2.0, h: 1.008, align: "center", valign: "middle",
        fontFace: F.title, fontSize: 36, bold: true, color: C.primary, margin: 0 });
      if (o.sub) s.addText(o.sub, { x: 1.0, y: 3.70, w: c.w - 2.0, h: 0.5, align: "center",
        fontFace: F.body, fontSize: 18, color: "606060", margin: 0 });
      s.addShape(pres.shapes.RECTANGLE, { x: 1.62, y: 5.16, w: 0.06, h: 1.24, fill: { color: C.secondary || "EE0000" } });
      if (o.org) s.addText(o.org, { x: 2.07, y: 5.20, w: 6.4, h: 0.506, valign: "middle",
        fontFace: F.title, fontSize: 22, bold: true, color: "000000", margin: 0 });
      if (o.date) s.addText(o.date, { x: 2.07, y: 5.852, w: 4.6, h: 0.506, valign: "middle",
        fontFace: F.title, fontSize: 22, bold: true, color: "000000", margin: 0 });
    } else if (o.photo) {
      // 照片封面：整幅实景图 + 压暗遮罩 + 左下大标题。旅游/文旅/发布会类最有说服力的封面
      s.background = { color: C.bg_dark };
      photo(s, { x: 0, y: 0, w: c.w, h: c.h }, o.photo);
      s.addShape(pres.shapes.RECTANGLE, decor({ x: 0, y: 0, w: c.w, h: c.h,
        fill: { color: "000000", transparency: o.scrim == null ? 62 : o.scrim } }));
      scrimBand(s, 0, c.h * 0.32, c.w, c.h * 0.68);      // 下 2/3 再压一道渐变，保证文字可读
      var px = m + 0.55, ACC0 = onBg(C.bg_dark);
      s.addShape(pres.shapes.RECTANGLE, { x: px, y: c.h * 0.50, w: 0.62, h: 0.05, fill: { color: ACC0 } });
      if (o.kicker) s.addText(String(o.kicker).toUpperCase(), { x: px, y: c.h * 0.55, w: c.w * 0.62, h: 0.30,
        fontFace: F.accent, fontSize: 12, bold: true, color: "E2E2E2", charSpacing: 3, margin: 0 });
      s.addText(o.title || "", { x: px, y: c.h * 0.625, w: c.w * 0.66, h: c.h * 0.20, valign: "middle",
        fontFace: F.title, fontSize: S().coverTitle, bold: true, color: "FFFFFF", margin: 0, minFontSize: 26 });
      if (o.sub) s.addText(o.sub, { x: px, y: c.h * 0.835, w: c.w * 0.60, h: 0.40,
        fontFace: F.body, fontSize: S().coverSub, color: "E8E8E8", margin: 0 });
      var pf = [o.org, o.date].filter(Boolean).join("   ·   ");
      if (pf) s.addText(pf, { x: c.w - m - 4.2, y: c.h - 0.62, w: 4.0, h: 0.34, align: "right", valign: "middle",
        fontFace: F.body, fontSize: 12, color: "D0D0D0", margin: 0 });
    } else {
      s.background = { color: C.bg_dark };
      coverDecor(s, o.motif || "rings");
      var lx = m + 0.55;
      // 标题上方的短强调线 + kicker，构成"三段式"排版（线 / 小字 / 大标题），比只有一根竖条有设计感
      var ACC = onBg(C.bg_dark);
      s.addShape(pres.shapes.RECTANGLE, { x: lx, y: c.h * 0.285, w: 0.62, h: 0.05, fill: { color: ACC } });
      if (o.kicker) s.addText(String(o.kicker).toUpperCase(), { x: lx, y: c.h * 0.335, w: c.w * 0.56, h: 0.30,
        fontFace: F.accent, fontSize: 12, bold: true, color: ACC, charSpacing: 3, margin: 0 });
      s.addText(o.title || "", { x: lx, y: c.h * 0.415, w: c.w * 0.60, h: c.h * 0.24, valign: "middle",
        fontFace: F.title, fontSize: S().coverTitle, bold: true, color: C.text_on_dark, margin: 0, minFontSize: 26 });
      if (o.sub) s.addText(o.sub, { x: lx, y: c.h * 0.685, w: c.w * 0.58, h: 0.44,
        fontFace: F.body, fontSize: S().coverSub, color: C.text_on_dark, transparency: 26, margin: 0 });
      var foot = [o.org, o.date].filter(Boolean).join("   ·   ");
      if (foot) {
        // 竖条挂在版心外（hanging），文字左边界与标题/kicker 严格对齐——否则全页只有这一行错开 0.18"
        s.addShape(pres.shapes.RECTANGLE, { x: lx - 0.18, y: c.h * 0.845, w: 0.035, h: 0.34, fill: { color: ACC } });
        s.addText(foot, { x: lx, y: c.h * 0.845, w: c.w * 0.58, h: 0.34, valign: "middle",
          fontFace: F.body, fontSize: 12, color: C.text_on_dark, transparency: 40, margin: 0 });
      }
    }
    if (o.note) s.addNotes(o.note);
    return s;
  }

  function coverDecor(s, motif) {
    var c = cv();
    if (motif === "band") {
      s.addShape(pres.shapes.RECTANGLE, decor({ x: c.w - 3.2, y: -1.2, w: 2.2, h: c.h + 2.4, rotate: 18, fill: { color: C.accent, transparency: 82 } }));
      s.addShape(pres.shapes.RECTANGLE, decor({ x: c.w - 2.0, y: -1.2, w: 1.0, h: c.h + 2.4, rotate: 18, fill: { color: C.secondary, transparency: 68 } }));
    } else if (motif === "dots") {
      for (var r = 0; r < 4; r++) for (var k = 0; k < 6; k++)
        s.addShape(pres.shapes.OVAL, decor({ x: c.w - 2.6 + k * 0.38, y: c.h - 2.0 + r * 0.38, w: 0.09, h: 0.09, fill: { color: C.accent, transparency: 25 } }));
    } else {                   // rings：右上同心圆 + 一圈描边环 + 右下点阵，构成有层次的封面母题
      // 透明度都调得很高：装饰是"底纹"不是"主角"，压过标题就成了廉价感的来源
      // 只让弧线进画面（圆心推到画布外），装饰是底纹不是主角
      s.addShape(pres.shapes.OVAL, decor({ x: c.w - 2.6, y: -2.2, w: 5.4, h: 5.4, fill: { color: C.primary, transparency: 84 } }));
      s.addShape(pres.shapes.OVAL, decor({ x: c.w - 1.7, y: -1.3, w: 3.4, h: 3.4, fill: { color: onBg(C.bg_dark), transparency: 90 } }));
      s.addShape(pres.shapes.OVAL, decor({ x: c.w - 3.9, y: -3.3, w: 7.6, h: 7.6,   // 纯描边环：不给 fill
        line: { color: onBg(C.bg_dark), width: 1, transparency: 60 } }));
      for (var r2 = 0; r2 < 3; r2++) for (var k2 = 0; k2 < 5; k2++)
        s.addShape(pres.shapes.OVAL, decor({ x: c.w - 1.9 + k2 * 0.3, y: c.h - 1.35 + r2 * 0.3, w: 0.08, h: 0.08,
          fill: { color: onBg(C.bg_dark), transparency: 45 } }));
    }
  }

  /** 目录页：章节数任意，自动等距；样式完全一致（不会一条蓝一条灰）。 */
  function tocSlide(o) {
    o = o || {};
    var c = cv(), m = M(), s = pres.addSlide();
    var list = (o.chapters || []).filter(function (t) { return String(t == null ? "" : t).trim() !== ""; });
    if (!list.length) issue("tocSlide 缺少有效的 `chapters`（字段没给，或者给的全是空字符串），" +
      "目录页只会剩下「CONTENTS/目录」页眉");
    s.background = { color: BRAND === "unicom" ? "FFFFFF" : C.bg_light };
    if (BRAND === "unicom") {
      // 复刻源模板目录页：左「CONTENTS/目录」+ 红竖分隔条 + 右侧章节色条（首章红、其余灰）
      s.addText("CONTENTS", { x: 0.5, y: 1.35, w: 3.0, h: 0.5, fontFace: "Impact", fontSize: 20, color: "303030", charSpacing: 1, margin: 0 });
      s.addText("目录", { x: 0.5, y: 1.80, w: 3.1, h: 1.3, valign: "middle", fontFace: F.title, fontSize: 60, bold: true, color: "303030", charSpacing: 2, margin: 0 });
      s.addShape(pres.shapes.RECTANGLE, { x: 3.755, y: 1.826, w: 0.125, h: 4.291, fill: { color: C.primary } });
      if (LOGOS.dual) s.addImage({ path: LOGOS.dual, x: 9.558, y: 0.158, w: 3.601, h: 0.86 });
      var n2 = Math.max(1, list.length), top2 = 1.83, bot2 = 6.12;
      var rowH2 = Math.min(0.80, (bot2 - top2) / n2 * 0.80);
      var gap2 = n2 > 1 ? Math.max(0.12, (bot2 - top2 - n2 * rowH2) / (n2 - 1)) : 0;
      var CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
      list.forEach(function (t, i) {
        var y = top2 + i * (rowH2 + gap2), col = i === 0 ? C.primary : "808080";
        s.addShape(pres.shapes.RECTANGLE, { x: 4.51, y: y, w: 0.84, h: rowH2, fill: { color: col } });
        s.addText(CN[i] || String(i + 1), { x: 4.51, y: y, w: 0.84, h: rowH2, align: "center", valign: "middle",
          fontFace: F.title, fontSize: 22, bold: true, color: "FFFFFF", margin: 0 });
        s.addShape(pres.shapes.RECTANGLE, { x: 5.43, y: y, w: 7.30, h: rowH2, fill: { color: col } });
        s.addText(String(t), { x: 5.68, y: y, w: 6.80, h: rowH2, valign: "middle",
          fontFace: F.title, fontSize: 20, bold: true, color: "FFFFFF", margin: 0 });
      });
      if (o.pageNo != null) s.addText(String(o.pageNo), { x: c.w - 1.15, y: c.h - 0.47, w: 0.9, h: 0.3,
        align: "right", valign: "middle", fontFace: F.body, fontSize: 12, color: "808080", margin: 0 });
      if (o.note) s.addNotes(o.note);
      return s;
    }
    // 目录页与内容页共用同一套页眉（kicker 胶囊 + 主色竖条 + 分隔线），
    // 否则它会成为全篇唯一停留在旧样式的一页——而它偏偏是第 2 页，一翻就露馅。
    genericHeader(s, { kicker: "CONTENTS", title: o.title || "目录", pageNo: o.pageNo, of: o.of });
    var a = bodyArea({});
    var n = Math.max(1, list.length);
    var twoCol = n > 5;
    var cols = twoCol ? colsOf(a, 2, 0.5) : [a];
    var per = twoCol ? Math.ceil(n / 2) : n;
    var rowH = Math.min(0.92, a.h / per * 0.78);
    var gapR = per > 1 ? Math.max(0.10, (a.h - per * rowH) / (per - 1)) : 0;
    var chip = Math.min(0.58, rowH * 0.82);
    list.forEach(function (t, i) {
      var col = cols[twoCol ? Math.floor(i / per) : 0], k = twoCol ? i % per : i;
      var y = col.y + k * (rowH + gapR), tx = col.x + chip * 1.14 + 0.26;
      s.addShape(pres.shapes.RECTANGLE, { x: tx, y: y + rowH - 0.012, w: col.w - chip * 1.14 - 0.26, h: 0.012, fill: { color: C.card_border } });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: col.x, y: y + (rowH - chip) / 2, w: chip * 1.14, h: chip,
        rectRadius: 0.07, fill: { color: C.primary } });
      s.addText(("0" + (i + 1)).slice(-2), { x: col.x, y: y + (rowH - chip) / 2, w: chip * 1.14, h: chip,
        align: "center", valign: "middle", fontFace: F.title, fontSize: 16, bold: true, color: C.text_on_dark, margin: 0 });
      s.addText(String(t), { x: tx, y: y, w: col.w - chip * 1.14 - 0.26, h: rowH, valign: "middle",
        fontFace: F.title, fontSize: twoCol ? 17 : 20, color: C.text_on_light, margin: 0, minFontSize: 13 });
    });
    if (o.note) s.addNotes(o.note);
    return s;
  }

  /** 章节过渡页：左侧品牌色块 + 巨号数字，右侧白底放标题。比"整页纯色 + 一个水印数字"专业得多。 */
  function sectionSlide(o) {
    o = o || {};
    var c = cv(), s = pres.addSlide();
    s.background = { color: C.bg_light || "FFFFFF" };
    var lw = c.w * 0.38, noTxt = ("0" + (o.no || 1)).slice(-2);
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: lw, h: c.h, fill: { color: C.primary } });
    // 巨号数字压在色块上（同色系提亮，不是白色水印，层次更细腻）
    s.addText(noTxt, decor({ x: 0, y: c.h * 0.22, w: lw, h: c.h * 0.56, align: "center", valign: "middle",
      fontFace: F.title, fontSize: Math.round(c.h * 22), bold: true, color: C.text_on_dark, transparency: 72,
      margin: 0, autofit: false }));
    // 右侧内容：kicker → 标题 → 短横线
    var rx = lw + (WIDE() ? 0.95 : 0.75), rw = c.w - rx - M();
    if (o.sub) s.addText(String(o.sub).toUpperCase(), { x: rx, y: c.h * 0.36, w: rw, h: 0.3,
      fontFace: F.accent, fontSize: 11, bold: true, color: C.primary, charSpacing: 2.5, margin: 0 });
    s.addText(o.title || "", { x: rx, y: c.h * 0.44, w: rw, h: c.h * 0.22, valign: "middle",
      fontFace: F.title, fontSize: WIDE() ? 36 : 32, bold: true, color: C.text_on_light, margin: 0, minFontSize: 22 });
    s.addShape(pres.shapes.RECTANGLE, { x: rx, y: c.h * 0.70, w: 1.05, h: 0.05, fill: { color: C.accent || C.primary } });
    // 右下角小圆点阵，作为全篇重复的视觉母题
    for (var r = 0; r < 3; r++) for (var k = 0; k < 5; k++)
      s.addShape(pres.shapes.OVAL, decor({ x: c.w - 1.55 + k * 0.26, y: c.h - 1.05 + r * 0.26, w: 0.07, h: 0.07,
        fill: { color: C.primary, transparency: 62 } }));
    if (o.note) s.addNotes(o.note);
    return s;
  }

  function closingSlide(o) {
    o = o || {};
    var c = cv(), s = pres.addSlide();
    if (BRAND === "unicom") {
      s.background = { color: "FFFFFF" };
      if (LOGOS.dual) s.addImage({ path: LOGOS.dual, x: 8.266, y: 0.494, w: 4.778, h: 1.141 });
      s.addText(o.title || "谢谢观看", { x: 1.0, y: 3.10, w: c.w - 2.0, h: 1.10, align: "center", valign: "middle",
        fontFace: F.title, fontSize: 44, bold: true, color: C.primary, margin: 0 });
      s.addShape(pres.shapes.RECTANGLE, { x: c.w / 2 - 0.75, y: 4.42, w: 1.5, h: 0.05, fill: { color: C.secondary || "EE0000" } });
      if (o.sub) s.addText(o.sub, { x: 1.0, y: 4.62, w: c.w - 2.0, h: 0.5, align: "center",
        fontFace: F.body, fontSize: 16, color: "606060", margin: 0 });
      var uf = [o.org, o.date].filter(Boolean).join("   ·   ");
      if (uf) s.addText(uf, { x: 1.0, y: 5.60, w: c.w - 2.0, h: 0.42, align: "center",
        fontFace: F.body, fontSize: 14, color: "808080", margin: 0 });
    } else {
      s.background = { color: C.bg_dark };
      coverDecor(s, o.motif || "dots");
      s.addText(o.title || "谢谢观看", { x: c.w * 0.1, y: c.h * 0.36, w: c.w * 0.8, h: 1.0, align: "center", valign: "middle",
        fontFace: F.title, fontSize: WIDE() ? 46 : 40, bold: true, color: C.text_on_dark, margin: 0 });
      var ACC2 = onBg(C.bg_dark);
      s.addShape(pres.shapes.RECTANGLE, { x: c.w / 2 - 0.6, y: c.h * 0.60, w: 1.2, h: 0.045, fill: { color: ACC2 } });
      if (o.sub) s.addText(o.sub, { x: c.w * 0.1, y: c.h * 0.655, w: c.w * 0.8, h: 0.42, align: "center",
        fontFace: F.accent, fontSize: 14, color: ACC2, charSpacing: 3, margin: 0 });
      var foot = [o.org, o.date].filter(Boolean).join("   ·   ");
      if (foot) s.addText(foot, { x: c.w * 0.1, y: c.h * 0.80, w: c.w * 0.8, h: 0.36, align: "center",
        fontFace: F.body, fontSize: 13, color: C.text_on_dark, transparency: 45, margin: 0 });
    }
    if (o.note) s.addNotes(o.note);
    return s;
  }

  /* ---------- 内容区块：全部吃 area，自己算内部布局，保证不越界不重叠 ---------- */

  // 区块的区域守卫：模型忘了传 a（或传了残缺的矩形）时，**不许把整份 PPT 搞崩**，
  // 而是退回整块版心并明确告警——一页排版不理想远好过 node 直接报错、一页都生不出来。
  /* ---------- 语义完整性收集器 ----------
   * 区块拿不到必需数据时「什么都不画」是本文件最贵的一类 bug：页眉照画、
   * audit 只查溢出/重叠 → 空白页稳过 ✅，一路交付到用户手里。
   * 所以任何「本块未绘制」都必须登记到这里，由 audit() 汇报、writeFile 阻断。 */
  function issue(msg) {
    (pres.__pptkitIssues || (pres.__pptkitIssues = [])).push(msg);
    console.warn("[pptkit] ✗ " + msg);
  }
  /** 必需字段校验：缺了就登记并告诉调用方「别画了」。key 是**正确**的字段名，写进报错里 */
  /* 页级完整性：记下「页眉刚画完」时的元素个数。
   * 之后但凡有一个元素被加进来（pptkit 区块也好、模型自己手写 addText 也好），个数就会变大；
   * 到出稿时个数原封不动 = 这一页只有页眉，正文整块缺失 —— 正是截图第 3 页那种。
   * 用「元素个数」而不是「有没有调用区块」来判定，是为了不误伤合法的手写版式页。 */
  function _markContent(s) { s.__pptkitHdrObjs = (s._slideObjects || []).length; }

  /** 递归判断「这坨数据里到底有没有一个字」。{}、[""]、{k:""} 一律算空。 */
  function _hasAny(v) {
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (typeof v === "number") return true;
    if (Array.isArray(v)) return v.some(_hasAny);
    if (typeof v === "object") return Object.keys(v).some(function (k) { return _hasAny(v[k]); });
    return !!v;
  }

  /** 数组类区块：容器非空还不够，里面得真有内容，否则画出来是一排空壳。
   *  只在**一个有内容的项都没有**时拦 —— 逐项都查会误伤合法的省略写法（卡片只给 title 不给 lines）。*/
  function mustHaveItems(o, key, who, need, known) {
    if (!mustHave(o, key, who)) return false;
    var list = o[key], bad = [];
    list.forEach(function (it, i) { if (!_hasAny(it)) bad.push(i + 1); });
    if (bad.length) {
      issue(who + " 的 `" + key + "` 第 " + bad.join("、") + " 项是空的" +
        "（`{}` / 空字符串 / 字段全空），共 " + list.length + " 项 —— " +
        "这些位置会画成空壳，本块未绘制；补上内容或者把空项删掉");
      return false;
    }
    // 逐项「至少有一个渲染器认识的字段」：{t,d} 之于 numberList 就是全错 ——
    // 每一项都非空（_hasAny 通过），却没有一个字落在 title/text 上，画出来是一排空行。
    if (known && known.length && typeof list[0] === "object") {
      var blind = [];
      list.forEach(function (it, i) {
        if (!known.some(function (k) { return _hasAny((it || {})[k]); })) blind.push(i + 1);
      });
      if (blind.length) {
        var got0 = Object.keys(list[0] || {});
        issue(who + " 的 `" + key + "` 第 " + blind.join("、") + " 项没有任何一个本区块认识的字段 —— " +
          "它只认 `" + known.join("`、`") + "`，你写的是：" + (got0.length ? got0.join(", ") : "(空对象)") +
          "。这些数据一个字都画不出来，本块未绘制（照 components.md 的键名速查表改）");
        return false;
      }
    }
    // 逐项必需字段：键名写错时渲染器读到 undefined，页面上就会印出字面量 "undefined"
    // （statStrip 写成 {v,k} 而不是 {value,label} 就是这么出的事故），必须在画之前拦住。
    if (need && need.length && typeof list[0] === "object") {
      var miss = [];
      list.forEach(function (it, i) {
        var lack = need.filter(function (k) { return !_hasAny((it || {})[k]); });
        if (lack.length) miss.push("第 " + (i + 1) + " 项缺 `" + lack.join("`/`") + "`");
      });
      if (miss.length) {
        var got = Object.keys(list[0] || {});
        issue(who + " 的 `" + key + "` 每一项必须有 `" + need.join("`、`") + "` —— " +
          miss.join("；") + "。你第 1 项实际写的字段是：" + (got.length ? got.join(", ") : "(空对象)") +
          " —— 键名对不上，本块未绘制（照 components.md 的键名速查表改）");
        return false;
      }
    }
    return true;
  }

  function mustHave(o, key, who) {
    var v = o && o[key];
    // 字符串要 trim：quoteBlock({text:"   "}) 也是缺内容，不能因为「非空」就放行
    var ok = Array.isArray(v) ? v.length > 0
           : (typeof v === "string" ? v.trim() !== "" : !!v);
    if (ok) return true;
    var got = Object.keys(o || {}).filter(function (k) { return k !== "a"; });
    issue(who + " 缺少必需字段 `" + key + "`，本块未绘制" +
      (got.length ? "（收到的是：" + got.join(", ") + " —— 是不是键名写错了？）" : "（未收到任何数据）"));
    return false;
  }

  function A(o, who) {
    var a = o && o.a;
    if (a && typeof a.x === "number" && typeof a.y === "number" && a.w > 0 && a.h > 0) return a;
    console.warn("[pptkit] ⚠ " + who + " 没有拿到有效的区域 a（应传 contentSlide 返回的 a，或 rowsOf/colsOf 切出来的矩形），已退回整块版心");
    return bodyArea({});
  }

  /** 特性卡阵：items=[{icon,title,lines}]，超过 cols 自动换行成网格。 */
  function featureRow(s, o) {
    if (!mustHaveItems(o, "items", "featureRow", null, ["title", "lines"])) return;
    var items = o.items, n = items.length;
    var a = A(o, "featureRow"), cols = Math.min(o.cols || n, n), rn = Math.ceil(n / cols);
    var gx = o.gapX == null ? 0.30 : o.gapX, gy = o.gapY == null ? 0.28 : o.gapY;
    if (cols > 4) console.warn("[pptkit] ⚠ featureRow 一排 " + cols + " 张卡太挤（建议 ≤4），标题会被迫折行：拆成两排或减少卡片");
    var cw = (a.w - gx * (cols - 1)) / cols, avail = (a.h - gy * (rn - 1)) / rn;
    var pad = Math.min(0.28, cw * 0.13, avail * 0.13);   // 窄卡收内边距，把宽度让给文字
    var titleH0 = Math.min(0.46, Math.max(0.36, avail * 0.22));
    var pgap = 4;                                        // 要点之间的段距（紧凑模式会归零）
    // 卡高按内容自适应（避免「内容浮在上面、下面一大片空白」），再整体垂直居中于 a
    var innerW = cw - 2 * pad - 0.34;      // 0.34 = bullet 缩进，必须与体检口径一致，否则差一行
    // 正文字号先定死（取"所有要点都能单行放下"的最大字号，下限 11），卡高再按这个字号算 ——
    // 否则卡按 14pt 算高、体检又把字收到 11pt，卡里就会空出一大截
    var bodyFS = S().body;
    items.forEach(function (it) {
      (it.lines || []).forEach(function (t) { bodyFS = Math.min(bodyFS, fitOne(String(t), innerW, S().body, 11)); });
    });
    var titleOn = items.some(function (i) { return i.title; });
    var useIcon = items.some(function (i) { return i.icon; });
    function measure() {
      var nd = 0;
      items.forEach(function (it) {
        if (!it.lines || !it.lines.length) return;
        var paras = it.lines.map(function (t) { return [{ s: String(t), size: bodyFS, bold: false }]; });
        nd = Math.max(nd, heightAt(paras, 1, innerW * 72, pgap, true) / 72);
      });
      return nd;
    }
    var need = measure();
    // 徽标与标题同一行（圆角方形徽标，不再是"大圆圈占一整行"）——省一行高度，也更像商用版式
    var d = useIcon ? Math.min(0.44, titleH0) : 0;
    var fixed = pad * 2 + (titleOn || useIcon ? titleH0 + 0.14 : 0);
    var wanted = fixed + need + 0.14;
    // 区域装不下 → 切紧凑模式（收内边距/标题高/段距/徽标），把空间全让给正文，避免文字被卡片切掉
    if (wanted > avail) {
      pad = Math.min(pad, 0.15); titleH0 = Math.min(titleH0, 0.34); pgap = 0;
      d = useIcon ? Math.min(0.30, titleH0) : 0;
      innerW = cw - 2 * pad - 0.34;
      need = measure();
      fixed = pad * 2 + (titleOn || useIcon ? titleH0 + 0.08 : 0);
      wanted = fixed + need + 0.08;
    }
    // 卡高：不小于内容所需，也不小于区域的 72%（否则整页显得空），封顶为区域高度
    // 卡高贴合内容（+0.18 呼吸位；给多了内容就会"吊在上半截、下面空一条"）
    var chh = Math.max(Math.min(avail, wanted + 0.18), 0.8);
    var clampedF = wanted + 0.18 > avail;   // 区域装不下 → 放开字号下限交给体检收
    var thGap = pgap ? 0.14 : 0.08;
    var contentH = (titleOn || useIcon ? titleH0 + thGap : 0) + need;
    var yOff = a.y + Math.max(0, (a.h - (rn * chh + (rn - 1) * gy)) / 2);
    items.forEach(function (it, i) {
      var cx = a.x + (i % cols) * (cw + gx), cy0 = yOff + Math.floor(i / cols) * (chh + gy);
      // hero:true 的卡用品牌色填充 + 反白文字，作为整排的视觉锚点（商用 deck 的常见手法）
      var hero = !!it.hero, ink = hero ? C.text_on_dark : C.text_on_light;
      card(s, { x: cx, y: cy0, w: cw, h: chh },
        { fill: hero ? C.primary : o.fill, border: hero ? C.primary : o.border, shadow: hero ? 0.16 : null });
      // 内容在卡内垂直居中，卡再高也不会「内容贴顶、下面一大片空」
      var y = cy0 + Math.max(pad, (chh - contentH) / 2);
      var tx = cx + pad, tw = cw - 2 * pad;
      if (useIcon && it.icon) {   // 圆角方形徽标 + 同行标题
        s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: y + (titleH0 - d) / 2, w: d, h: d, rectRadius: 0.09,
          fill: { color: hero ? C.text_on_dark : C.primary } });
        s.addText(String(it.icon), { x: tx, y: y + (titleH0 - d) / 2, w: d, h: d, align: "center", valign: "middle",
          fontFace: F.title, fontSize: Math.round(d * 34), bold: true, color: hero ? C.primary : C.text_on_dark, margin: 0 });
        tx += d + 0.16; tw -= d + 0.16;
      }
      if (it.title) {
        // 卡标题字号不得低于正文（否则出现"标题比正文还小"的倒挂）
        s.addText(String(it.title), { x: tx, y: y, w: tw, h: titleH0, valign: "middle",
          align: o.center ? "center" : "left", fontFace: F.title, fontSize: S().cardTitle, bold: true,
          color: ink, margin: 0, minFontSize: Math.min(S().cardTitle, bodyFS + 2) });
      }
      if (titleOn || useIcon) y += titleH0 + thGap;
      // 压紧时把卡片底部余量也让给正文（只留 0.03" 呼吸位），并收紧行距 ——
      // 先榨干空间，再谈少画内容，顺序不能反
      var rest = clampedF ? (cy0 + chh - y - pad * 0.5)
                          : Math.min(need + 0.06, cy0 + chh - pad - y);
      var lines = it.lines || [];
      // 区域被压到连最小字号都放不下时，pptxgenjs 不会裁剪——文字会直接溢到卡片外面，
      // 渲染出来就是"半行字挂在卡下沿"。宁可少放一条并明确告警，也不能让稿子看着是坏的。
      if (lines.length && rest > 0.24) {
        var innerPt = (cw - 2 * pad - 0.34) * 72;
        var fitN = lines.length;
        while (fitN > 1) {
          var ps = lines.slice(0, fitN).map(function (x) { return [{ s: String(x), size: MIN_SIZE, bold: false }]; });
          if (heightAt(ps, 1, innerPt, pgap, !clampedF) / 72 <= rest) break;
          fitN--;
        }
        if (fitN < lines.length) {
          console.warn("[pptkit] ⚠ 卡片「" + clip(it.title || lines[0], 12) + "」放不下 " + lines.length +
            " 条要点，只画了前 " + fitN + " 条 —— 这一页塞太满了，请减内容或拆页（少画的：" +
            lines.slice(fitN).map(function (x) { return clip(x, 10); }).join("、") + "）");
          lines = lines.slice(0, fitN);
        }
        // 框收到"实际画得下的高度"，别留一截空框——空框会和页脚/下一个块判定成压盖
        var realPs = lines.map(function (x) { return [{ s: String(x), size: bodyFS, bold: false }]; });
        rest = Math.min(rest, heightAt(realPs, 1, innerPt, pgap, !clampedF) / 72 + 0.04);
        s.addText(bullets(lines), { x: cx + pad, y: y, w: cw - 2 * pad, h: rest,
          fontFace: F.body, fontSize: bodyFS, minFontSize: clampedF ? 0 : Math.max(10, bodyFS - 1),
          color: ink, lineSpacingMultiple: clampedF ? 1.0 : LOOSE, paraSpaceAfter: pgap,
          valign: "top", margin: 0 });
      }
    });
  }

  /** KPI 大数字排：items=[{value,label}]。同排字号自动统一。 */
  function statRow(s, o) {
    if (!mustHaveItems(o, "items", "statRow", ["value"], ["value", "label"])) return;
    var items = o.items, n = items.length;
    var a = A(o, "statRow"), gap = o.gap == null ? 0.30 : o.gap;
    // KPI 瓦片：大数字必须是全页最抢眼的元素（商用 deck 的"钩子"），所以数字独占 58% 卡高
    // 瓦片高度 1.55"：既要上下内边距对称，又要给大数字留下 40pt 的高度（矮了数字就被体检收小，白瞎了 KPI）
    var w = (a.w - gap * (n - 1)) / n, h = Math.min(a.h, o.h || (WIDE() ? 1.88 : 1.64));
    var ay = a.y + (a.h - h) / 2;
    var al = o.align || "left", cx = al === "center";
    items.forEach(function (it, i) {
      var x = a.x + i * (w + gap);
      if (o.plain !== true) card(s, { x: x, y: ay, w: w, h: h }, { fill: o.fill, rail: cx ? null : (o.rail !== false) });
      // 上下内边距对称（各 0.12h）：之前上 27px / 下 11px，标签几乎顶着卡的下边线
      var px = cx ? 0.18 : 0.30;
      s.addText(String(it.value), { x: x + px, y: ay + h * 0.09, w: w - 2 * px, h: h * 0.51, valign: "middle",
        align: al, fontFace: F.title, fontSize: S().kpi, bold: true, color: o.color || C.primary, margin: 0 });
      // 数字下的短横线：把"数字"和"标签"分成两个层级，比单纯堆文字有设计感
      s.addShape(pres.shapes.RECTANGLE, { x: cx ? x + w / 2 - 0.16 : x + px, y: ay + h * 0.645, w: 0.32, h: 0.028,
        fill: { color: C.accent || C.primary } });
      s.addText(String(it.label || ""), { x: x + px, y: ay + h * 0.705, w: w - 2 * px, h: h * 0.205, valign: "top",
        align: al, fontFace: F.body, fontSize: S().cap + 1, color: C.text_muted, margin: 0 });
    });
  }

  /** 水平时间线：steps=[{t,d}] */
  function timelineRow(s, o) {
    if (!mustHaveItems(o, "steps", "timelineRow", ["t"], ["t", "d"])) return;
    var st = o.steps, n = st.length;
    var a = A(o, "timelineRow"), seg = a.w / n;
    if (n > 5) console.warn("[pptkit] ⚠ timelineRow 有 " + n + " 个节点（建议 3–5 个），每格只有 " + seg.toFixed(2) + "\"，说明文字会被压小");
    var used = 0.42 + 0.22 + 0.38 + (st.some(function (p) { return p.d; }) ? 0.46 : 0);
    var ly = a.y + Math.max(Math.min(0.42, a.h * 0.22), (a.h - used) / 2 + 0.20);   // 整体垂直居中，别贴顶留大洞
    s.addShape(pres.shapes.LINE, { x: a.x + seg * 0.5, y: ly, w: a.w - seg, h: 0, line: { color: C.card_border, width: 2 } });
    st.forEach(function (p, i) {
      var cx = a.x + seg * i + seg / 2;
      s.addShape(pres.shapes.OVAL, { x: cx - 0.12, y: ly - 0.12, w: 0.24, h: 0.24, fill: { color: C.primary } });
      s.addText(String(p.t), { x: cx - seg / 2 + 0.08, y: ly + 0.22, w: seg - 0.16, h: 0.38, align: "center",
        fontFace: F.title, fontSize: S().cardTitle - 2, bold: true, color: C.text_on_light, margin: 0 });
      if (p.d) s.addText(String(p.d), { x: cx - seg / 2 + 0.08, y: ly + 0.64, w: seg - 0.16, h: a.y + a.h - (ly + 0.64),
        align: "center", fontFace: F.body, fontSize: S().cap, color: C.text_muted, margin: 0, valign: "top" });
    });
  }

  /** 流程箭头：steps=[{t,d}]，3–5 步 */
  function processRow(s, o) {
    if (!mustHaveItems(o, "steps", "processRow", ["t"], ["t", "d"])) return;
    var st = o.steps, n = st.length;
    var a = A(o, "processRow"), gap = 0.12, w = (a.w - (n - 1) * gap) / n;
    var hasD = st.some(function (p) { return p.d; });
    var h = Math.min(a.h * (hasD ? 0.62 : 0.9), 1.35), dh = hasD ? 0.46 : 0;
    var y0 = a.y + Math.max(0, (a.h - (h + (hasD ? dh + 0.08 : 0))) / 2);   // 垂直居中
    st.forEach(function (p, i) {
      var x = a.x + i * (w + gap);
      // 透明度封顶 32：再浅白字对比度就不够了
      s.addShape(pres.shapes.CHEVRON, { x: x, y: y0, w: w, h: h, fill: { color: C.primary, transparency: Math.min(32, i * 9) } });
      s.addText(String(p.t), { x: x + w * 0.10, y: y0, w: w * 0.80, h: h, align: "center", valign: "middle",
        fontFace: F.title, fontSize: S().cardTitle - 3, bold: true, color: C.text_on_dark, margin: 0 });
      if (p.d) s.addText(String(p.d), { x: x, y: y0 + h + 0.08, w: w, h: dh,
        align: "center", valign: "top", fontFace: F.body, fontSize: S().cap, color: C.text_muted, margin: 0, minFontSize: 10 });
    });
  }

  /** 对比：left/right = {title, lines} */
  function compareRow(s, o) {
    var _cl = !!(o.left && _hasAny(o.left.lines)), _cr = !!(o.right && _hasAny(o.right.lines));
    if (!_cl || !_cr) {
      issue("compareRow 要求 `left` 和 `right` 两侧都给 lines，现在" +
        (!_cl && !_cr ? "两侧都没给" : (!_cl ? "左侧 `left.lines` 是空的" : "右侧 `right.lines` 是空的")) +
        " —— 只画半边等于半页空白，本块未绘制"); return;
    }
    var a = A(o, "compareRow"), gap = 0.85, w = (a.w - gap) / 2, hd = Math.min(0.52, a.h * 0.16);
    var cpad = 0.26, cgap = 6, cFS = S().body;
    [o.left, o.right].forEach(function (side) {
      (side && side.lines || []).forEach(function (t) {
        cFS = Math.min(cFS, fitOne(String(t), w - 2 * cpad - 0.34, S().body, 11));
      });
    });
    function needComp() {
      var nd = 0;
      [o.left, o.right].forEach(function (side) {
        if (!side || !side.lines) return;
        var paras = side.lines.map(function (t) { return [{ s: String(t), size: cFS, bold: false }]; });
        nd = Math.max(nd, heightAt(paras, 1, (w - 2 * cpad - 0.34) * 72, cgap, true) / 72);
      });
      return nd;
    }
    var needC = needComp();
    if (hd + needC + 0.5 > a.h) { cpad = 0.16; cgap = 0; hd = Math.min(hd, 0.42); needC = needComp(); }  // 紧凑模式
    var cClamped = hd + needC + 0.34 > a.h;
    var ch2 = Math.max(Math.min(a.h, hd + needC + 0.4), a.h * 0.74);   // 卡高贴合内容，不留大片空白
    var ay = a.y + (a.h - ch2) / 2;
    // 语义配色：左=现状/劣势，右=目标态/优势用品牌主色（强调色永远给要主推的那一侧）。
    // ⚠️ 次要那一侧**必须"浅底 + 深字"**——之前用中间调灰底压白字，对比度只有 2.4:1，投屏根本看不清。
    [[o.left, a.x, tint(C.text_on_light, 0.86), C.text_on_light],
     [o.right, a.x + w + gap, C.primary, C.text_on_dark]].forEach(function (p) {
      var side = p[0] || {}, x = p[1], acc = p[2], hink = p[3];
      card(s, { x: x, y: ay, w: w, h: ch2 }, { radius: 0 });
      s.addShape(pres.shapes.RECTANGLE, { x: x, y: ay, w: w, h: hd, fill: { color: acc } });
      s.addText(String(side.title || ""), { x: x + 0.15, y: ay, w: w - 0.3, h: hd, align: "center", valign: "middle",
        fontFace: F.title, fontSize: S().cardTitle - 2, bold: true, color: hink, margin: 0 });
      s.addText(bullets(side.lines || []), { x: x + cpad, y: ay + hd + 0.12, w: w - 2 * cpad, h: ch2 - hd - 0.24,
        fontFace: F.body, fontSize: cFS, minFontSize: cClamped ? 0 : Math.max(10, cFS - 1),
        color: C.text_on_light, lineSpacingMultiple: LOOSE, paraSpaceAfter: cgap, valign: "middle", margin: 0 });
    });
    var d = Math.min(0.72, ch2 * 0.22), cx = a.x + w + gap / 2 - d / 2, cy = ay + ch2 / 2 - d / 2;
    // VS 徽章用主色而不是 accent：accent 常常是浅色/金色，压白字对比度不够
    s.addShape(pres.shapes.OVAL, { x: cx, y: cy, w: d, h: d, fill: { color: C.primary }, shadow: shadow(0.15) });
    s.addText("VS", { x: cx, y: cy, w: d, h: d, align: "center", valign: "middle",
      fontFace: F.title, fontSize: 15, bold: true, color: C.text_on_dark, margin: 0 });
  }

  /** 排行条（纯形状，永不失败）：items=[{name,v,label}]。行距/标签宽自动算，绝不重叠。 */
  function barsBlock(s, o) {
    if (!mustHaveItems(o, "items", "barsBlock", ["name"], ["name", "v", "label"])) return;
    var items = o.items, n = items.length;
    var a = A(o, "barsBlock"), y0 = a.y, hh = a.h, titleH = o.title ? 0.46 : 0;
    hh = a.h - titleH;
    // 区域矮到一条只剩 <0.24"（字会被压成 8pt）→ **自动分两栏**，行数减半就重新装得下。
    // 比"压扁到看不清"或"挤出区域压别的元素"都好，而且一条数据都不丢。
    if (!o._sub && n >= 4 && (hh - 0.05 * (n - 1)) / n < 0.24) {
      var halfN = Math.ceil(n / 2), cc = colsOf(a, 2, 0.5);
      if (o.title) {
        s.addText(String(o.title), { x: a.x, y: a.y, w: a.w, h: 0.36,
          fontFace: F.title, fontSize: S().cardTitle - 2, bold: true, color: C.primary, margin: 0 });
        cc = colsOf({ x: a.x, y: a.y + titleH, w: a.w, h: a.h - titleH }, 2, 0.5);
      }
      barsBlock(s, { a: cc[0], items: items.slice(0, halfN), _sub: 1 });
      barsBlock(s, { a: cc[1], items: items.slice(halfN), _sub: 1 });
      return;
    }
    // 行高先定，再由行高反推字号（而不是让体检去砍），这样不会出现「莫名其妙的小字」。
    // 行高有硬下限 0.24"：低于这个值文字必然被压成看不清/溢出框，宁可让整块超出区域也不能压扁。
    // 行高有理想下限 0.24"（低于它文字必然看不清）；但**绝不能挤出区域去压别的元素**，
    // 所以区域实在不够时压到刚好填满区域并报警——「小而不越界」优于「清晰但压别人」。
    var fitRow = n > 1 ? (hh - 0.05 * (n - 1)) / n : hh;
    var _rh0 = fitRow >= 0.24 ? Math.min(0.56, Math.max(0.24, hh / n * 0.78)) : fitRow;
    var nameFS = Math.max(8, Math.min(S().cap + 1, Math.floor(_rh0 * 72 / 1.34)));
    if (fitRow < 0.24)
      console.warn("[pptkit] ⚠ barsBlock 区域装不下 " + n + " 条（只有 " + hh.toFixed(2) + "\"，至少需要 " +
        (n * 0.24 + (n - 1) * 0.05).toFixed(2) + "\"）：字号已被压到 " + nameFS + "pt，请调大区域或减少条目");
    var valFS = nameFS;
    var nameW = 0, valW = 0;
    items.forEach(function (it) {
      nameW = Math.max(nameW, textEm(String(it.name), false) * nameFS / 72);
      valW = Math.max(valW, textEm(String(it.label != null ? it.label : it.v), true) * valFS / 72);
    });
    nameW = Math.min(a.w * 0.32, nameW + 0.16); valW = Math.min(a.w * 0.26, valW + 0.16);
    // 行距封顶 0.34：区域很高时不要把 5 根条摊开成"稀疏梯子"，而是抱团后整体垂直居中
    var rowH = _rh0, gap = n > 1 ? Math.min(0.34, (hh - n * rowH) / (n - 1)) : 0;
    if (gap < 0.05) gap = 0.05;
    // 标题和条形是一个整体，一起垂直居中（否则标题贴顶、条形居中，中间空一大条）
    var blockH = titleH + n * rowH + (n - 1) * gap;
    var topY = a.y + Math.max(0, (a.h - blockH) / 2);
    if (o.title) s.addText(String(o.title), { x: a.x, y: topY, w: a.w, h: 0.36,
      fontFace: F.title, fontSize: S().cardTitle - 2, bold: true, color: C.primary, margin: 0 });
    y0 = topY + titleH;
    var barW = a.w - nameW - valW - 0.24;
    // 量程留 8% 余量：否则第一条永远铺满整条轨道，看起来像 100%，读者会误读
    var max = (Math.max.apply(null, items.map(function (i) { return Number(i.v) || 0; })) || 1) / 0.92;
    items.forEach(function (it, i) {
      var y = y0 + i * (rowH + gap), bx = a.x + nameW + 0.12;
      s.addText(String(it.name), { x: a.x, y: y, w: nameW - 0.06, h: rowH, valign: "middle",
        fontFace: F.body, fontSize: nameFS, color: C.text_on_light, margin: 0 });
      s.addShape(pres.shapes.RECTANGLE, { x: bx, y: y + rowH * 0.16, w: barW, h: rowH * 0.68, fill: { color: C.card_border } });
      s.addShape(pres.shapes.RECTANGLE, { x: bx, y: y + rowH * 0.16, w: Math.max(0.06, barW * (Number(it.v) || 0) / max), h: rowH * 0.68,
        fill: { color: i === 0 ? C.primary : C.secondary } });
      s.addText(String(it.label != null ? it.label : it.v), { x: bx + barW + 0.12, y: y, w: valW, h: rowH, valign: "middle",
        fontFace: F.title, fontSize: valFS, bold: true, color: C.primary, margin: 0 });
    });
  }

  /** 原生图表（去丑配置已配齐）：type 用 K.charts.BAR / LINE / PIE … */
  function chartBlock(s, o) {
    if (!mustHave(o, "data", "chartBlock")) return;
    var a = A(o, "chartBlock"), y = a.y, h = a.h;
    if (o.title) {
      s.addText(String(o.title), { x: a.x, y: a.y, w: a.w, h: 0.36, fontFace: F.title, fontSize: S().cardTitle - 2, bold: true, color: C.primary, margin: 0 });
      y = a.y + 0.46; h = a.h - 0.46;
    }
    var uo = o.opts || {};
    // 饼图/环图用 showPercent 时，标签是 0~1 的小数，必须用百分比格式，否则显示成 0.45
    if (uo.showPercent) { uo = Object.assign({ dataLabelFormatCode: "0%", showValue: false, dataLabelPosition: "ctr" }, uo); }
    // 多系列必须有图例，否则读者不知道哪根柱是哪个系列（这是硬伤，不能靠模型记得传）
    var multi = Array.isArray(o.data) && o.data.length > 1;
    // 饼图只有 1 个分类会渲染成一个"100% 的整圆"，是常见的数据组装错误
    if (uo.showPercent && Array.isArray(o.data) && o.data[0] && (o.data[0].values || []).length < 2)
      console.warn("[pptkit] ⚠ 饼图只有 1 个分类，会渲染成 100% 的整圆：请给 labels/values 至少 2 项，或改用 statRow");
    if (multi && uo.showLegend == null) uo = Object.assign({ showLegend: true, legendPos: "b" }, uo);
    // ⚠️ pptxgenjs 陷阱：单系列柱状图 + chartColors.length>1 时会给"每根柱一个颜色"（<c:dPt>），
    // 同一个指标被涂成一堆无关的色块。单系列必须自己给逐点配色：统一淡色 + 最大值高亮。
    if (!multi && uo.chartColors == null && Array.isArray(o.data) && o.data[0] && Array.isArray(o.data[0].values)) {
      var vals = o.data[0].values.map(function (v) { return Number(v) || 0; });
      var mx = Math.max.apply(null, vals), soft = tint(C.primary, 0.55);
      uo = Object.assign({ chartColors: vals.map(function (v) { return v === mx ? C.primary : soft; }) }, uo);
    }
    // 饼图的直径由区域**高度**决定：区域又扁又宽时饼会小得看不清、标签还会叠在一起。
    var isPie = uo.showPercent || o.type === pres.charts.PIE || o.type === pres.charts.DOUGHNUT;
    var cx0 = a.x, cw0 = a.w;
    if (isPie) {
      cw0 = Math.min(a.w, h * 2.6); cx0 = a.x + (a.w - cw0) / 2;
      if (h < 1.9) console.warn("[pptkit] ⚠ 饼图区域只有 " + h.toFixed(2) + "\" 高，饼会很小、标签会重叠：" +
        "请用 page.split 把饼图放到半页（高度足够），或改用 barsBlock 展示占比");
    }
    s.addChart(o.type || pres.charts.BAR, o.data, Object.assign({
      x: cx0, y: y, w: cw0, h: h,
      chartColors: chartPalette(),
      // 不给图表画白底框：商用 deck 里图表是"直接长在页面上"的，加个白盒子会显得廉价
      chartArea: { fill: { color: C.bg_light || "FFFFFF" }, border: { pt: 0, color: C.bg_light || "FFFFFF" } },
      plotArea: { fill: { color: C.bg_light || "FFFFFF" } },
      catAxisLabelColor: C.text_muted, valAxisLabelColor: C.text_muted,
      catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
      valGridLine: { color: C.card_border, size: 0.5 }, catGridLine: { style: "none" },
      dataLabelColor: C.text_on_light, dataLabelFontSize: 10,
      showLegend: false, showValue: true, dataLabelPosition: "outEnd", barGapWidthPct: 45,
      varyColors: false,                    // 单系列时 pptxgenjs 默认每根柱一个色，很花
      dataLabelFormatCode: "0.##",          // 默认 General 会把 2.1 显示成 2
    }, uo));
  }

  // 图片必须是**已下载到本地**的文件。路径不存在时 pptxgenjs 会直接抛错炸掉整份稿，
  // 这里换成"画占位块 + 明确告警"，让其余页面照常产出（模型忘记下载是高频错误）。
  function photo(s, r, path, opt) {
    opt = opt || {};
    var okFile = false;
    try { okFile = !!path && require("fs").existsSync(path); } catch (e) { okFile = !!path; }
    if (!okFile) {
      issue("图片不存在：" + (path || "(未给 img)") +
        " —— 联网搜到的图必须先下载到本地再引用。两条路二选一：把图下下来，" +
        "或者把这个图片区块删掉改用纯文字版式（技能里写了「没有合适的图就不放图」）；" +
        "不能就这么交付一个「图片缺失」灰块");
      s.addShape(pres.shapes.RECTANGLE, { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: tint(C.text_muted, 0.82) } });
      s.addText("图片缺失", { x: r.x, y: r.y, w: r.w, h: Math.min(r.h, 0.5), align: "center", valign: "middle",
        fontFace: F.body, fontSize: 12, color: C.text_muted, margin: 0 });
      return false;
    }
    s.addImage(Object.assign({ path: path, x: r.x, y: r.y, w: r.w, h: r.h,
      sizing: { type: "cover", w: r.w, h: r.h } }, opt));
    return true;
  }

  // 照片上放字必须给"局部加深带"：整幅统一遮罩挡不住亮天空，白字照样糊。
  // pptxgenjs 没有渐变填充，用 3 层递增透明度的色块伪造一条自下而上的渐变。
  function scrimBand(s, x, y, w, h, dir) {
    // i=0 永远是**贴着锚定边**的那一条，必须最不透明；越往画面中间越淡，最后一条 100=全透明，
    // 这样带子的内沿才能和没压暗的区域无缝接上。写反了的话最深的一条落在内沿，会切出一条横向硬边。
    var n = 10, dark = 30, clear = 100;             // 层数少了会看出横向色阶，10 层肉眼就分不出了
    for (var i = 0; i < n; i++) {
      var bh = h / n, by = dir === "top" ? y + i * bh : y + h - (i + 1) * bh;
      var k = i / (n - 1);                          // 平方缓动：贴边一段深得稳，收尾收得快，更像真渐变
      s.addShape(pres.shapes.RECTANGLE, decor({ x: x, y: by, w: w, h: bh,   // 不留重叠：相邻半透明块叠加会显出横向接缝
        fill: { color: "000000", transparency: Math.round(dark + (clear - dark) * k * k) } }));
    }
  }

  /** 照片墙：items=[{img, caption}]，等分网格、cover 裁切、说明压在图片下缘 */
  function photoGrid(s, o) {
    if (!mustHaveItems(o, "items", "photoGrid", null, ["img", "caption"])) return;
    var a = A(o, "photoGrid"), items = o.items, n = items.length;
    var cols = Math.min(o.cols || (n <= 2 ? n : (n <= 4 ? 2 : 3)), n), rn = Math.ceil(n / cols);
    var gx = 0.20, gy = 0.20, cw = (a.w - gx * (cols - 1)) / cols, ch = (a.h - gy * (rn - 1)) / rn;
    items.forEach(function (it, i) {
      var x = a.x + (i % cols) * (cw + gx), y = a.y + Math.floor(i / cols) * (ch + gy);
      photo(s, { x: x, y: y, w: cw, h: ch }, it.img);
      if (it.caption) {   // 半透明色带压在图下缘，不遮主体
        var bh = Math.min(0.44, ch * 0.28);
        s.addShape(pres.shapes.RECTANGLE, { x: x, y: y + ch - bh, w: cw, h: bh,
          fill: { color: "000000", transparency: 42 } });
        s.addText(String(it.caption), { x: x + 0.12, y: y + ch - bh, w: cw - 0.24, h: bh, valign: "middle",
          fontFace: F.body, fontSize: S().cap + 1, color: "FFFFFF", margin: 0, minFontSize: 9 });
      }
    });
  }

  /** 左图右文（图必须是已下载到本地的文件） */
  function imageBlock(s, o) {
    if (!mustHave(o, "img", "imageBlock")) return;
    var a = A(o, "imageBlock"), iw = o.imgW || a.w * 0.46;
    // 左右布局会把图压成竖条（宽高比 <0.9 就很难看）→ 自动改成"上图下文"
    var stacked = (iw / a.h) < 0.9;
    var ix, iy, ih, tx, ty, tw, th;
    if (stacked) {
      ih = Math.min(a.h * 0.52, a.w * 0.42); ix = a.x; iy = a.y; iw = a.w;
      tx = a.x; ty = a.y + ih + 0.22; tw = a.w; th = a.y + a.h - ty;
    } else {
      var left = o.side !== "right";
      ix = left ? a.x : a.x + a.w - iw; iy = a.y; ih = a.h;
      tx = left ? a.x + iw + 0.38 : a.x; ty = a.y; tw = a.w - iw - 0.38; th = a.h;
    }
    photo(s, { x: ix, y: iy, w: iw, h: ih }, o.img);
    if (o.caption) {
      scrimBand(s, ix, iy + ih - 0.46, iw, 0.46);
      s.addText(String(o.caption), { x: ix + 0.10, y: iy + ih - 0.42, w: iw - 0.20, h: 0.36,
        valign: "middle", fontFace: F.body, fontSize: S().cap, color: "FFFFFF", margin: 0, minFontSize: 9 });
    }
    var y = ty + 0.06;
    if (o.title) { s.addText(String(o.title), { x: tx, y: y, w: tw, h: 0.5, valign: "middle", fontFace: F.title, fontSize: S().cardTitle + 2, bold: true, color: C.text_on_light, margin: 0 }); y += 0.62; }
    if (o.lines && o.lines.length) s.addText(bullets(o.lines), { x: tx, y: y, w: tw, h: ty + th - y,
      fontFace: F.body, fontSize: S().body, color: C.text_on_light, lineSpacingMultiple: LOOSE, paraSpaceAfter: 8, valign: "top", margin: 0 });
  }

  /** 金句 / 结论块 */
  function quoteBlock(s, o) {
    // 整块垂直居中于 a，引号在正文左上方，绝不探到 a 之外（不会顶到页眉）
    if (!mustHave(o, "text", "quoteBlock")) return;
    var a = A(o, "quoteBlock"), mkH = Math.min(0.72, a.h * 0.20), byH = o.by ? 0.42 : 0;
    var qfs = WIDE() ? 26 : 22;
    // 正文框按实际所需高度算，别给一个大框让文字浮在中间（引号和引文会被拉开一条空带）
    var txtH = Math.min(a.h - mkH - byH - 0.20,
      heightAt([[{ s: String(o.text || ""), size: qfs, bold: false }]], 1, (a.w - 0.20) * 72, 0) / 72 + 0.14);
    var top = a.y + (a.h - (mkH + txtH + byH + 0.20)) / 2;
    s.addText("“", { x: a.x, y: top, w: 1.2, h: mkH, fontFace: "Georgia", fontSize: Math.round(mkH * 105),
      bold: true, color: C.primary, margin: 0, valign: "middle", autofit: false });
    s.addText(String(o.text || ""), { x: a.x + 0.10, y: top + mkH + 0.02, w: a.w - 0.20, h: txtH,
      fontFace: F.title, fontSize: qfs, italic: true, color: C.text_on_light, margin: 0, valign: "middle" });
    if (o.by) s.addText("— " + o.by, { x: a.x + 0.10, y: top + mkH + txtH + 0.14, w: a.w - 0.20, h: byH,
      fontFace: F.body, fontSize: S().cap + 2, color: C.text_muted, margin: 0 });
  }

  /** 带标题的要点卡（简单内容块） */
  function bulletBlock(s, o) {
    if (!mustHaveItems(o, "lines", "bulletBlock")) return;
    var a = A(o, "bulletBlock"), pad = Math.min(0.26, a.h * 0.14), bgap = 4;
    var th = o.title ? Math.min(0.42, a.h * 0.24) : 0;
    // 卡高贴合内容并在区域内垂直居中（否则一张矮内容的卡会撑满区域、底下空一大截）
    var lineFS = S().body, innerW = a.w - 2 * pad - 0.34;
    (o.lines || []).forEach(function (t) { lineFS = Math.min(lineFS, fitOne(String(t), innerW, S().body, 11)); });
    function needOf() {
      return (o.lines || []).length
        ? heightAt(o.lines.map(function (t) { return [{ s: String(t), size: lineFS, bold: false }]; }), 1, innerW * 72, bgap, true) / 72
        : 0;
    }
    var needB = needOf();
    var wantH = pad * 2 + (th ? th + 0.08 : 0) + needB + 0.12;
    if (wantH > a.h) {                  // 紧凑模式：收内边距/标题高/段距，把空间让给正文
      pad = Math.min(pad, 0.15); th = th ? Math.min(th, 0.34) : 0; bgap = 0;
      innerW = a.w - 2 * pad - 0.34; needB = needOf();
      wantH = pad * 2 + (th ? th + 0.06 : 0) + needB + 0.08;
    }
    var clamped = wantH > a.h;          // 仍装不下 → 放开字号下限，让体检去收，否则一定溢出
    // fill:true（分栏页用）→ 卡片吃满整个区域，内容在卡内垂直居中，避免"左右两栏各缩一小块、上下大片空"
    var ch3 = o.fill ? a.h : Math.min(a.h, wantH);
    var ay3 = a.y + (a.h - ch3) / 2;
    var innerPad = o.fill ? Math.max(pad, (ch3 - (wantH - 2 * pad)) / 2) : pad;
    if (o.card !== false) card(s, { x: a.x, y: ay3, w: a.w, h: ch3 }, {});
    var y = ay3 + innerPad;
    if (o.title) {
      s.addText(String(o.title), { x: a.x + pad, y: y, w: a.w - 2 * pad, h: th, valign: "middle",
        fontFace: F.title, fontSize: S().cardTitle, bold: true, color: C.text_on_light, margin: 0 });
      y += th + 0.08;
    }
    // 条目短而多时自动分两列：否则一条 6 个字的要点摊在 9" 宽的卡里，只填满 27% 宽度，"填空感"很重
    var lines = o.lines || [], boxW = a.w - 2 * pad, boxH = ay3 + ch3 - pad - y;
    var maxEm = 0;
    lines.forEach(function (t) { maxEm = Math.max(maxEm, textEm(String(t), false)); });
    var twoColB = o.cols === 2 || (o.cols !== 1 && lines.length >= 4 && maxEm * lineFS / 72 < boxW * 0.42);
    if (twoColB) {
      var half = Math.ceil(lines.length / 2), cgapB = 0.30, cwB = (boxW - cgapB) / 2;
      [lines.slice(0, half), lines.slice(half)].forEach(function (part, i) {
        if (!part.length) return;
        s.addText(bullets(part), { x: a.x + pad + i * (cwB + cgapB), y: y, w: cwB, h: boxH,
          fontFace: F.body, fontSize: lineFS, minFontSize: clamped ? 0 : Math.max(10, lineFS - 1),
          color: C.text_on_light, lineSpacingMultiple: LOOSE, paraSpaceAfter: bgap, valign: "top", margin: 0 });
      });
    } else {
      s.addText(bullets(lines), { x: a.x + pad, y: y, w: boxW, h: boxH,
        fontFace: F.body, fontSize: lineFS, minFontSize: clamped ? 0 : Math.max(10, lineFS - 1),
        color: C.text_on_light, lineSpacingMultiple: LOOSE, paraSpaceAfter: bgap, valign: "top", margin: 0 });
    }
  }

  /** 表格：head=[列名…]，rows=[[单元格…]…]，widths=[比例…]。商用稿里信息密度最高的块。 */
  function tableBlock(s, o) {
    var a = A(o, "tableBlock"), head = o.head || [], rows = o.rows || [], n = rows.length;
    if (!_hasAny(head) && !_hasAny(rows)) {
      issue("tableBlock 的 `head` / `rows` 里没有任何实际内容" +
        "（字段没给，或者给的是空数组／全空字符串），本块未绘制"); return;
    }
    var cols = head.length || (rows[0] || []).length;
    // cols 算不出来时原来是静默 return —— 又一条"什么都不画还不吭声"的路
    if (!cols) { issue("tableBlock 算不出列数：`head` 是空数组、`rows[0]` 也是空数组，本块未绘制"); return; }
    var wts = o.widths && o.widths.length === cols ? o.widths : null;
    var sum = wts ? wts.reduce(function (x, y) { return x + y; }, 0) : cols;
    var hh = Math.min(0.46, a.h / (n + 1));      // 绝不超出给定区域（原来有 0.28 下限，行多时会撑出去压别的块）
    var totalH = hh * (n + 1);
    if (hh < 0.26) console.warn("[pptkit] ⚠ tableBlock 区域装不下 " + n + " 行（每行只有 " +
      hh.toFixed(2) + "\"）：字会很小，请减少行数或给它更高的区域");
    var ay = a.y + Math.max(0, (a.h - totalH) / 2);
    var fs = Math.max(9, Math.min(S().body, Math.floor(hh * 72 / 1.55)));
    function colX(i) { var x = a.x, k = 0; for (; k < i; k++) x += a.w * (wts ? wts[k] : 1) / sum; return x; }
    function colW(i) { return a.w * (wts ? wts[i] : 1) / sum; }
    s.addShape(pres.shapes.RECTANGLE, { x: a.x, y: ay, w: a.w, h: hh, fill: { color: C.primary } });
    head.forEach(function (t, i) {
      s.addText(String(t), { x: colX(i) + 0.12, y: ay, w: colW(i) - 0.24, h: hh, valign: "middle",
        align: i === 0 ? "left" : (o.align || "right"), fontFace: F.title, fontSize: fs, bold: true,
        color: C.text_on_dark, margin: 0, minFontSize: 9 });   // 表头允许自己收小，宁可小一号也不能溢出表头带
    });
    rows.forEach(function (r, j) {
      var y = ay + hh * (j + 1);
      if (j % 2 === 1) s.addShape(pres.shapes.RECTANGLE, { x: a.x, y: y, w: a.w, h: hh, fill: { color: tint(C.primary, 0.95) } });
      s.addShape(pres.shapes.RECTANGLE, { x: a.x, y: y + hh - 0.008, w: a.w, h: 0.008, fill: { color: C.card_border } });
      (r || []).forEach(function (t, i) {
        var strong = (i === 0) || (o.strongCol != null && i === o.strongCol);
        s.addText(String(t), { x: colX(i) + 0.12, y: y, w: colW(i) - 0.24, h: hh, valign: "middle",
          align: i === 0 ? "left" : (o.align || "right"), fontFace: strong ? F.title : F.body, fontSize: fs,
          bold: strong, color: TONE(autoTone(t)) || (strong ? C.text_on_light : C.text_muted), margin: 0, minFontSize: 9 });
      });
    });
  }

  /** 紧凑 KPI 条：一行放 3–6 个数字，用细竖线分隔，不占卡片高度（密度比 statRow 高得多） */
  function statStrip(s, o) {
    if (!mustHaveItems(o, "items", "statStrip", ["value"], ["value", "label"])) return;
    var a = A(o, "statStrip"), items = o.items, n = items.length;
    // 超过 4 个自动折成两行：列一窄，标签必然折行并被压成小字（实测这是 statStrip 唯一的失败模式）
    if (!o._sub && n > 4) {
      var half = Math.ceil(n / 2), rr = rowsOf(a, 2, 0.16);
      statStrip(s, { a: rr[0], items: items.slice(0, half), _sub: 1, card: o.card });
      statStrip(s, { a: rr[1], items: items.slice(half), _sub: 1, card: o.card });
      return;
    }
    var hh = Math.min(a.h, 1.32), ay = a.y + (a.h - hh) / 2, w = a.w / n;
    if (o.card !== false) card(s, { x: a.x, y: ay, w: a.w, h: hh }, {});
    items.forEach(function (it, i) {
      var x = a.x + i * w;
      if (i) s.addShape(pres.shapes.RECTANGLE, { x: x, y: ay + hh * 0.18, w: 0.008, h: hh * 0.64, fill: { color: C.card_border } });
      // 数值字号有下限：KPI 条一旦被压得比标签还小，整条就读成了脚注（层级倒挂）
      s.addText(String(it.value), { x: x + 0.10, y: ay + hh * 0.08, w: w - 0.20, h: hh * 0.48, valign: "middle",
        align: "center", fontFace: F.title, fontSize: Math.round(S().kpi * 0.76), bold: true,
        color: TONE(it.tone) || C.primary, margin: 0, minFontSize: Math.round(S().cap * 1.7) });
      s.addText(String(it.label || ""), { x: x + 0.06, y: ay + hh * 0.60, w: w - 0.12, h: hh * 0.34, valign: "top",
        align: "center", fontFace: F.body, fontSize: S().cap, color: C.text_muted, margin: 0, minFontSize: 9 });
    });
  }

  /** 键值网格：items=[{k,v}]，2–3 列密排。适合参数表 / 指标清单 */
  function kvGrid(s, o) {
    if (!mustHaveItems(o, "items", "kvGrid", ["k", "v"], ["k", "v"])) return;
    var a = A(o, "kvGrid"), items = o.items, n = items.length;
    var cols = o.cols || (n > 6 ? 3 : 2), rn = Math.ceil(n / cols);
    var gx = 0.26, gy = 0.14, cw = (a.w - gx * (cols - 1)) / cols;
    var rh = Math.min(0.62, (a.h - gy * (rn - 1)) / rn), totalH = rn * rh + (rn - 1) * gy;
    var ay = a.y + Math.max(0, (a.h - totalH) / 2);
    items.forEach(function (it, i) {
      var x = a.x + (i % cols) * (cw + gx), y = ay + Math.floor(i / cols) * (rh + gy);
      s.addShape(pres.shapes.RECTANGLE, { x: x, y: y + rh * 0.18, w: 0.045, h: rh * 0.64, fill: { color: C.primary } });
      s.addText(String(it.k), { x: x + 0.14, y: y, w: cw * 0.56, h: rh, valign: "middle",
        fontFace: F.body, fontSize: S().body - 1, color: C.text_muted, margin: 0, minFontSize: 9 });
      s.addText(String(it.v), { x: x + cw * 0.56, y: y, w: cw - cw * 0.56 - 0.06, h: rh, valign: "middle",
        align: "right", fontFace: F.title, fontSize: S().body, bold: true,
        color: TONE(it.tone) || C.text_on_light, margin: 0, minFontSize: 10 });
    });
  }

  /** 结论条：整幅品牌色横条 + 一句结论。用来给一页"收口"，也顺手填掉底部空白 */
  function calloutBlock(s, o) {
    if (!mustHave(o, "text", "calloutBlock")) return;
    var a = A(o, "calloutBlock"), hh = Math.min(a.h, o.h || 0.92), ay = a.y + (a.h - hh) / 2;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: a.x, y: ay, w: a.w, h: hh, rectRadius: 0.08,
      fill: { color: tint(C.primary, 0.9) } });
    s.addShape(pres.shapes.RECTANGLE, { x: a.x, y: ay + 0.08, w: 0.06, h: hh - 0.16, fill: { color: C.primary } });
    var lw = 0;
    if (o.label) {
      lw = Math.min(a.w * 0.24, textEm(String(o.label), true) * (S().body) / 72 + 0.42);
      s.addText(String(o.label), { x: a.x + 0.22, y: ay, w: lw, h: hh, valign: "middle",
        fontFace: F.title, fontSize: S().body + 1, bold: true, color: C.primary, margin: 0, minFontSize: 10 });
    }
    s.addText(String(o.text || ""), { x: a.x + 0.24 + lw, y: ay, w: a.w - 0.46 - lw, h: hh, valign: "middle",
      fontFace: F.title, fontSize: S().body + 2, color: C.text_on_light, margin: 0, minFontSize: S().body });
  }

  /** 编号要点：大号数字 + 标题 + 说明，一行一条。比项目符号有分量，也比卡片省地方 */
  function numberList(s, o) {
    if (!mustHaveItems(o, "items", "numberList", null, ["title", "text"])) return;
    var a = A(o, "numberList"), items = o.items, n = items.length;
    var gy = 0.16, rh = Math.min(0.82, (a.h - gy * (n - 1)) / n), totalH = n * rh + (n - 1) * gy;
    var ay = a.y + Math.max(0, (a.h - totalH) / 2), numW = 0.86;
    // ⚠️ 序号字号必须同时受"行高"和"号码框宽度"约束——只按行高算，两位数会被折成竖排两行
    var numFS = Math.round(Math.min(rh * 44, numW * 72 / 1.45));
    items.forEach(function (it, i) {
      var y = ay + i * (rh + gy);
      s.addText(("0" + (i + 1)).slice(-2), { x: a.x, y: y, w: numW, h: rh, align: "left", valign: "middle",
        fontFace: F.title, fontSize: numFS, bold: true, color: tint(C.primary, 0.34), margin: 0, autofit: false });
      var tx = a.x + numW + 0.16, tw = a.w - numW - 0.16;
      var hasD = !!it.text, th = hasD ? rh * 0.46 : rh;
      s.addText(String(it.title || ""), { x: tx, y: y, w: tw, h: th, valign: hasD ? "bottom" : "middle",
        fontFace: F.title, fontSize: S().cardTitle - 1, bold: true, color: C.text_on_light, margin: 0, minFontSize: 11 });
      if (hasD) s.addText(String(it.text), { x: tx, y: y + rh * 0.48, w: tw, h: rh * 0.5, valign: "top",
        fontFace: F.body, fontSize: S().body - 1, color: C.text_muted, margin: 0, minFontSize: 9 });
      s.addShape(pres.shapes.RECTANGLE, { x: tx, y: y + rh - 0.008, w: tw, h: 0.008, fill: { color: C.card_border } });
    });
  }

  /** 分层架构图：layers=[{title, tags:[…]}]，自上而下堆叠色带（越靠上颜色越浅） */
  function layersBlock(s, o) {
    if (!mustHaveItems(o, "layers", "layersBlock", null, ["title", "tags"])) return;
    var a = A(o, "layersBlock"), L = o.layers, n = L.length;
    var gap = 0.16, h = (a.h - gap * (n - 1)) / n, labW = Math.min(2.0, a.w * 0.22);
    L.forEach(function (ly, i) {
      var y = a.y + i * (h + gap), k = 0.62 - 0.14 * (n - 1 - i) / Math.max(1, n - 1);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: a.x, y: y, w: a.w, h: h, rectRadius: 0.08,
        fill: { color: tint(C.primary, Math.max(0.05, k)) } });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: a.x, y: y, w: labW, h: h, rectRadius: 0.08, fill: { color: C.primary } });
      s.addText(String(ly.title || ""), { x: a.x + 0.14, y: y, w: labW - 0.28, h: h, align: "center", valign: "middle",
        fontFace: F.title, fontSize: S().cardTitle - 1, bold: true, color: C.text_on_dark, margin: 0, minFontSize: 11 });
      var tags = ly.tags || [], tw = (a.w - labW - 0.5 - 0.14 * (tags.length - 1)) / Math.max(1, tags.length);
      tags.forEach(function (t, j) {
        var tx = a.x + labW + 0.25 + j * (tw + 0.14), th = Math.min(h - 0.24, 0.52);
        s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: y + (h - th) / 2, w: tw, h: th, rectRadius: 0.06,
          fill: { color: C.card_bg }, line: { color: C.card_border, width: 0.75 } });
        s.addText(String(t), { x: tx + 0.06, y: y + (h - th) / 2, w: tw - 0.12, h: th, align: "center", valign: "middle",
          fontFace: F.body, fontSize: S().body - 1, color: C.text_on_light, margin: 0, minFontSize: 9 });
      });
    });
  }

  /** 2×2 象限矩阵：quadrants 顺序 = 左上、右上、左下、右下 */
  function matrixBlock(s, o) {
    if (!mustHaveItems(o, "quadrants", "matrixBlock", null, ["title", "lines"])) return;
    if (o.quadrants.length !== 4) {
      issue("matrixBlock 是 2×2 四象限，`quadrants` 必须正好 4 个，现在给了 " +
        o.quadrants.length + " 个 —— " +
        (o.quadrants.length < 4 ? "缺的格子会是空白" : "第 5 项起会被直接丢掉、内容根本不会出现在页面上") +
        "，本块未绘制"); return;
    }
    var a = A(o, "matrixBlock"), q = o.quadrants;
    var axis = o.xLabel || o.yLabel ? 0.42 : 0.02, gx = 0.18, gy = 0.18;
    var gxw = (a.w - axis - gx) / 2, gyh = (a.h - axis - gy) / 2;
    var ox = a.x + axis, oy = a.y;
    [0, 1, 2, 3].forEach(function (i) {
      var it = q[i] || {}, cxq = ox + (i % 2) * (gxw + gx), cyq = oy + Math.floor(i / 2) * (gyh + gy);
      var hot = !!it.hero;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cxq, y: cyq, w: gxw, h: gyh, rectRadius: 0.08,
        fill: { color: hot ? C.primary : tint(C.primary, 0.93) },
        line: { color: hot ? C.primary : C.card_border, width: 0.75 } });
      var ik = hot ? C.text_on_dark : C.text_on_light;
      s.addText(String(it.title || ""), { x: cxq + 0.22, y: cyq + 0.13, w: gxw - 0.44, h: 0.38, valign: "middle",
        fontFace: F.title, fontSize: S().cardTitle - 1, bold: true, color: ik, margin: 0, minFontSize: 12 });
      // 要点区把象限卡剩下的高度吃满（之前留了 0.20" 白边，导致 3 行明明放得下却报"文案过长"）
      if (it.lines && it.lines.length) s.addText(bullets(it.lines),
        { x: cxq + 0.22, y: cyq + 0.53, w: gxw - 0.44, h: gyh - 0.67, fontFace: F.body, fontSize: S().body - 1,
          color: ik, lineSpacingMultiple: LOOSE, paraSpaceAfter: 3, valign: "top", margin: 0, minFontSize: 9 });
    });
    // 坐标轴标签。⚠️ 旋转文本的文本框是**先按原始宽高排版再整体旋转**，
    // 所以纵轴标签必须给一个"宽而扁"的框（w=区域高度）再转 270°，否则字会被挤成一列。
    if (o.yLabel) {
      var yh = 0.34, yw = 2 * gyh + gy;
      s.addText(String(o.yLabel), { x: a.x + axis / 2 - yw / 2, y: a.y + (2 * gyh + gy) / 2 - yh / 2, w: yw, h: yh,
        align: "center", valign: "middle", rotate: 270,
        fontFace: F.accent, fontSize: 11, bold: true, color: C.text_muted, margin: 0 });
    }
    if (o.xLabel) s.addText(String(o.xLabel), { x: ox, y: a.y + 2 * gyh + gy + 0.04, w: 2 * gxw + gx, h: axis - 0.06,
      align: "center", valign: "middle",
      fontFace: F.accent, fontSize: 11, bold: true, color: C.text_muted, margin: 0 });
  }

  /* ---------- 自由拼版 compose()：像 flexbox 一样自由组合，坐标仍由引擎算 ----------
   * 这是"给创造力松绑"的那一层：配方 page.* 管快和稳，compose 管自由和密度。
   * 你只描述**这页有哪些块、谁上谁下、谁跟谁并排**，每块要多高由引擎按内容量算，
   * 剩余空间按 flex 分配 —— 因此既不会重叠越界，也不会被固定成一个模子。
   *
   *   compose(s, a, [
   *     { statStrip:{ items:[…] } },                       // 一行紧凑 KPI
   *     { row:[ { bars:{…}, flex:1.3 }, { bullets:{…} } ] },// 左右并排，左边宽一点
   *     { table:{ head:[…], rows:[…] }, flex:1.4 },         // 富余高度多分给表格
   *     { callout:{ label:"结论", text:"…" } },
   *   ]);
   */
  var BLOCKS = {
    cards:     { fn: function (s, a, o) { featureRow(s, Object.assign({ a: a }, o)); },
                 pref: function (o, w) { var n = (o.items || []).length, c = Math.min(o.cols || n, n) || 1;
                   return Math.ceil(n / c) * ((o.items || []).some(function (i) { return i.lines && i.lines.length > 2; }) ? 2.0 : 1.65); } },
    stats:     { fn: function (s, a, o) { statRow(s, Object.assign({ a: a }, o)); }, pref: function () { return KPI_H(); } },
    statStrip: { fn: function (s, a, o) { statStrip(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return ((o.items || []).length > 4 ? 2.0 : 1.02); } },
    bars:      { fn: function (s, a, o) { barsBlock(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return (o.items || []).length * 0.40 + (o.title ? 0.42 : 0); } },
    chart:     { fn: function (s, a, o) { chartBlock(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return ((o.opts && o.opts.showPercent) ? 2.35 : 1.95) + (o.title ? 0.42 : 0); } },
    bullets:   { fn: function (s, a, o) { bulletBlock(s, Object.assign({ a: a, fill: true }, o)); },
                 pref: function (o) { return 0.62 + Math.ceil((o.lines || []).length / ((o.lines || []).length >= 4 ? 2 : 1)) * 0.34; } },
    compare:   { fn: function (s, a, o) { compareRow(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return 0.6 + Math.max((o.left && o.left.lines || []).length, (o.right && o.right.lines || []).length) * 0.34; } },
    flow:      { fn: function (s, a, o) { processRow(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return (o.steps || []).some(function (x) { return x.d; }) ? 1.55 : 1.05; } },
    timeline:  { fn: function (s, a, o) { timelineRow(s, Object.assign({ a: a }, o)); }, pref: function () { return 1.6; } },
    quote:     { fn: function (s, a, o) { quoteBlock(s, Object.assign({ a: a }, o)); }, pref: function () { return 2.0; } },
    table:     { fn: function (s, a, o) { tableBlock(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return ((o.rows || []).length + 1) * 0.40; } },
    kv:        { fn: function (s, a, o) { kvGrid(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { var n = (o.items || []).length, c = o.cols || (n > 6 ? 3 : 2); return Math.ceil(n / c) * 0.62; } },
    callout:   { fn: function (s, a, o) { calloutBlock(s, Object.assign({ a: a }, o)); }, pref: function () { return 0.84; } },
    numbers:   { fn: function (s, a, o) { numberList(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return (o.items || []).length * 0.92; } },
    layers:    { fn: function (s, a, o) { layersBlock(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { return (o.layers || []).length * 0.76; } },
    matrix:    { fn: function (s, a, o) { matrixBlock(s, Object.assign({ a: a }, o)); }, pref: function () { return 3.0; } },
    image:     { fn: function (s, a, o) { imageBlock(s, Object.assign({ a: a }, o)); }, pref: function () { return 2.4; } },
    photos:    { fn: function (s, a, o) { photoGrid(s, Object.assign({ a: a }, o)); },
                 pref: function (o) { var n = (o.items || []).length, c = Math.min(o.cols || (n <= 2 ? n : (n <= 4 ? 2 : 3)), n) || 1;
                   return Math.ceil(n / c) * 1.6; } },
  };
  function _itemKind(it) {
    for (var k in BLOCKS) if (it[k] !== undefined) return k;
    return it.row ? "row" : null;
  }
  function _pref(it, w) {
    if (it.h) return it.h;
    if (it.row) {
      var mx = 0, kids = it.row, gapx = 0.34, cw = (w - gapx * (kids.length - 1)) / Math.max(1, kids.length);
      kids.forEach(function (k) { mx = Math.max(mx, _pref(k, cw)); });
      return mx;
    }
    var kind = _itemKind(it);
    return kind ? Math.max(0.6, BLOCKS[kind].pref(it[kind] || {}, w)) : 0.6;
  }
  // 每块的"最低可读高度"：压到这个以下字就看不清了，宁可报警让模型拆页，也不许无限压
  function _min(it, w) {
    if (it.h) return it.h;
    if (it.row) {
      var mx = 0, kids = it.row, cw = (w - 0.34 * (kids.length - 1)) / Math.max(1, kids.length);
      kids.forEach(function (k) { mx = Math.max(mx, _min(k, cw)); });
      return mx;
    }
    // 每块最多只允许压掉 28%：固定 0.92" 的下限会把"6 条要点的卡"压成放不下的框
    return Math.max(0.7, _pref(it, w) * 0.72);
  }
  function _draw(s, it, a) {
    if (it.row) {
      var kids = it.row, gapx = it.gap == null ? 0.34 : it.gap;
      var tot = 0, prefs = kids.map(function (k) { var p = _pref(k, a.w); tot += (k.flex || 1); return p; });
      var avail = a.w - gapx * (kids.length - 1), x = a.x;
      kids.forEach(function (k, i) {
        var kw = avail * (k.flex || 1) / tot;
        _draw(s, k, { x: x, y: a.y, w: kw, h: a.h });
        x += kw + gapx;
      });
      return;
    }
    var kind = _itemKind(it);
    if (kind) { _sig(s, kind); BLOCKS[kind].fn(s, a, it[kind] || {}); return; }
    // 块名拼错时这里曾经静默跳过，而 _pref 还按 0.6" 给它留了位置 ——
    // 版面上于是出现一条永远填不上的空白带，audit 却什么都看不见。
    issue("compose/page.free 收到未知区块名 " + JSON.stringify(Object.keys(it)) +
      "，本块未绘制；可用区块：" + Object.keys(BLOCKS).join(" / "));
  }
  // 登记这一页用了哪些区块，writeFile 时用来查"版式坍缩"（多页同构）
  function _sig(s, kind) { (s.__kinds || (s.__kinds = [])).push(kind); }
  function compose(s, area, items) {
    items = (items || []).filter(Boolean);
    if (!items.length) return;
    var gap = 0.24, n = items.length;
    var avail = area.h - gap * (n - 1);
    var prefs = items.map(function (it) { return _pref(it, area.w); });
    var total = prefs.reduce(function (x, y) { return x + y; }, 0);
    var hs;
    if (total <= avail) {                      // 有富余 → 按 flex 分给愿意长高的块（封顶 1.6 倍，免得单块被拉变形）
      var fsum = 0; items.forEach(function (it) { fsum += (it.flex || 0); });
      var extra = avail - total;
      hs = prefs.map(function (p, i) {
        if (!fsum) return p + extra / n;
        return p + (items[i].flex ? extra * items[i].flex / fsum : 0);
      }).map(function (h, i) { return Math.min(h, prefs[i] * 1.9); });
      var used = hs.reduce(function (x, y) { return x + y; }, 0);
      if (used < avail) { var k = (avail - used) / n; hs = hs.map(function (h) { return h + k; }); }
    } else {
      // 装不下 → 只压"可压的那部分"，每块不低于最低可读高度；真的塞不下就明确报警让模型拆页
      var mins = items.map(function (it) { return _min(it, area.w); });
      var minSum = mins.reduce(function (x, y) { return x + y; }, 0);
      if (minSum >= avail) {
        console.warn("[pptkit] ⚠ 本页放不下这 " + n + " 个块（最少需要 " + (minSum + gap * (n - 1)).toFixed(2) +
          "\"，版心只有 " + area.h.toFixed(2) + "\"）：请拆成两页，或去掉一个块 —— 硬塞的结果是全页小字");
        hs = mins.map(function (m) { return m * avail / minSum; });
      } else {
        var slack = total - minSum, need = total - avail;
        hs = prefs.map(function (p, i) { return p - (p - mins[i]) * (need / slack); });
      }
    }
    var y = area.y;
    items.forEach(function (it, i) { _draw(s, it, { x: area.x, y: y, w: area.w, h: hs[i] }); y += hs[i] + gap; });
  }

  /* ---------- 整页配方 page.*：一次调用 = 一整页，版面比例已经调好，模型不用再切区域 ---------- */
  function _hdr(o) { return { kicker: o.kicker, title: o.title, pageNo: o.pageNo, of: o.of,
                              note: o.note, chapter: o.chapter, source: o.source,
                              // 复刻模板时 setFrame 的回调要用到这些，原样透传
                              chapterNo: o.chapterNo, bg: o.bg, area: o.area, sub: o.sub }; }
  var page = {
    /** 卡片页：2–6 张并列卡（可给某张 hero:true 做视觉锚点） */
    cards: function (o) {
      var r = contentSlide(_hdr(o));
      featureRow(r.s, { a: r.a, items: o.items, cols: o.cols, center: o.center });
      return r.s;
    },
    /** 数据页：一排 KPI + 一张图表（最常用的"有数字有图"页） */
    kpiChart: function (o) {
      var r = contentSlide(_hdr(o));
      // 饼图的直径吃高度，所以给饼图留更多（否则 KPI 一压，饼就只剩一个小圆点）
      var isPieR = (o.chartOpts && o.chartOpts.showPercent) || o.chartType === pres.charts.PIE || o.chartType === pres.charts.DOUGHNUT;
      var rows = bandTop(r.a, KPI_H(), 0.34, isPieR ? 2.4 : 1.7);
      statRow(r.s, { a: rows[0], items: o.kpis, align: o.kpiAlign });
      chartBlock(r.s, { a: rows[1], title: o.chartTitle, type: o.chartType || pres.charts.BAR,
        data: o.chartData, opts: o.chartOpts });
      return r.s;
    },
    /** 排行页：一排 KPI + 排行条 */
    kpiBars: function (o) {
      var r = contentSlide(_hdr(o));
      // 排行条每条要 0.30"，标题再要 0.46"，先把这份高度留够，剩下的才给 KPI 带
      var rows = bandTop(r.a, KPI_H(), 0.34, (o.bars || []).length * 0.30 + (o.barsTitle ? 0.46 : 0));
      statRow(r.s, { a: rows[0], items: o.kpis, align: o.kpiAlign });
      barsBlock(r.s, { a: rows[1], title: o.barsTitle, items: o.bars });
      return r.s;
    },
    /** 对比页：可选 KPI 行 + 左右对比卡（left=现状/劣势，right=目标态/优势） */
    compare: function (o) {
      var r = contentSlide(_hdr(o));
      var a = r.a;
      if (o.kpis && o.kpis.length) { var rr = bandTop(a, KPI_H(), 0.34, 1.75); statRow(r.s, { a: rr[0], items: o.kpis }); a = rr[1]; }
      compareRow(r.s, { a: a, left: o.left, right: o.right });
      return r.s;
    },
    /** 流程页：chevron 流程 + 下方补充（cards 或 bullets 二选一，避免整页只有一条流程显得空） */
    flow: function (o) {
      var r = contentSlide(_hdr(o));
      var rows = rowsOf(r.a, [1, 1.35]);
      processRow(r.s, { a: rows[0], steps: o.steps });
      if (o.items && o.items.length) featureRow(r.s, { a: rows[1], items: o.items, cols: o.cols });
      else if (o.bullets) bulletBlock(r.s, { a: rows[1], title: o.bulletsTitle, lines: o.bullets });
      else if (o.chartData) chartBlock(r.s, { a: rows[1], title: o.chartTitle, type: o.chartType || pres.charts.BAR, data: o.chartData, opts: o.chartOpts });
      return r.s;
    },
    /** 历程页：时间线 + 下方补充 */
    timeline: function (o) {
      var r = contentSlide(_hdr(o));
      var rows = rowsOf(r.a, [1, 1.25]);
      timelineRow(r.s, { a: rows[0], steps: o.steps });
      if (o.items && o.items.length) featureRow(r.s, { a: rows[1], items: o.items, cols: o.cols });
      else if (o.left && o.right) { var cc = colsOf(rows[1], 2);
        bulletBlock(r.s, { a: cc[0], title: o.left.title, lines: o.left.lines });
        bulletBlock(r.s, { a: cc[1], title: o.right.title, lines: o.right.lines }); }
      return r.s;
    },
    /** 左右分栏页：左右各放一块（bullets / bars / chart 任意组合） */
    split: function (o) {
      var r = contentSlide(_hdr(o));
      var cc = colsOf(r.a, 2, 0.42);
      [o.left, o.right].forEach(function (side, i) {
        if (!side) return;
        var a = cc[i];
        if (side.bars) barsBlock(r.s, { a: a, title: side.title, items: side.bars });
        else if (side.chartData) chartBlock(r.s, { a: a, title: side.title, type: side.chartType || pres.charts.BAR, data: side.chartData, opts: side.chartOpts });
        else bulletBlock(r.s, { a: a, title: side.title, lines: side.lines, fill: true });
      });
      return r.s;
    },
    /** 架构页：分层架构图（每层一条色带 + 若干能力标签），"看起来是画出来的"那种页 */
    layers: function (o) {
      var r = contentSlide(_hdr(o));
      layersBlock(r.s, { a: r.a, layers: o.layers });
      return r.s;
    },
    /** 矩阵页：2×2 象限（quadrants 顺序=左上/右上/左下/右下，可给某格 hero:true） */
    matrix: function (o) {
      var r = contentSlide(_hdr(o));
      matrixBlock(r.s, { a: r.a, quadrants: o.quadrants, xLabel: o.xLabel, yLabel: o.yLabel });
      return r.s;
    },
    /** 照片页：整幅实景图 + 压暗遮罩 + 图上文字。景点/场景/案例展示用它，比"半图半字"有气势 */
    photo: function (o) {
      var c = cv(), m = M(), s = pres.addSlide();
      s.background = { color: C.bg_dark };
      photo(s, { x: 0, y: 0, w: c.w, h: c.h }, o.img);
      s.addShape(pres.shapes.RECTANGLE, decor({ x: 0, y: 0, w: c.w, h: c.h,
        fill: { color: "000000", transparency: o.scrim == null ? 56 : o.scrim } }));
      var bx = m + 0.4, bw = c.w * (o.textWidth || 0.56);
      scrimBand(s, 0, c.h * 0.18, bw + bx + 0.6, c.h * 0.78);
      if (o.kicker) s.addText(String(o.kicker).toUpperCase(), { x: bx, y: c.h * 0.30, w: bw, h: 0.30,
        fontFace: F.accent, fontSize: 12, bold: true, color: "E2E2E2", charSpacing: 3, margin: 0 });
      s.addText(o.title || "", { x: bx, y: c.h * 0.375, w: bw, h: c.h * 0.20, valign: "middle",
        fontFace: F.title, fontSize: WIDE() ? 38 : 32, bold: true, color: "FFFFFF", margin: 0, minFontSize: 22 });
      s.addShape(pres.shapes.RECTANGLE, { x: bx, y: c.h * 0.60, w: 1.0, h: 0.05, fill: { color: onBg(C.bg_dark) } });
      if (o.lines && o.lines.length) s.addText(bullets(o.lines), { x: bx, y: c.h * 0.655, w: bw, h: c.h * 0.26,
        fontFace: F.body, fontSize: S().body + 1, color: "FFFFFF", lineSpacingMultiple: LOOSE,
        paraSpaceAfter: 5, valign: "top", margin: 0, minFontSize: 11 });
      if (o.pageNo != null) s.addText(String(o.pageNo) + (o.of ? "  /  " + o.of : ""),
        { x: c.w - m - 1.1, y: c.h - 0.46, w: 1.1, h: 0.3, align: "right",
          fontFace: F.accent, fontSize: 10, color: "C8C8C8", charSpacing: 1, margin: 0 });
      if (o.note) s.addNotes(o.note);
      return s;
    },
    /** 自由拼版页：把 compose 的块清单直接喂进来，一行搞定一整页（推荐用它做高密度页） */
    free: function (o) {
      var r = contentSlide(_hdr(o));
      compose(r.s, r.a, o.blocks);
      return r.s;
    },
    /** 主张页：整幅品牌色 + 一句大字主张。用来在连续的浅色内容页之间"换口气"，节奏感全靠它 */
    statement: function (o) {
      var c = cv(), m = M(), s = pres.addSlide();
      s.background = { color: C.primary };
      coverDecor(s, o.motif || "dots");
      if (o.kicker) s.addText(String(o.kicker).toUpperCase(), { x: m + 0.4, y: c.h * 0.24, w: c.w - 2 * m - 0.8, h: 0.32,
        fontFace: F.accent, fontSize: 12, bold: true, color: tint(C.text_on_dark, 0), charSpacing: 3, margin: 0 });
      s.addText(o.title || "", { x: m + 0.4, y: c.h * 0.33, w: c.w - 2 * m - 0.8, h: c.h * 0.34, valign: "middle",
        fontFace: F.title, fontSize: WIDE() ? 40 : 34, bold: true, color: C.text_on_dark, margin: 0, minFontSize: 22 });
      s.addShape(pres.shapes.RECTANGLE, { x: m + 0.4, y: c.h * 0.70, w: 1.1, h: 0.05, fill: { color: C.text_on_dark } });
      if (o.text) s.addText(o.text, { x: m + 0.4, y: c.h * 0.755, w: c.w - 2 * m - 0.8, h: c.h * 0.16,
        fontFace: F.body, fontSize: S().body + 2, color: C.text_on_dark, transparency: 22, margin: 0, valign: "top" });
      if (o.note) s.addNotes(o.note);
      return s;
    },
    /** 大数字页：一个数字撑满半页 + 右侧解释。单点结论最有冲击力的表达 */
    bigNumber: function (o) {
      var r = contentSlide(_hdr(o)), a = r.a, s = r.s;
      var lw = a.w * 0.42;
      s.addText(String(o.value || ""), { x: a.x, y: a.y, w: lw, h: a.h * 0.62, valign: "middle",
        fontFace: F.title, fontSize: WIDE() ? 108 : 92, bold: true, color: C.primary, margin: 0, minFontSize: 44 });
      s.addShape(pres.shapes.RECTANGLE, { x: a.x, y: a.y + a.h * 0.645, w: 1.0, h: 0.05, fill: { color: C.accent || C.primary } });
      if (o.label) s.addText(String(o.label), { x: a.x, y: a.y + a.h * 0.70, w: lw, h: a.h * 0.24, valign: "top",
        fontFace: F.body, fontSize: S().body + 2, color: C.text_muted, margin: 0 });
      compose(s, { x: a.x + lw + 0.5, y: a.y, w: a.w - lw - 0.5, h: a.h }, o.blocks || (o.lines && o.lines.length ? [{ bullets: { lines: o.lines } }] : []));
      return s;
    },
    /** 侧栏页：左侧品牌色面板放论点，右侧自由拼版放证据。咨询稿最常用的版式之一 */
    panel: function (o) {
      var r = contentSlide(_hdr(o)), a = r.a, s = r.s;
      var pw = a.w * (o.panelWidth || 0.34), p = o.panel || {};
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: a.x, y: a.y, w: pw, h: a.h, rectRadius: 0.10,
        fill: { color: C.primary }, shadow: shadow(0.14) });
      var pad = 0.30, py = a.y + pad;
      if (p.title) { s.addText(String(p.title), { x: a.x + pad, y: py, w: pw - 2 * pad, h: 0.62, valign: "middle",
        fontFace: F.title, fontSize: S().cardTitle + 2, bold: true, color: C.text_on_dark, margin: 0, minFontSize: 13 }); py += 0.70; }
      if (p.lines && p.lines.length) s.addText(bullets(p.lines),
        { x: a.x + pad, y: py, w: pw - 2 * pad, h: a.y + a.h - pad - py, fontFace: F.body, fontSize: S().body,
          color: C.text_on_dark, lineSpacingMultiple: LOOSE, paraSpaceAfter: 5, valign: "top", margin: 0, minFontSize: 10 });
      compose(s, { x: a.x + pw + 0.42, y: a.y, w: a.w - pw - 0.42, h: a.h }, o.blocks || []);
      return s;
    },
    /** 观点页：一句金句独占一页（唯一允许"纯文字"的页型） */
    quote: function (o) {
      var r = contentSlide(_hdr(o));
      quoteBlock(r.s, { a: r.a, text: o.text, by: o.by });
      return r.s;
    },
  };

  /* ---------- 安装体检钩子 ---------- */
  if (!pres.__pptkit) {
    pres.__pptkit = true;
    var origWrite = pres.writeFile.bind(pres);
    pres.writeFile = function (opt) {
      pres.__report = audit(pres, !!cfg.quiet, C);
      // 内容缺失不是"建议"，是交付事故：宁可不出文件，也不许把空白页交到用户手里。
      var iss = (pres.__report && pres.__report.issues) || [];
      if (iss.length) {
        // 拒绝出稿会留下一个陷阱：上一次跑成功的 output.pptx 还原封不动躺在目标路径上。
        // 那是个**旧的、页数不全的**版本，模型一个 PptxProgress 就能把它当成果交出去 ——
        // 用户拿到的 PPT 看起来正常，只是少了几页，比直接报错还难发现。
        // 所以把它移开（改名保留字节，不删），让交付路径失败得看得见。
        var moved = "";
        try {
          var fs = require("fs");
          var fp = opt && (typeof opt === "string" ? opt : opt.fileName);
          if (fp && fs.existsSync(fp)) {
            var bak = fp + ".rejected";
            try { fs.unlinkSync(bak); } catch (e1) {}
            fs.renameSync(fp, bak);
            moved = "\n  ⚠ 目录里上一次生成的 " + fp + " 已被移走（现在叫 " + bak + "）：" +
              "它是旧版本、页数不全，**绝对不能拿去交付**。";
          }
        } catch (e2) {}
        return Promise.reject(new Error(
          "[pptkit] 拒绝出稿：有 " + iss.length + " 处区块没画出任何内容\n  - " + iss.join("\n  - ") + moved +
          "\n  → 照上面的报错改 slides.js，然后重跑 node slides.js。" +
          "在它成功出稿之前：不许调 PptxProgress / PresentToUser，不许说\"已完成\"，" +
          "也不许交付目录里任何残留的 pptx。"));
      }
      return origWrite.apply(pres, arguments);
    };
  }

  // 区块名 → 单区块整页配方的兜底。
  // 区块叫 process，整页配方却叫 flow；区块叫 table/bullets/photos，整页配方压根没有同名的——
  // 模型按直觉写 page.process({...}) 就是一个硬崩（实测真崩过）。这里把每个区块名都补成
  // 一个"只放这一个块"的页型，命名不一致就再也崩不了了。已有的配方不覆盖。
  Object.keys(BLOCKS).forEach(function (k) {
    if (page[k]) return;
    page[k] = function (o) {
      o = o || {};
      var blk = {}; blk[k] = o;
      return page.free({ kicker: o.kicker, title: o.title, pageNo: o.pageNo, of: o.of,
                         note: o.note, chapter: o.chapter, chapterNo: o.chapterNo,
                         source: o.source, blocks: [blk] });
    };
  });
  page.process = page.process || page.flow;      // 最常见的那次口误，单独兜一道

  // 给每张幻灯片打上"用了哪个整页配方"的标签，配合 __kinds 供体检查版式坍缩
  Object.keys(page).forEach(function (k) {
    if (typeof page[k] !== "function") return;
    var fn = page[k];
    page[k] = function () {
      var before = (pres.slides || []).length;
      var r = fn.apply(this, arguments);
      for (var i = before; i < (pres.slides || []).length; i++) pres.slides[i].__recipe = k;
      return r;
    };
  });

  return {
    // 网格
    cv: cv, bodyArea: bodyArea, rowsOf: rowsOf, colsOf: colsOf, padOf: padOf,
    // 页型
    coverSlide: coverSlide, tocSlide: tocSlide, sectionSlide: sectionSlide,
    contentSlide: contentSlide, closingSlide: closingSlide,
    page: page,                       // 整页配方（首选，见 components.md 第 1 节）
    // 区块
    featureRow: featureRow, statRow: statRow, timelineRow: timelineRow, processRow: processRow,
    compareRow: compareRow, barsBlock: barsBlock, chartBlock: chartBlock, imageBlock: imageBlock,
    photoGrid: photoGrid, photo: photo,
    quoteBlock: quoteBlock, bulletBlock: bulletBlock, layersBlock: layersBlock, matrixBlock: matrixBlock,
    tableBlock: tableBlock, statStrip: statStrip, kvGrid: kvGrid, calloutBlock: calloutBlock, numberList: numberList,
    compose: compose, bandTop: bandTop, setFrame: setFrame,
    // 基础
    card: card, bullets: bullets, coverDecor: coverDecor, shadow: shadow,
    charts: pres.charts, shapes: pres.shapes, THEME: THEME, C: C, F: F,
    fitOne: fitOne, textEm: textEm, audit: function () { return audit(pres, false); },
  };
};
module.exports.textEm = textEm;
module.exports.fitOne = fitOne;
