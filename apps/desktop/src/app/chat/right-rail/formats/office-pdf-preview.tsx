import { useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { readOfficePreviewPdf } from './source'

/** 本机 Office 产物复用 Chromium PDF 阅读器，刷新、换文件和关闭时释放地址。 */
export default function OfficePdfPreview({ onFailure, path, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    const request = new AbortController()
    setUrl(null)

    void readOfficePreviewPdf(path, request.signal)
      .then(pdf => {
        if (!active) {
          return
        }

        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }))
        setUrl(objectUrl)
      })
      .catch(error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      })

    return () => {
      active = false
      request.abort()

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [onFailure, path, reloadKey])

  if (!url) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-3">
        <PageLoader className="h-auto" label={t.preview.office.converting} />
        <p className="text-center text-xs text-muted-foreground">{t.preview.office.firstOpen}</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden">
      <iframe
        aria-label={target.label}
        className="h-full w-full border-0 bg-background"
        src={url}
        title={target.label}
      />
    </div>
  )
}
