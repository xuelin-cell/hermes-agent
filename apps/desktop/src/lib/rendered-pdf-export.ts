/**
 * Markdown 预览导出 PDF：抓取「已渲染」的预览 DOM，而不是重新转换 Markdown 源文，
 * 这样代码高亮、公式、图表等屏幕上看到的效果都能原样进入 PDF。
 *
 * 流程：克隆渲染节点 → canvas 转图片 → 图片内联为 data: URI → 收集页面 CSS
 * 并内联字体 → 包成独立 HTML → 由统一的「另存为」接口在隔离窗口打印。
 * 移植自 UniClaw exportRendered.ts，去掉了 UniClaw 专有的 Widget 等待逻辑和 Word 导出。
 */

const INLINE_RESOURCE_CAP = 8 * 1024 * 1024

/** 把 CSS 文本里相对的 url(...) 改写为以 baseHref 为基准的绝对地址，离开原页面后仍能解析。 */
export function absolutizeCssUrls(cssText: string, baseHref: string): string {
  return cssText.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (match, quote: string, ref: string) => {
    if (/^(data:|blob:|https?:|#)/i.test(ref)) {
      return match
    }

    try {
      return `url(${quote}${new URL(ref, baseHref).href}${quote})`
    } catch {
      return match
    }
  })
}

/** 转义写入 HTML 属性和标题的文本。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 把 Blob 读成 data: URI。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 尽力把资源取成 data: URI；失败或超过 8 MB 时返回 null，由调用方保留原地址。 */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)

    if (!res.ok) {
      return null
    }

    const blob = await res.blob()

    return blob.size > INLINE_RESOURCE_CAP ? null : await blobToDataUrl(blob)
  } catch {
    return null
  }
}

/** 把克隆里的每个 canvas 换成原 canvas 当前画面的 PNG，打印窗口不会重新执行绘制代码。 */
function replaceCanvasesWithImages(live: HTMLElement, clone: HTMLElement): void {
  const liveCanvases = Array.from(live.querySelectorAll('canvas'))

  Array.from(clone.querySelectorAll('canvas')).forEach((cloneCanvas, index) => {
    const liveCanvas = liveCanvases[index]

    if (!liveCanvas) {
      return
    }

    try {
      const img = clone.ownerDocument.createElement('img')
      img.src = liveCanvas.toDataURL('image/png')
      const rect = liveCanvas.getBoundingClientRect()

      if (rect.width > 0) {
        img.style.width = `${rect.width}px`
      }

      img.style.maxWidth = '100%'
      cloneCanvas.replaceWith(img)
    } catch {
      // 跨域污染的 canvas 无法导出，直接去掉，避免 PDF 里出现空白框。
      cloneCanvas.remove()
    }
  })
}

/** 把克隆里的图片内联为 data: URI；预览图片走应用自定义协议，打印窗口无法直接访问。 */
async function inlineImages(clone: HTMLElement): Promise<void> {
  await Promise.all(
    Array.from(clone.querySelectorAll('img')).map(async img => {
      const src = img.getAttribute('src') || ''

      if (!src || src.startsWith('data:')) {
        return
      }

      let absolute: string

      try {
        absolute = new URL(src, document.baseURI).href
      } catch {
        return
      }

      img.setAttribute('src', (await fetchAsDataUrl(absolute)) ?? absolute)
    })
  )
}

/** 收集当前页面全部可读样式表，并把其中的相对地址改成绝对地址。 */
function collectDocumentCss(): string {
  let css = ''

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    } catch {
      // 跨域样式表不可读，跳过。
      continue
    }

    const text = Array.from(rules)
      .map(rule => rule.cssText)
      .join('\n')

    css += absolutizeCssUrls(text, sheet.href || document.baseURI) + '\n'
  }

  return css
}

