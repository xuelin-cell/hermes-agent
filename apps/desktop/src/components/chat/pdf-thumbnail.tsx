import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { MonitorPlay } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { $connection } from '@/store/session'

/** PDF 卡片接近可见区才读首页；连接变化或卸载后废弃结果并释放 Worker 和图片。 */
export function PdfThumbnail({ target, cwd, label }: { target: string; cwd: string; label: string }) {
  const connection = useStore($connection)
  const owner = desktopFsCacheKey(connection)
  const element = useRef<HTMLSpanElement>(null)
  const [image, setImage] = useState<string>()
  useEffect(() => {
    let active = true
    let started = false
    let dispose: (() => Promise<void>) | undefined
    let ownedUrl: string | undefined
    setImage(undefined)

    /** 按正式文件读取归属取 PDF，缩略图只绘制第一页，不打开预览。 */
    async function load() {
      if (started || !active) {
        return
      }

      started = true

      try {
        const file = await normalizeOrLocalPreviewTarget(target, cwd)

        if (!file || file.kind !== 'file' || !active || owner !== desktopFsCacheKey()) {
          return
        }

        const [{ readPdfBytes }, { openPdfPages }] = await Promise.all([
          import('@/app/chat/right-rail/formats/source'),
          import('@/app/chat/right-rail/formats/pdf-pages')
        ])

        const bytes = await readPdfBytes(file.path || file.source, file.dataUrl)

        if (!active || owner !== desktopFsCacheKey()) {
          return
        }

        const reader = await openPdfPages(bytes, 160)
        dispose = () => reader.dispose()

        if (!active) {
          await reader.dispose()

          return
        }

        const url = await reader.renderPage(1)
        // 只保留小图片，不为每张卡片长期占用整份 PDF 和一个 Worker。
        const blob = await fetch(url).then(response => response.blob())
        await reader.dispose()
        dispose = undefined

        if (active && owner === desktopFsCacheKey()) {
          ownedUrl = URL.createObjectURL(blob)
          setImage(ownedUrl)
        }
      } catch {
        // 缩略图失败保留原图标，正式打开仍有完整错误出口。
        await dispose?.().catch(() => undefined)
      }
    }

    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            entries => {
              if (entries.some(entry => entry.isIntersecting)) {
                observer?.disconnect()
                void load()
              }
            },
            { rootMargin: '160px' }
          )
        : null

    if (observer && element.current) {
      observer.observe(element.current)
    } else {
      void load()
    }

    return () => {
      active = false
      observer?.disconnect()

      if (ownedUrl) {
        URL.revokeObjectURL(ownedUrl)
      }

      void dispose?.().catch(() => undefined)
    }
  }, [target, cwd, owner])

  return (
    <span className="grid h-12 w-9 shrink-0 place-items-center" ref={element}>
      {image ? (
        <img alt={label} className="max-h-12 w-9 object-contain" src={image} />
      ) : (
        <MonitorPlay className="size-3.5" />
      )}
    </span>
  )
}
