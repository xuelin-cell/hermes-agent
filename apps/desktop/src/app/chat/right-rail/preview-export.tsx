import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'

/** Markdown 的三个另存为出口共享当前原文或渲染快照，不改写源文件。 */
export function PreviewExportControls({
  name,
  text,
  snapshot,
  disabled
}: {
  name: string
  text: string
  snapshot: () => string
  disabled: boolean
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  /** 只有显式点击才捕获内容和选择保存位置；取消不提示失败。 */
  async function save(format: 'md' | 'pdf' | 'docx') {
    if (busy) {
      return
    }

    setBusy(true)

    try {
      const content = format === 'md' ? text : snapshot()
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
      <DropdownMenuTrigger asChild>
        <Button disabled={busy || disabled} size="xs" variant="ghost">
          {busy ? t.common.saving : t.preview.saveAs}
        </Button>
      </DropdownMenuTrigger>
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
