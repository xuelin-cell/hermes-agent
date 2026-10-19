import { useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { PdfPreview } from '../pdf-preview'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { readOfficePreviewPdf, readPdfBytes } from './source'

/** 普通 PDF 与 Office 转换结果共用分页查看器；读取与转换仍遵循原连接、限制和取消规则。 */
export default function PdfFilePreview({ onFailure, path, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const direct = /\.pdf$/i.test(path)

  useEffect(() => {
    let active = true
    const request = new AbortController()
    setBytes(null)
    void (direct ? readPdfBytes(path, target.dataUrl) : readOfficePreviewPdf(path, request.signal))
      .then(pdf => {
        if (active) {
          setBytes(new Uint8Array(pdf))
        }
      })
      .catch(error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      })

    return () => {
      active = false
      request.abort()
    }
  }, [direct, onFailure, path, reloadKey, target.dataUrl])

  if (bytes) {
    return <PdfPreview bytes={bytes} reloadKey={reloadKey} target={target} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-3">
      <PageLoader className="h-auto" label={direct ? t.preview.loading : t.preview.office.converting} />
      {!direct && <p className="text-center text-xs text-muted-foreground">{t.preview.office.firstOpen}</p>}
    </div>
  )
}