/** 把 CSS 中 http(s) 字体和背景资源内联，打印窗口禁止联网时字形仍与屏幕一致。 */
async function inlineCssResources(css: string): Promise<string> {
  const urlRe = /url\(\s*(['"]?)(https?:[^)'"]+)\1\s*\)/gi
  const refs = new Set<string>()

  for (const match of css.matchAll(urlRe)) {
    refs.add(match[2])
  }

  const replacements = new Map<string, string>()

  await Promise.all(
    Array.from(refs).map(async ref => {
      const dataUrl = await fetchAsDataUrl(ref)

      if (dataUrl) {
        replacements.set(ref, dataUrl)
      }
    })
  )

  if (replacements.size === 0) {
    return css
  }

  return css.replace(urlRe, (match, quote: string, ref: string) => {
    const dataUrl = replacements.get(ref)

    return dataUrl ? `url(${quote}${dataUrl}${quote})` : match
  })
}

/** 去掉脚本、内嵌页面、事件属性和 javascript: 链接；打印窗口只需要静态内容，不能执行页面代码。 */
export function stripActiveContent(clone: HTMLElement): void {
  clone.querySelectorAll('script, iframe, object, embed').forEach(el => el.remove())
  clone.querySelectorAll('meta[http-equiv]').forEach(el => {
    if ((el.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') {
      el.remove()
    }
  })

  const walker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.currentNode

  while (node) {
    const el = node as Element

    for (const attr of Array.from(el.attributes ?? [])) {
      const name = attr.name.toLowerCase()

      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
      } else if (
        ['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name) &&
        /^\s*(?:javascript|vbscript):/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name)
      }
    }

    node = walker.nextNode()
  }
}

/** 判断计算后的颜色是否完全不透明；兼容 rgba(…, a) 与 oklch(… / a) 两种写法。 */
export function isOpaqueColor(color: string): boolean {
  const value = color.trim()

  if (!value || value === 'transparent') {
    return false
  }

  const alpha = /\/\s*([\d.]+%?)\s*\)$/.exec(value)?.[1] ?? /^rgba\((?:[^,]+,){3}\s*([\d.]+%?)\s*\)$/.exec(value)?.[1]

  if (alpha === undefined) {
    return true
  }

  return alpha.endsWith('%') ? parseFloat(alpha) >= 100 : parseFloat(alpha) >= 1
}

/** 向上查找第一个不透明的背景色；毛玻璃窗口一路半透明时返回 null，由调用方改用浅色主题白底。 */
function opaqueBackground(el: HTMLElement): string | null {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor

    if (isOpaqueColor(bg)) {
      return bg
    }
  }

  return null
}

// 打印覆盖样式：解除预览容器的宽度和滚动限制，避免代码块、表格在纸面上被裁掉。
const PRINT_OVERRIDES = `
html, body { margin: 0; padding: 0; height: auto; overflow: visible !important; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
[data-preview-markdown] { max-width: none !important; margin: 0 !important; padding: 0 !important; font-size: 14px; }
[data-preview-markdown] pre, [data-preview-markdown] code { white-space: pre-wrap !important; word-break: break-word; }
[data-preview-markdown] * { overflow: visible !important; }
[data-preview-markdown] img { max-height: none !important; }
[data-preview-markdown] img, [data-preview-markdown] tr, [data-preview-markdown] pre { break-inside: avoid; }
@page { size: A4; margin: 14mm; }
`

/** 把已渲染的 Markdown 节点快照成可离线打开的独立 HTML，样式、主题、图片都与屏幕一致。 */
export async function captureRenderedHtml(node: HTMLElement, title: string): Promise<string> {
  const clone = node.cloneNode(true) as HTMLElement

  stripActiveContent(clone)
  replaceCanvasesWithImages(node, clone)
  await inlineImages(clone)

  const css = await inlineCssResources(collectDocumentCss())
  const root = document.documentElement
  const background = opaqueBackground(node)
  // 找不到不透明背景时去掉深色主题，否则白底上会是浅色文字。
  const rootClass = background ? root.className : root.className.replace(/\bdark\b/g, '')
  const mode = root.dataset.hermesMode
  const modeAttr = mode && background ? ` data-hermes-mode="${escapeHtml(mode)}"` : ''

  return `<!doctype html>
<html class="${escapeHtml(rootClass)}" style="${escapeHtml(root.getAttribute('style') || '')}" lang="${escapeHtml(root.lang || 'en')}"${modeAttr}>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
<style>${PRINT_OVERRIDES} html, body { background: ${background ?? '#ffffff'}; }</style>
</head>
<body>
${clone.outerHTML}
</body>
</html>`
}
