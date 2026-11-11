// 宿主自带的矢量图标（Lucide，ISC 许可，见 LICENSE-lucide.txt），给 pptxgenjs 生成脚本用。
// 每个图标画成一个可编辑的自定义形状：颜色、大小随意，放大不糊，PowerPoint 里能直接改色。
//   const { addIcon } = require('<本文件的绝对路径>')   （.cjs：不管所在目录的 package.json 怎么声明，都按 CommonJS 加载）
//   addIcon(slide, 'cpu', { x: 1, y: 1, size: 0.5, color: '2563EB' })
// 不依赖 pptxgenjs 以外的东西；图标数据在同目录的 lucide.json（make_icons.mjs 生成）。
'use strict'

const ICONS = require('./lucide.json')

const GRID = 24
// 四分之一圆用三次贝塞尔近似时的控制点系数。
const KAPPA = 0.5522847498

/** 所有可用的图标名。 */
function names() {
  return Object.keys(ICONS)
}

/** 读路径字符串的游标：数字、圆弧的 0/1 标志都可能紧挨着写。 */
function reader(d) {
  let i = 0
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i += 1
  }
  return {
    command() {
      skip()
      return i < d.length && /[a-zA-Z]/.test(d[i]) ? d[i++] : null
    },
    hasNumber() {
      skip()
      return i < d.length && /[-+.\d]/.test(d[i])
    },
    number() {
      skip()
      const match = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i))
      if (!match) throw new Error(`bad path number at ${i}: ${d}`)
      i += match[0].length
      return parseFloat(match[0])
    },
    flag() {
      skip()
      const value = d[i++]
      if (value !== '0' && value !== '1') throw new Error(`bad arc flag at ${i}: ${d}`)
      return value === '1'
    }
  }
}

