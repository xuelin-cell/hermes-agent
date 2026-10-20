import { useState } from 'react'

import { ActionsMenu, renderActionItem } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { FileImage, FileText, FolderOpen, MessageCirclePlus, MoreHorizontal, Share2, Star, Upload } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type LocalArtifact, localArtifactSize, localArtifactType } from './local-artifact-model'
import { LocalArtifactShareDialog } from './local-artifact-share-dialog'
import { useLocalArtifactShare } from './use-local-artifact-share'

interface LocalArtifactRowProps {
  file: LocalArtifact
  favorite: boolean
  uploaded: boolean
  busy: boolean
  canShare: boolean
  shareOpen?: boolean
  onShareClose?: () => void
  wide?: boolean
  onOpen: () => void
  onAdd: () => void
  onFavorite: () => void
  onUpload: () => void
  onFolder: () => void
  onShare: () => void
}

/** 文件行的直接按钮与更多菜单共用同一组操作，文件本身不提供删除入口。 */
export function LocalArtifactRow({
  file,
  favorite,
  uploaded,
  busy,
  canShare,
  shareOpen = false,
  onShareClose = () => undefined,
  wide = false,
  onOpen,
  onAdd,
  onFavorite,
  onUpload,
  onFolder,
  onShare
}: LocalArtifactRowProps) {
  const { localArtifacts: copy, cloudLibrary, rightSidebar } = useI18n().t
  const [menuOpen, setMenuOpen] = useState(false)
  const publishable = useLocalArtifactShare(file, wide || menuOpen || shareOpen, canShare)
  const icon = localArtifactType(file) === 'image' ? FileImage : FileText
  const Icon = icon

  const actions = [
    ...(publishable
      ? [
          {
            label: copy.share,
            iconNode: <Share2 />,
            onSelect: onShare,
            disabled: busy || shareOpen || !file.resolvedPath
          }
        ]
      : []),
    {
      label: uploaded ? copy.uploaded : cloudLibrary.uploadArtifact,
      iconNode: <Upload />,
      onSelect: onUpload,
      disabled: !file.resolvedPath || busy || uploaded
    },
    {
      label: rightSidebar.openFolder,
      iconNode: <FolderOpen />,
      onSelect: onFolder,
      disabled: busy || !file.resolvedPath
    }
  ]

  return (
    <div className="flex min-h-8 items-center gap-2 py-0.5 text-sm hover:bg-accent/30">
      <Tip label={favorite ? copy.unfavorite : copy.favorite}>
        <Button
          aria-label={`${favorite ? copy.unfavorite : copy.favorite} · ${file.label}`}
          aria-pressed={favorite}
          disabled={!file.resolvedPath}
          onClick={onFavorite}
          size="icon-sm"
          variant="ghost"
        >
          <Star className={cn(favorite && 'fill-current text-primary')} />
        </Button>
      </Tip>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <button
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left focus-visible:outline-ring"
          onClick={onOpen}
          type="button"
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{file.label}</span>
        </button>
        <Button
          aria-label={`${copy.addToChat} · ${file.label}`}
          className="shrink-0"
          disabled={busy || !file.resolvedPath}
          onClick={onAdd}
          size="icon-sm"
          variant="ghost"
        >
          <MessageCirclePlus />
        </Button>
      </div>
      <span className={cn('w-12 shrink-0 truncate text-xs text-muted-foreground', !wide && 'hidden')}>
        {file.label.includes('.') ? file.label.split('.').pop()?.toUpperCase() : copy.other}
      </span>
      <span className={cn('w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground', !wide && 'hidden')}>
        {localArtifactSize(file.byteSize)}
      </span>
      <div className="shrink-0">
        {wide ? (
          <div className="ml-4 grid w-28 shrink-0 grid-cols-3 items-center gap-1">
            {!publishable && <span aria-hidden="true" />}
            {actions.map(action => {
              const button = (
                <Button
                  aria-label={`${action.label} · ${file.label}`}
                  disabled={action.disabled}
                  onClick={action.onSelect}
                  size="icon-sm"
                  variant="ghost"
                >
                  {action.iconNode}
                </Button>
              )

              return (
                <Tip key={action.label} label={action.label}>
                  {button}
                </Tip>
              )
            })}
          </div>
        ) : (
          <ActionsMenu
            items={kit => actions.map(action => renderActionItem(kit, action))}
            onCloseAutoFocus={event => {
              if (shareOpen) {
                event.preventDefault()
              }
            }}
            onOpenChange={setMenuOpen}
            open={menuOpen}
          >
            <Button aria-label={`${copy.more} · ${file.label}`} size="icon-sm" variant="ghost">
              <MoreHorizontal />
            </Button>
          </ActionsMenu>
        )}
      </div>
      {shareOpen && <LocalArtifactShareDialog file={file} onClose={onShareClose} />}
    </div>
  )
}
