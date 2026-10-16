import { IconFolderSymlink, IconMessageCirclePlus } from '@tabler/icons-react'

import type { DriveAsset, DriveCapabilities } from '@/api/drive'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Download, Trash2, X } from '@/lib/icons'

interface CloudSelectionActionsProps {
  assets: readonly DriveAsset[]
  capabilities: DriveCapabilities | null
  busy: boolean
  canMove: boolean
  onClear: () => void
  onAdd: () => void
  onDownload: () => void
  onMove: () => void
  onTrash: () => void
}

/** 对齐原版多选：纯文件允许添加、下载和移动；混合选择只提供有权限的删除。 */
export function CloudSelectionActions({ assets, capabilities, busy, canMove, ...actions }: CloudSelectionActionsProps) {
  const { cloudLibrary: copy } = useI18n().t

  if (!assets.length) {
    return null
  }

  const files = assets.every(asset => asset.kind === 'file' && asset.permissions?.read !== false)

  const buttons = [
    {
      label: copy.addToDraft,
      icon: IconMessageCirclePlus,
      show: files && capabilities?.download,
      disabled: false,
      action: actions.onAdd
    },
    {
      label: copy.download,
      icon: Download,
      show: files && capabilities?.download,
      disabled: false,
      action: actions.onDownload
    },
    {
      label: copy.move,
      icon: IconFolderSymlink,
      show: files && capabilities?.move && assets.every(asset => asset.permissions?.write !== false),
      disabled: !canMove,
      action: actions.onMove
    },
    {
      label: copy.trash,
      icon: Trash2,
      show: capabilities?.trash && assets.every(asset => asset.permissions?.delete !== false),
      disabled: false,
      action: actions.onTrash
    }
  ]

  return (
    <div
      aria-label={copy.selectionActions}
      className="ml-auto flex h-8 shrink-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-xs"
      role="group"
    >
      <span aria-live="polite">{copy.selectedCount(assets.length)}</span>
      <Button aria-label={copy.clearSelection} disabled={busy} onClick={actions.onClear} size="sm" variant="ghost">
        <X />
        {copy.clearSelection}
      </Button>
      {buttons
        .filter(button => button.show)
        .map(({ label, icon: Icon, disabled, action }) => (
          <Tip key={label} label={label}>
            <Button
              aria-label={label}
              className={label === copy.trash ? 'text-destructive' : undefined}
              disabled={busy || disabled}
              onClick={action}
              size="icon-xs"
              variant="ghost"
            >
              <Icon aria-hidden="true" />
            </Button>
          </Tip>
        ))}
    </div>
  )
}