/** SVG 圆弧（端点写法）换成若干段三次贝塞尔，每段不超过 90 度。按 SVG 规范 F.6.5 求圆心。 */
function arcToCubics(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ x1, y1, x2, y2, x: x2, y: y2 }]
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (angle * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const xp = cos * dx + sin * dy
  const yp = -sin * dx + cos * dy
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const den = rx * rx * yp * yp + ry * ry * xp * xp
  let coef = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) coef = -coef
  const cxp = (coef * rx * yp) / ry
  const cyp = (-coef * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angleOf = (ux, uy, vx, vy) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1
    const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
    return sign * Math.acos(Math.min(1, Math.max(-1, dot)))
  }
  const start = angleOf(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let delta = angleOf((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const parts = Math.ceil(Math.abs(delta) / (Math.PI / 2))
  const step = delta / parts
  const t = (4 / 3) * Math.tan(step / 4)
  const point = (theta) => [cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin, cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos]
  const tangent = (theta) => [-rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin, -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos]
  const curves = []
  for (let k = 0; k < parts; k += 1) {
    const a = start + k * step
    const b = a + step
    const [ax, ay] = point(a)
    const [bx, by] = point(b)
    const [tax, tay] = tangent(a)
    const [tbx, tby] = tangent(b)
    curves.push({ x1: ax + t * tax, y1: ay + t * tay, x2: bx - t * tbx, y2: by - t * tby, x: bx, y: by })
  }
  return curves
}

/** 路径字符串换成子路径列表：{ start, segs: [{x,y} | {x1,y1,x2,y2,x,y}], closed }，坐标都是绝对值。 */
function parsePath(d) {
  const read = reader(d)
  const paths = []
  let current = null
  let x = 0
  let y = 0
  let lastCubic = null
  let lastQuad = null
  let command = null
  const lineTo = (nx, ny) => {
    current.segs.push({ x: nx, y: ny })
    x = nx
    y = ny
  }
  const cubicTo = (x1, y1, x2, y2, nx, ny) => {
    current.segs.push({ x1, y1, x2, y2, x: nx, y: ny })
    lastCubic = [x2, y2]
    x = nx
    y = ny
  }
  const quadTo = (qx, qy, nx, ny) => {
    cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny)
    lastQuad = [qx, qy]
  }
  for (;;) {
    const next = read.command()
    if (next) command = next
    else if (!command || !read.hasNumber()) break
    const rel = command === command.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const kind = command.toUpperCase()
    const keepCubic = kind === 'C' || kind === 'S'
    const keepQuad = kind === 'Q' || kind === 'T'
    if (kind === 'M') {
      x = ox + read.number()
      y = oy + read.number()
      current = { start: [x, y], segs: [], closed: false }
      paths.push(current)
      // 紧跟在 M 后面的坐标对按 L 处理。
      command = rel ? 'l' : 'L'
    } else if (kind === 'L') {
      lineTo(ox + read.number(), oy + read.number())
    } else if (kind === 'H') {
      lineTo(ox + read.number(), y)
    } else if (kind === 'V') {
      lineTo(x, oy + read.number())
    } else if (kind === 'C') {
      const v = [read.number(), read.number(), read.number(), read.number(), read.number(), read.number()]
      cubicTo(ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5])
    } else if (kind === 'S') {
      const v = [read.number(), read.number(), read.number(), read.number()]
      const [rx1, ry1] = lastCubic ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]] : [x, y]
      cubicTo(rx1, ry1, ox + v[0], oy + v[1], ox + v[2], oy + v[3])
    } else if (kind === 'Q') {
      const v = [read.number(), read.number(), read.number(), read.number()]
      quadTo(ox + v[0], oy + v[1], ox + v[2], oy + v[3])
    } else if (kind === 'T') {
      const v = [read.number(), read.number()]
      const [qx, qy] = lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y]
      quadTo(qx, qy, ox + v[0], oy + v[1])
    } else if (kind === 'A') {
      const rx = read.number()
      const ry = read.number()
      const angle = read.number()
      const large = read.flag()
      const sweep = read.flag()
      const nx = ox + read.number()
      const ny = oy + read.number()
      for (const c of arcToCubics(x, y, rx, ry, angle, large, sweep, nx, ny)) current.segs.push(c)
      x = nx
      y = ny
    } else if (kind === 'Z') {
      current.closed = true
      ;[x, y] = current.start
      command = null
    } else {
      throw new Error(`unsupported path command ${command}: ${d}`)
    }
    // S 只反射紧挨着的 C/S 的控制点，T 只反射紧挨着的 Q/T 的。
    if (!keepCubic) lastCubic = null
    if (!keepQuad) lastQuad = null
  }
  return paths
}

