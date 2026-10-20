import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Download } from '@/lib/icons'
import { captureRenderedHtml } from '@/lib/rendered-pdf-export'
import { notifyError } from '@/store/notifications'

interface PreviewExportControlsProps {
  name: string
  text: string
  snapshot: () => string
  snapshotRoot: () => HTMLElement | null
  disabled: boolean
}

/** Markdown 的三个另存为出口共享当前原文或渲染快照，不改写源文件。 */
export function PreviewExportControls({ name, text, snapshot, snapshotRoot, disabled }: PreviewExportControlsProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  /** 只有显式点击才捕获内容和选择保存位置；取消不提示失败。 */
  async function save(format: 'md' | 'pdf' | 'docx') {
    if (busy) {
      return
    }

    setBusy(true)

    try {
      let content = text

      if (format === 'pdf') {
        const rendered = snapshotRoot()?.querySelector<HTMLElement>('[data-preview-markdown]')

        if (!rendered) {
          throw new Error(t.artifactShare.previewNotReady)
        }

        content = await captureRenderedHtml(rendered, name)
      } else if (format === 'docx') {
        content = snapshot()
      }

      const result = await window.hermesDesktop.exportPreview({ format, name, content })

      if (result.status === 'failed') {
        throw new Error(t.preview.exportFailed)
      }
    } catch {
      notifyError(new Error(t.preview.exportFailed), t.preview.exportFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <Tip label={t.preview.saveAs}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={t.preview.saveAs}
            disabled={busy || disabled}
            loading={busy}
            size="icon-xs"
            variant="ghost"
          >
            <Download aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        {(['md', 'pdf', 'docx'] as const).map(format => (
          <DropdownMenuItem key={format} onSelect={() => void save(format)}>
            {t.preview.exportFormats[format]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
