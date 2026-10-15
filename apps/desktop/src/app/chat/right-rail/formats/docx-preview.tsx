import { renderAsync } from 'docx-preview'
import DOMPurify from 'dompurify'
import { useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { readPreviewBytes } from './source'

/** 只画压缩包内的内容；清除跳转，并把文档样式限制在无脚本、无网络的独立页面内。 */
export async function renderDocxPage(bytes: ArrayBuffer) {
  const body = document.createElement('div')
  const styles = document.createElement('div')
  await renderAsync(bytes, body, styles, {
    inWrapper: false,
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
    useBase64URL: true
  })

  const widths = Array.from(body.querySelectorAll<HTMLElement>('section.docx')).map(page => {
    const match = /^([\d.]+)(pt|px)$/.exec(page.style.width)

    return match ? Number(match[1]) * (match[2] === 'pt' ? 96 / 72 : 1) : 0
  })

  const width = Math.max(0, ...widths)

  if (!Number.isFinite(width) || width <= 0) {
    throw { code: 'unsupported' }
  }

  const clean = DOMPurify.sanitize(styles.innerHTML + body.innerHTML, {
    ADD_TAGS: ['style'],
    FORCE_BODY: true,
    FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
    FORBID_ATTR: ['href', 'xlink:href', 'target', 'srcset']
  })

  return {
    width,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0}section.docx{margin:12px auto;box-shadow:none;background:Canvas}</style></head><body>${clean}</body></html>`
  }
}

/** 转换失败后的 docx 阅读器：保留页面排版，整个阅读视口随面板缩放，不让文档接触桌面桥接。 */
export default function DocxPreview({ onFailure, path, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<Awaited<ReturnType<typeof renderDocxPage>> | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    let active = true
    setPage(null)
    void readPreviewBytes(path)
      .then(bytes => (active ? renderDocxPage(bytes) : null))
      .then(result => {
        if (active && result) {
          setPage(result)
        }
      })
      .catch(error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      })

    return () => {
      active = false
    }
  }, [onFailure, path, reloadKey])

  useEffect(() => {
    const element = container.current!
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)

    return () => observer.disconnect()
  }, [])

  const scale = page && width > 24 ? Math.min(1, (width - 24) / page.width) : 1

  return (
    <div className="size-full min-h-0 overflow-hidden" ref={container}>
      {page ? (
        <iframe
          className="block border-0 bg-background"
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={page.html}
          style={{
            width: `${100 / scale}%`,
            height: `${100 / scale}%`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
          title={target.label}
        />
      ) : (
        <PageLoader label={t.preview.loading} />
      )}
    </div>
  )
}
