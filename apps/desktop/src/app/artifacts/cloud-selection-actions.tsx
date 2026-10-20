import { IconFolderSymlink, IconMessageCirclePlus } from '@tabler/icons-react'

import type { DriveAsset, DriveCapabilities } from '@/api/drive'
import { ActionsMenu, renderActionItem } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Download, MoreHorizontal, Trash2, X } from '@/lib/icons'

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
  const { cloudLibrary: copy, localArtifacts } = useI18n().t

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
      className="ml-auto flex h-8 w-max shrink-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-xs @max-[80rem]/drive:max-w-56 @max-[80rem]/drive:gap-1 @max-[42rem]/drive:w-40 @max-[30rem]/drive:w-auto"
      role="group"
    >
      <span
        aria-live="polite"
        className="min-w-0 truncate whitespace-nowrap @max-[30rem]/drive:sr-only"
        title={copy.selectedCount(assets.length)}
      >
        {copy.selectedCount(assets.length)}
      </span>
      <Tip label={copy.clearSelection}>
        <Button
          aria-label={copy.clearSelection}
          disabled={busy}
          onClick={actions.onClear}
          size="icon-xs"
          variant="ghost"
        >
          <X />
        </Button>
      </Tip>
      {buttons
        .filter(button => button.show)
        .map(({ label, icon: Icon, disabled, action }) => (
          <Tip key={label} label={label}>
            <span className="flex @max-[42rem]/drive:hidden">
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
            </span>
          </Tip>
        ))}
      {buttons.some(button => button.show) && (
        <div className="hidden @max-[42rem]/drive:block">
          <ActionsMenu
            items={kit =>
              buttons
                .filter(button => button.show)
                .map(({ label, icon: Icon, disabled, action }) =>
                  renderActionItem(kit, {
                    label,
                    iconNode: <Icon aria-hidden="true" />,
                    disabled: busy || disabled,
                    onSelect: action
                  })
                )
            }
          >
            <Button
              aria-label={`${localArtifacts.more} · ${copy.selectionActions}`}
              disabled={busy}
              size="icon-xs"
              variant="ghost"
            >
              <MoreHorizontal />
            </Button>
          </ActionsMenu>
        </div>
      )}
    </div>
  )
}
