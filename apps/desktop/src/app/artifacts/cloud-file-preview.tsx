import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { dataUrlToBlob } from '@/lib/embedded-images'

interface CloudFilePreviewProps {
  name: string
  preview: { dataUrl: string; kind: 'image' | 'pdf' | 'text' }
  onClose: () => void
  onDownload: () => void
}

/** 云盘预览只消费主进程已下载的字节，读取位置不受当前 Agent/Profile 影响。 */
export function CloudFilePreview({ name, preview, onClose, onDownload }: CloudFilePreviewProps) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')

  const text = useMemo(
    () =>
      preview.kind === 'text'
        ? new TextDecoder().decode(Uint8Array.from(atob(preview.dataUrl.split(',')[1]), value => value.charCodeAt(0)))
        : '',
    [preview]
  )

  useEffect(() => {
    if (preview.kind !== 'pdf') {
      return
    }

    const blob = dataUrlToBlob(preview.dataUrl)

    if (!blob) {
      return
    }

    const next = URL.createObjectURL(blob)
    setUrl(next)

    return () => URL.revokeObjectURL(next)
  }, [preview])

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          onClose()
        }
      }}
      open
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
        </DialogHeader>
        <div className="h-[65vh] overflow-auto">
          {preview.kind === 'image' ? (
            <img alt={name} className="mx-auto max-h-full max-w-full object-contain" src={preview.dataUrl} />
          ) : preview.kind === 'pdf' ? (
            url && <iframe className="h-full w-full border-0" src={url} title={name} />
          ) : (
            <pre className="whitespace-pre-wrap break-words text-sm">{text}</pre>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onDownload}>{t.cloudLibrary.download}</Button>
          <Button onClick={onClose} variant="ghost">
            {t.common.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
