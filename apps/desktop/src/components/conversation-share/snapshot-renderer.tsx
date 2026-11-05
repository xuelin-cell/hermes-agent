import type { ConversationShareDocument } from '@hermes/shared/conversation-share'
import DOMPurify from 'dompurify'
import type { Root } from 'mdast'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { type Components, defaultRemarkPlugins, Streamdown } from 'streamdown'
import { visitParents } from 'unist-util-visit-parents'

import { MARKDOWN_CONTAINER_CLASS_NAME } from '@/components/assistant-ui/markdown-text-style'
import { CodeCard, CodeCardBody } from '@/components/chat/code-card'
import { SHIKI_COLOR_REPLACEMENTS, SHIKI_THEME } from '@/components/chat/shiki-config'
import { registerPluginLocales, translatePlugin } from '@/i18n/plugin-i18n'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { renderMediaTags } from '@/lib/chat-messages/parts'
import { FileText, Lock } from '@/lib/icons'
import { createMemoizedMathPlugin } from '@/lib/katex-memo'
import { preprocessMarkdown } from '@/lib/markdown-preprocess'

import { collectFontStyles } from './font-styles'
import { waitForPreparation } from './preparation-wait'
import { ConversationSharePage } from './snapshot-page'

const math = createMemoizedMathPlugin({ singleDollarTextMath: true })
// 与 uniclaw-shares 网关所在服务的 SHARE_MAX_BYTES 默认值一致（5,000,000 字节，不是 5 MiB）。
const LIMIT = 5_000_000

const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'white-space',
  'word-break',
  'overflow-wrap',
  'display',
  'vertical-align',
  'padding',
  'margin',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'list-style-type',
  'list-style-position',
  'direction',
  'unicode-bidi',
  'flex-direction',
  'flex-shrink',
  'flex-grow',
  'flex-basis',
  'min-width',
  'max-width',
  'min-height',
  'align-items',
  'justify-content',
  'gap',
  'grid-template-columns',
  'position',
  'top',
  'left',
  'bottom',
  'right',
  'transform',
  'transform-origin',
  'fill',
  'stroke',
  'stroke-width',
  'opacity',
  'clip',
  'clip-path',
  'overflow',
  'text-overflow',
  'box-sizing'
]

/** 子元素与父元素相同时由浏览器继承即可，无需逐个元素重复写入。 */
const INHERITED = new Set([
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'white-space',
  'word-break',
  'overflow-wrap',
  'list-style-type',
  'list-style-position',
  'direction',
  'border-collapse',
  'border-spacing',
  'fill',
  'stroke',
  'stroke-width'
])

/** 文件引用只公开文件名和类型，版式与桌面版的产出文件卡片一致，不含本机路径和下载入口。 */
const FILE_SCOPE = 'desktop-mt.conversation-share-file'
registerPluginLocales(FILE_SCOPE, {
  en: {
    notPublic: 'File not shared',
    reason: 'For data security, shared pages show file names only and offer no downloads. Ask the sender for the file.',
    imageMissing: (alt: string) => (alt ? `Image not embedded: ${alt}` : 'Image not embedded')
  },
  zh: {
    notPublic: '文件未公开',
    reason: '为保护数据安全，分享页仅展示文件名，不提供下载。如需文件请联系分享者。',
    imageMissing: (alt: string) => (alt ? `图片未能嵌入：${alt}` : '图片未能嵌入')
  },
  'zh-hant': {
    notPublic: '檔案未公開',
    reason: '為保護資料安全，分享頁僅顯示檔案名稱，不提供下載。如需檔案請聯絡分享者。',
    imageMissing: (alt: string) => (alt ? `圖片未能嵌入：${alt}` : '圖片未能嵌入')
  }
})

