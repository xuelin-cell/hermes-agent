import type { ConversationShareDocument } from '@hermes/shared/conversation-share'
import DOMPurify from 'dompurify'
import type { Root } from 'mdast'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { type Components, defaultRemarkPlugins, Streamdown } from 'streamdown'
import { visitParents } from 'unist-util-visit-parents'

import { MARKDOWN_CONTAINER_CLASS_NAME } from '@/components/assistant-ui/markdown-text-style'
import { CodeCard, CodeCardBody } from '@/components/chat/code-card'
import { SHIKI_COLOR_REPLACEMENTS, SHIKI_THEME } from '@/components/chat/shiki-config'
import { renderMediaTags } from '@/lib/chat-messages/parts'
import { FileText } from '@/lib/icons'
import { createMemoizedMathPlugin } from '@/lib/katex-memo'
import { preprocessMarkdown } from '@/lib/markdown-preprocess'

import { collectFontStyles } from './font-styles'
import { waitForPreparation } from './preparation-wait'
import { ConversationSharePage } from './snapshot-page'

const math = createMemoizedMathPlugin({ singleDollarTextMath: true })
const LIMIT = 2 * 1024 * 1024

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
  'box-sizing'
]

const components: Components = {
  // 禁用应用中的文件预览、附件卡片、指令和网络嵌入，只保留静态语义。
  a: ({ href, children }) =>
    href?.startsWith('#media:') || href?.startsWith('#preview') ? (
      <span className="inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        <FileText aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }} />
        {children}
      </span>
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
        throw new Error('Resource exceeds 2 MB')
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

/** 将代码、图表、图片和使用的字体固定下来，缺少任何资源都中止而非发布残缺页面。 */
async function resolveResources(
  root: HTMLElement,
  dark: boolean,
  signal: AbortSignal,
  source: ConversationShareDocument,
  readImage: ((reference: string) => Promise<string>) | undefined
): Promise<void> {
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
  for (const image of root.querySelectorAll('img')) {
    signal.throwIfAborted()
    const placeholder = image.getAttribute('data-share-image-source') ?? ''

    const reference = placeholder.startsWith(IMAGE_REFERENCE_PREFIX)
      ? decodeURIComponent(placeholder.slice(IMAGE_REFERENCE_PREFIX.length))
      : placeholder

    const asset = source.assets?.find(item => decodeURIComponent(item.reference) === decodeURIComponent(reference))
    image.src = asset && readImage ? await readImage(asset.reference) : await resourceData(reference, signal, true)
    await image.decode()
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
}

/** 复制实际使用的排版样式与字体，公开页不依赖应用 CSS、临时地址或运行时脚本。 */
async function freezeStyles(root: HTMLElement, signal: AbortSignal): Promise<string> {
  const families = new Set<string>()

  for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    const style = getComputedStyle(element)

    for (const name of style.fontFamily.split(',')) {
      families.add(name.trim().replace(/["']/g, ''))
    }

    for (const name of STYLE_PROPERTIES) {
      const value = style.getPropertyValue(name)

      if (value && !/url\s*\(/i.test(value)) {
        element.style.setProperty(name, value)
      }
    }

    if (element.matches('table')) {
      element.style.width = '100%'
    }

    if (element.closest('.katex')) {
      for (const name of ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']) {
        element.style.setProperty(name, style.getPropertyValue(name))
      }
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
export async function exportConversationHtml(
  source: ConversationShareDocument,
  labels: SharePageLabels,
  signal: AbortSignal,
  readImage?: (reference: string) => Promise<string>
): Promise<string> {
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
    await waitForPreparation(resolveResources(root, source.theme === 'dark', signal, source, readImage), signal)
    const fonts = await waitForPreparation(freezeStyles(root, signal), signal)
    signal.throwIfAborted()
    // 计算样式中的 margin 已按离屏容器宽度解析成像素，公开页需要按实际视口重新居中。
    root.style.margin = '0 auto'
    const content = sanitizeShareContent(root.outerHTML)
    const title = document.createElement('span')
    title.textContent = source.title
    const html = `<!doctype html><html lang="${/^[a-zA-Z-]{2,16}$/.test(source.locale) ? source.locale : 'en'}" style="color-scheme:${source.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.innerHTML}</title><style>${fonts}body{margin:0;background:${root.style.backgroundColor};color:${root.style.color}}main{max-width:860px;box-sizing:border-box;margin:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{max-width:100%}summary{cursor:pointer}@media(max-width:600px){main{padding:16px!important}}</style></head><body>${content}</body></html>`

    if (new TextEncoder().encode(html).length > LIMIT) {
      throw new Error('Share page exceeds 2 MB')
    }

    return html
  } catch (error) {
    signal.throwIfAborted()
    throw new Error(`${labels.resourceError} ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    react.unmount()
    host.remove()
  }
}