/** 椭圆：四段三次贝塞尔。 */
function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return {
    start: [cx + rx, cy],
    closed: true,
    segs: [
      { x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
      { x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
      { x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
      { x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy }
    ]
  }
}

/** 圆角矩形：直边加四个四分之一椭圆。 */
function rectPath(x, y, w, h, rx, ry) {
  rx = Math.min(rx, w / 2)
  ry = Math.min(ry, h / 2)
  if (!rx || !ry) {
    return { start: [x, y], closed: true, segs: [{ x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }
  }
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return {
    start: [x + rx, y],
    closed: true,
    segs: [
      { x: x + w - rx, y },
      { x1: x + w - rx + kx, y1: y, x2: x + w, y2: y + ry - ky, x: x + w, y: y + ry },
      { x: x + w, y: y + h - ry },
      { x1: x + w, y1: y + h - ry + ky, x2: x + w - rx + kx, y2: y + h, x: x + w - rx, y: y + h },
      { x: x + rx, y: y + h },
      { x1: x + rx - kx, y1: y + h, x2: x, y2: y + h - ry + ky, x, y: y + h - ry },
      { x, y: y + ry },
      { x1: x, y1: y + ry - ky, x2: x + rx - kx, y2: y, x: x + rx, y }
    ]
  }
}

/** 一个 SVG 元素换成子路径列表。 */
function elementPaths(tag, a) {
  const n = (key, fallback = 0) => (a[key] === undefined ? fallback : parseFloat(a[key]))
  if (tag === 'path') return parsePath(a.d)
  if (tag === 'circle') return [ellipsePath(n('cx'), n('cy'), n('r'), n('r'))]
  if (tag === 'ellipse') return [ellipsePath(n('cx'), n('cy'), n('rx'), n('ry'))]
  if (tag === 'rect') {
    const rx = a.rx === undefined ? n('ry') : n('rx')
    const ry = a.ry === undefined ? rx : n('ry')
    return [rectPath(n('x'), n('y'), n('width'), n('height'), rx, ry)]
  }
  if (tag === 'line') return [{ start: [n('x1'), n('y1')], closed: false, segs: [{ x: n('x2'), y: n('y2') }] }]
  if (tag === 'polyline' || tag === 'polygon') {
    const v = String(a.points).trim().split(/[\s,]+/).map(parseFloat)
    const segs = []
    for (let k = 2; k + 1 < v.length; k += 2) segs.push({ x: v[k], y: v[k + 1] })
    return [{ start: [v[0], v[1]], closed: tag === 'polygon', segs }]
  }
  throw new Error(`unsupported icon element ${tag}`)
}

/** 子路径几乎没有长度（如 M12 16h.01）时返回它的位置，否则返回 null。 */
function dotCenter(path) {
  const xs = [path.start[0], ...path.segs.map((seg) => seg.x)]
  const ys = [path.start[1], ...path.segs.map((seg) => seg.y)]
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  return spread < 0.1 ? [xs[0], ys[0]] : null
}

/** 子路径列表换成 pptxgenjs 自定义形状的 points（英寸，相对形状左上角）。 */
function toPoints(paths, scale) {
  const s = (v) => Math.round(v * scale * 10000) / 10000
  const points = []
  for (const path of paths) {
    points.push({ x: s(path.start[0]), y: s(path.start[1]), moveTo: true })
    for (const seg of path.segs) {
      if (seg.x1 === undefined) points.push({ x: s(seg.x), y: s(seg.y) })
      else points.push({ x: s(seg.x), y: s(seg.y), curve: { type: 'cubic', x1: s(seg.x1), y1: s(seg.y1), x2: s(seg.x2), y2: s(seg.y2) } })
    }
    if (path.closed) points.push({ close: true })
  }
  return points
}

/**
 * 在页面上画一个图标。opts：x、y（左上角，英寸）、size（边长，英寸，默认 0.5）、color（六位十六进制，默认 '1F2937'）、
 * weight（线条粗细倍数，默认 1；小图标看着细可以给 1.2）。返回 slide，方便链式调用。
 */
function addIcon(slide, name, opts = {}) {
  const icon = ICONS[name]
  if (!icon) throw new Error(`没有图标「${name}」。可用的有：${names().join(' ')}`)
  const size = opts.size || 0.5
  const color = String(opts.color || '1F2937').replace(/^#/, '')
  const scale = size / GRID
  // Lucide 的线宽是 24 格里的 2 格，换成磅：2/24 × 边长英寸 × 72。
  const width = Math.max(0.5, Math.round((2 / GRID) * size * 72 * (opts.weight || 1) * 100) / 100)
  const stroked = []
  const filled = []
  for (const [tag, attrs] of icon) {
    const paths = elementPaths(tag, attrs)
    if (attrs.fill && attrs.fill !== 'none') {
      filled.push(...paths)
      continue
    }
    for (const path of paths) {
      // Lucide 用「几乎零长度的线 + 圆头线帽」画小圆点；PowerPoint 形状的线是平头，画不出来，换成实心圆点。
      const dot = dotCenter(path)
      if (dot) filled.push(ellipsePath(dot[0], dot[1], opts.weight || 1, opts.weight || 1))
      else stroked.push(path)
    }
  }
  const box = { x: opts.x || 0, y: opts.y || 0, w: size, h: size }
  if (stroked.length) {
    slide.addShape('custGeom', { ...box, points: toPoints(stroked, scale), fill: { type: 'none' }, line: { color, width } })
  }
  if (filled.length) {
    slide.addShape('custGeom', { ...box, points: toPoints(filled, scale), fill: { color }, line: { color, width } })
  }
  return slide
}

module.exports = { addIcon, names }