function ShareFileCard({ href, children }: { href: string; children: ReactNode }) {
  const encoded = href.replace(/^#(?:media:|preview[:/])/, '')
  let path = encoded

  try {
    path = decodeURIComponent(encoded)
  } catch {
    // 保留原文；无法解码的名称仍只取最后一段。
  }

  const fallback = typeof children === 'string' ? children.replace(/^\w+:\s*/, '') : ''
  const name = path.split(/[\\/]/).filter(Boolean).pop() || fallback
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toUpperCase()

  const t = (key: string) => translatePlugin(FILE_SCOPE, getRuntimeI18nLocale(), key, [])

  // 公开页没有脚本，悬停说明使用原生 title；卡片上只放短标签，不抢正文。
  return (
    <span
      className="my-1 flex items-center gap-3 rounded-xl border border-border px-4 py-3"
      style={{ maxWidth: 560 }}
      title={t('reason')}
    >
      <FileText aria-hidden="true" className="text-muted-foreground" style={{ width: 20, height: 20, flexShrink: 0 }} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        {extension && <span className="text-xs text-muted-foreground">{extension}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Lock aria-hidden="true" style={{ width: 12, height: 12, flexShrink: 0 }} />
        {t('notPublic')}
      </span>
    </span>
  )
}

const components: Components = {
  // 禁用应用中的文件预览、附件卡片、指令和网络嵌入，只保留静态语义。
  a: ({ href, children }) =>
    href?.startsWith('#media:') || href?.startsWith('#preview') ? (
      <ShareFileCard href={href}>{children}</ShareFileCard>
    ) : (
      <a href={href}>{children}</a>
    ),
  img: ({ src, alt }) => <img alt={alt ?? ''} data-share-image-source={src} />,
  pre: ({ children }) => (
    <CodeCard>
      <CodeCardBody>
        <pre>{children}</pre>
      </CodeCardBody>
    </CodeCard>
  ),
  h1: ({ children }) => <h1 className="my-1 font-semibold text-[1rem] tracking-tight">{children}</h1>,
  h2: ({ children }) => <h2 className="my-1 font-semibold text-[0.9375rem] tracking-tight">{children}</h2>,
  h3: ({ children }) => <h3 className="my-1 font-semibold text-[0.875rem]">{children}</h3>,
  h4: ({ children }) => <h4 className="my-1 font-semibold text-[0.8125rem]">{children}</h4>,
  table: ({ children }) => <table className="my-2 w-full border-collapse text-sm">{children}</table>,
  th: ({ children }) => (
    <th className="bg-muted/35 px-2.5 py-1.5 text-left font-medium text-muted-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top text-[0.8125rem] leading-snug">{children}</td>,
  code: ({ children, className }) => <code className={className}>{children}</code>
}

export interface SharePageLabels {
  readonly: string
  user: string
  assistant: string
  process: string
  resourceError: string
}

/** 生成不可执行的可序列化节点，同时移除事件、应用指令和本机链接。 */
export function sanitizeShareContent(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [
      'script',
      'iframe',
      'frame',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'meta',
      'link',
      'base',
      'audio',
      'video'
    ],
    FORBID_ATTR: ['srcset', 'ping', 'download', 'autofocus', 'contenteditable'],
    ADD_TAGS: ['annotation', 'semantics'],
    ADD_ATTR: ['encoding']
  })

  for (const node of fragment.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith('data-') || attribute.name.startsWith('on') || attribute.name.startsWith('::')) {
        node.removeAttribute(attribute.name)
      }
    }

    if (node instanceof HTMLAnchorElement) {
      const href = node.getAttribute('href') ?? ''

      if (!/^https?:\/\//i.test(href) && !href.startsWith('#')) {
        node.removeAttribute('href')
      }

      if (/^https?:/i.test(href)) {
        const url = new URL(href)

        if (
          url.username ||
          url.password ||
          [...url.searchParams.keys()].some(key =>
            /^(?:token|access_token|authorization|api_key|jwt|signature)$/i.test(key)
          )
        ) {
          node.removeAttribute('href')
        }
      }

      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }

    if (node instanceof HTMLImageElement && !/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(node.src)) {
      throw new Error('Image resource is not embedded')
    }

    // CSS 中也不能保留临时或外部资源，字体由独立白名单样式提供。
    const style = node.getAttribute('style')

    if (style && /url\s*\(\s*["']?(?!#)|@import|expression\s*\(/i.test(style)) {
      node.removeAttribute('style')
    }
  }

  const container = document.createElement('div')
  container.append(fragment)

  return container.innerHTML
}

/** 读取受浏览器同源策略限制的静态资源，不携带凭据，不读取本地文件或后端附件。 */
async function resourceBlob(url: string, signal: AbortSignal, image: boolean): Promise<Blob> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const parsed = new URL(url, location.href)

  if (
    parsed.username ||
    parsed.password ||
    [...parsed.searchParams.keys()].some(key =>
      /^(?:token|access_token|authorization|api_key|jwt|signature)$/i.test(key)
    )
  ) {
    throw new Error('Credential-bearing resource URL')
  }

  if (image && !['https:', 'data:'].includes(parsed.protocol)) {
    throw new Error('Unsupported image resource')
  }

  if (!image && parsed.origin !== location.origin && !['https:', 'data:'].includes(parsed.protocol)) {
    throw new Error('Unsupported font resource')
  }

  let response: Response

  try {
    response = await fetch(parsed, { signal, credentials: 'omit', redirect: 'error' })
  } catch (error) {
    throw new Error(
      `${image ? 'Image' : 'Font/style'} resource (${parsed.hostname || parsed.protocol}): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!response.ok) {
    throw new Error(`Resource ${response.status}`)
  }

  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('Missing resource body')
  }

  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0

  try {
    while (true) {
      const part = await reader.read()

      if (part.done) {
        break
      }

      size += part.value.length

      if (size > LIMIT) {
        throw new Error('Resource exceeds 5 MB')
      }

      chunks.push(new Uint8Array(part.value))
    }
  } finally {
    await reader.cancel()
  }

  const mime = response.headers.get('content-type')?.split(';')[0] ?? ''

  if (image && !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(mime)) {
    throw new Error('Unsupported image format')
  }

  return new Blob(chunks, { type: mime })
}

/** 将已校验的资源转成内嵌地址，公开页面不保留字体和图片的外部请求。 */
async function resourceData(url: string, signal: AbortSignal, image: boolean): Promise<string> {
  const blob = await resourceBlob(url, signal, image)

  return await new Promise<string>((resolve, reject) => {
    const file = new FileReader()
    file.onload = () => resolve(String(file.result))
    file.onerror = () => reject(file.error)
    file.readAsDataURL(blob)
  })
}

const IMAGE_REFERENCE_PREFIX = 'https://hermes-share.invalid/image/'

/** 把图片引用编码成无网络加载的中间地址，解析缓存重复使用节点时仍能恢复原始来源。 */
function shareImagePlugin() {
  return (tree: Root) => {
    visitParents(tree, 'image', node => {
      if (!node.url.startsWith(IMAGE_REFERENCE_PREFIX)) {
        node.url = IMAGE_REFERENCE_PREFIX + encodeURIComponent(node.url)
      }
    })
  }
}

const IMAGE_INDEX = 'data-share-image-index'

/** 嵌不进去的正文图片在原位置留下看得见的占位，读者知道这里原本有一张图；data 属性在序列化时被清除。 */
function replaceWithPlaceholder(image: HTMLImageElement): void {
  const alt = (image.getAttribute('alt') ?? '').trim()
  const placeholder = document.createElement('span')
  placeholder.textContent = translatePlugin(FILE_SCOPE, getRuntimeI18nLocale(), 'imageMissing', [alt])
  placeholder.style.cssText =
    'display:inline-block;padding:8px 12px;border:1px dashed currentColor;border-radius:8px;font-size:12px;opacity:0.6'
  image.replaceWith(placeholder)
}

/** 将代码、图表、图片和使用的字体固定下来，缺少任何资源都中止而非发布残缺页面。 */
async function resolveResources(
  root: HTMLElement,
  dark: boolean,
  signal: AbortSignal,
  source: ConversationShareDocument,
  readImage: ((reference: string) => Promise<string>) | undefined
): Promise<number[]> {
  const missing: number[] = []
  const fences = [...root.querySelectorAll<HTMLElement>('pre > code')]

  if (fences.length) {
    const shiki = await import('shiki')

    for (const code of fences) {
      signal.throwIfAborted()
      const language = code.className.match(/language-([\w-]+)/)?.[1] ?? 'text'

      if (language === 'mermaid') {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          htmlLabels: false,
          flowchart: { htmlLabels: false }
        })
        const result = await mermaid.render(`share-${crypto.randomUUID()}`, code.textContent ?? '')
        code.parentElement!.outerHTML = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { svg: true, svgFilters: true }
        })
      } else if (language === 'svg') {
        code.parentElement!.outerHTML = DOMPurify.sanitize(code.textContent ?? '', {
          USE_PROFILES: { svg: true, svgFilters: true }
        })
      } else {
        const lang = language in shiki.bundledLanguages ? language : 'text'
        code.parentElement!.outerHTML = await shiki.codeToHtml(code.textContent ?? '', {
          lang,
          theme: dark ? SHIKI_THEME.dark : SHIKI_THEME.light,
          colorReplacements: SHIKI_COLOR_REPLACEMENTS
        })
      }
    }
  }

  // 所有图片在同一容器内完成内嵌和解码；附件及 MEDIA 本机路径从不读取。
  // 图片不阻止发布：嵌不进去的正文图片换成占位，序号返回给分享窗口在发布前提示。
  let ordinal = 0

  for (const image of root.querySelectorAll('img')) {
    signal.throwIfAborted()
    const placeholder = image.getAttribute('data-share-image-source') ?? ''
    const markdownImage = placeholder.startsWith(IMAGE_REFERENCE_PREFIX)
    const reference = markdownImage ? decodeURIComponent(placeholder.slice(IMAGE_REFERENCE_PREFIX.length)) : placeholder
    const asset = source.assets?.find(item => decodeURIComponent(item.reference) === decodeURIComponent(reference))

    if (!markdownImage) {
      // 页面自带的品牌标识等内嵌资源，失败说明页面本身有问题，照常中止。
      image.src = await resourceData(reference, signal, true)
      await image.decode()

      continue
    }

    const index = ++ordinal
    image.setAttribute(IMAGE_INDEX, String(index))

    try {
      // 本机图片只读后端登记并校验过摘要的；后端跳过的本机图片和不支持的地址按未嵌入处理。
      if (asset && readImage) {
        image.src = await readImage(asset.reference)
      } else if (/^https?:/i.test(reference) && readImage) {
        image.src = await readImage(reference)
      } else if (/^data:/i.test(reference)) {
        image.src = await resourceData(reference, signal, true)
      } else {
        throw new Error('Image resource is not embedded')
      }

      await image.decode()
    } catch {
      signal.throwIfAborted()
      missing.push(index)
      replaceWithPlaceholder(image)
    }
  }

  if (root.querySelector('iframe,video,audio,canvas')) {
    throw new Error('Unsupported interactive resource')
  }

  for (const image of root.querySelectorAll('svg image,svg use')) {
    const href = image.getAttribute('href') || image.getAttribute('xlink:href') || ''

    if (href && !href.startsWith('#')) {
      throw new Error('External SVG resource')
    }
  }

  // 内嵌资源后由公开页加载字体，不等待应用其他页面或历史主题的全局字体任务。
  return missing
}

/** 在隔离的 Shadow DOM 中读取浏览器默认样式；公开页只有默认样式表，未改变的属性不必内联。 */
function browserDefaults(): { of: (element: Element) => CSSStyleDeclaration; dispose: () => void } {
  const host = document.createElement('div')
  host.style.cssText = 'all:initial;position:fixed;left:-20000px;top:0;width:860px;pointer-events:none'
  const shadow = host.attachShadow({ mode: 'open' })
  const container = document.createElement('div')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  container.append(svg)
  shadow.append(container)
  document.body.append(host)
  const cache = new Map<string, CSSStyleDeclaration>()

  return {
    of: element => {
      const key = `${element.namespaceURI}:${element.localName}`
      let style = cache.get(key)

      if (!style) {
        const probe = document.createElementNS(element.namespaceURI, element.localName)

        ;(element.namespaceURI === svg.namespaceURI && element.localName !== 'svg' ? svg : container).append(probe)
        style = getComputedStyle(probe)
        cache.set(key, style)
      }

      return style
    },
    dispose: () => host.remove()
  }
}

/** 只写入与浏览器默认值或父元素继承值不同的样式；先全部读取再写入，避免写入改变后续元素的计算值。 */
function frozenDeclarations(
  element: HTMLElement,
  style: CSSStyleDeclaration,
  parent: CSSStyleDeclaration | null,
  defaults: (element: Element) => CSSStyleDeclaration,
  neutral: CSSStyleDeclaration
): Array<[string, string]> {
  const base = defaults(element)
  const result: Array<[string, string]> = []

  for (const name of STYLE_PROPERTIES) {
    const value = style.getPropertyValue(name)

    if (!value || /url\s*\(/i.test(value)) {
      continue
    }

    if (INHERITED.has(name)) {
      // 标签自带默认值（标题字号、代码字体、链接颜色）时，继承不会生效，需要显式写入。
      const inherits = parent && base.getPropertyValue(name) === neutral.getPropertyValue(name)

      if (inherits ? value === parent.getPropertyValue(name) : value === base.getPropertyValue(name)) {
        continue
      }
    } else if (value === base.getPropertyValue(name)) {
      continue
    }

    if (name.startsWith('border') && name !== 'border-collapse' && name !== 'border-spacing' && /^0px\b/.test(value)) {
      continue
    }

    if (name === 'transform-origin' && style.transform === 'none') {
      continue
    }

    if (['top', 'left', 'bottom', 'right'].includes(name) && style.position === 'static') {
      continue
    }

    result.push([name, value])
  }

  if (element.closest('.katex')) {
    for (const name of ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']) {
      result.push([name, style.getPropertyValue(name)])
    }
  }

  return result
}

/** 复制实际使用的排版样式与公式字体，公开页不依赖应用 CSS、临时地址或运行时脚本。 */
async function freezeStyles(root: HTMLElement, signal: AbortSignal): Promise<string> {
  const families = new Set<string>()
  const defaults = browserDefaults()
  const plan: Array<[HTMLElement, Array<[string, string]>, string[]]> = []

  try {
    const neutral = defaults.of(document.createElement('span'))

    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const style = getComputedStyle(element)

      // 中文正文使用访问者本机字体；只有公式字体缺失会改变含义，才内嵌。
      if (element.closest('.katex')) {
        for (const name of style.fontFamily.split(',')) {
          families.add(name.trim().replace(/["']/g, ''))
        }
      }

      const parent = element === root || !element.parentElement ? null : getComputedStyle(element.parentElement)
      // 依赖应用 CSS 变量的原始内联声明在公开页无法解析，改用计算值。
      const unresolved = [...element.style].filter(name => /var\(|^$/.test(element.style.getPropertyValue(name)))
      plan.push([element, frozenDeclarations(element, style, parent, defaults.of, neutral), unresolved])
    }
  } finally {
    defaults.dispose()
  }

  for (const [element, declarations, unresolved] of plan) {
    for (const name of unresolved) {
      element.style.removeProperty(name)
    }

    for (const [name, value] of declarations) {
      element.style.setProperty(name, value)
    }

    if (element.matches('table')) {
      element.style.width = '100%'
    }

    // 导出容器和代码区取消滚动裁剪；数学及 SVG 的内部尺寸保持原生样式。
    if (element === root || element.matches('pre,article,[data-streamdown="code-block"]')) {
      element.style.maxHeight = 'none'
      element.style.overflow = 'visible'
    }
  }

  return await collectFontStyles(families, signal, {
    data: resourceData,
    // 样式与字体使用相同的无凭据、无重定向和大小限制。
    text: async (url, signal) => (await resourceBlob(url, signal, false)).text()
  })
}

/** 按可信完整快照渲染非虚拟容器；关闭、超时或资源失败都会停止发布。 */
export interface ExportedConversationPage {
  html: string
  /** 未能嵌入、在页面中显示为占位的正文图片序号（从 1 开始）。 */
  missingImages: number[]
}

/** 整页超限时从最大的正文图片开始换成占位，直到放得下；纯文字仍超限才放弃。 */
function fitWithinLimit(root: HTMLElement, missing: number[], render: () => string): string {
  for (let html = render(); ; html = render()) {
    if (new TextEncoder().encode(html).length <= LIMIT) {
      return html
    }

    const largest = [...root.querySelectorAll<HTMLImageElement>(`img[${IMAGE_INDEX}]`)].sort(
      (a, b) => b.src.length - a.src.length
    )[0]

    if (!largest) {
      throw new Error('Share page exceeds 5 MB')
    }

    missing.push(Number(largest.getAttribute(IMAGE_INDEX)))
    replaceWithPlaceholder(largest)
  }
}

export async function exportConversationHtml(
  source: ConversationShareDocument,
  labels: SharePageLabels,
  signal: AbortSignal,
  readImage?: (reference: string) => Promise<string>
): Promise<ExportedConversationPage> {
  const host = document.createElement('div')
  host.className = source.theme === 'dark' ? 'dark' : ''
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:860px;pointer-events:none;'
  host.style.colorScheme = source.theme
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const react = createRoot(host)
  const remarkPlugins = [...Object.values(defaultRemarkPlugins), shareImagePlugin]

  try {
    signal.throwIfAborted()
    flushSync(() =>
      react.render(
        <ConversationSharePage
          labels={labels}
          renderMarkdown={text => (
            <Streamdown
              className={MARKDOWN_CONTAINER_CLASS_NAME}
              components={components}
              controls={false}
              mode="static"
              plugins={{ math }}
              remarkPlugins={remarkPlugins}
              skipHtml
              urlTransform={url => url}
            >
              {preprocessMarkdown(renderMediaTags(text))}
            </Streamdown>
          )}
          source={source}
        />
      )
    )
    const root = host.firstElementChild as HTMLElement

    const missing = await waitForPreparation(
      resolveResources(root, source.theme === 'dark', signal, source, readImage),
      signal
    )

    const fonts = await waitForPreparation(freezeStyles(root, signal), signal)
    signal.throwIfAborted()
    // 计算样式中的 margin 已按离屏容器宽度解析成像素，公开页需要按实际视口重新居中。
    root.style.margin = '0 auto'
    const title = document.createElement('span')
    title.textContent = source.title

    // 聊天表面透明时由页面主题提供底色，深色快照不会落在浏览器默认白底上。
    const background = /^(?:|transparent|rgba\(0, 0, 0, 0\))$/.test(root.style.backgroundColor)
      ? source.theme === 'dark'
        ? '#1b1c21'
        : '#ffffff'
      : root.style.backgroundColor

    const render = () =>
      `<!doctype html><html lang="${/^[a-zA-Z-]{2,16}$/.test(source.locale) ? source.locale : 'en'}" style="color-scheme:${source.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.innerHTML}</title><style>${fonts}body{margin:0;background:${background};color:${root.style.color}}main{max-width:860px;box-sizing:border-box;margin:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{max-width:100%}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}details[open]>summary .share-chevron{transform:rotate(90deg)!important}@media(max-width:600px){main{padding:16px!important}}</style></head><body>${sanitizeShareContent(root.outerHTML)}</body></html>`

    const html = fitWithinLimit(root, missing, render)

    return { html, missingImages: [...new Set(missing)].sort((a, b) => a - b) }
  } catch (error) {
    signal.throwIfAborted()
    throw new Error(`${labels.resourceError} ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    react.unmount()
    host.remove()
  }
}
