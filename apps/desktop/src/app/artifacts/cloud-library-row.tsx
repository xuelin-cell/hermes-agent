import type { DriveAsset, DriveCapabilities } from '@/api/drive'
import { ActionsMenu, renderActionItem } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Download, FolderSymlink, MessageCirclePlus, MoreHorizontal, Pencil, Trash2 } from '@/lib/icons'

import { cloudFileModified, cloudFileSize } from './cloud-file-metadata'
import { CloudFileName, CloudFileRow } from './cloud-file-row'

interface CloudLibraryRowProps {
  asset: DriveAsset
  capabilities: DriveCapabilities | null
  selected: boolean
  busy: boolean
  canMove: boolean
  onToggle: () => void
  onOpen: (download?: boolean) => void
  onRename: () => void
  onMove: () => void
  onTrash: () => void
  onAdd: () => void
}

/** 勾选框只改变选择，打开文件和各项操作仍使用原始业务 ID 及服务权限。 */
export function CloudLibraryRow({ asset, capabilities, selected, busy, canMove, ...actions }: CloudLibraryRowProps) {
  const { cloudLibrary: copy, localArtifacts } = useI18n().t
  const file = asset.kind === 'file'
  const read = asset.permissions?.read !== false
  const write = asset.permissions?.write !== false
  const modified = cloudFileModified(asset)

  const buttons = [
    {
      label: copy.rename,
      icon: Pencil,
      show: true,
      disabled: !capabilities?.rename || !write,
      action: actions.onRename
    },
    {
      label: copy.move,
      icon: FolderSymlink,
      show: file,
      disabled: !capabilities?.move || !write || !canMove,
      action: actions.onMove
    },
    {
      label: copy.trash,
      icon: Trash2,
      show: true,
      disabled: !capabilities?.trash || asset.permissions?.delete === false,
      action: actions.onTrash
    },
    {
      label: copy.download,
      icon: Download,
      show: file,
      disabled: !capabilities?.download || !read,
      action: () => actions.onOpen(true)
    }
  ]

  return (
    <CloudFileRow
      leading={
        <Checkbox
          aria-label={copy.selectItem(asset.name)}
          checked={selected}
          disabled={busy}
          onCheckedChange={actions.onToggle}
        />
      }
      name={asset.name}
    >
      <div className="flex min-w-0 flex-1 items-center gap-x-4 @max-[42rem]/drive:flex-wrap">
        <div className="flex min-w-0 flex-[0_1_28rem] items-center gap-1 @max-[42rem]/drive:flex-1">
          <CloudFileName
            className="flex-initial"
            disabled={busy || !read || (file && !capabilities?.download)}
            kind={asset.kind}
            name={asset.name}
            onOpen={() => actions.onOpen()}
          />
          {file && (
            <Tip label={copy.addToDraft}>
              <Button
                aria-label={copy.addToDraft}
                disabled={busy || !capabilities?.download || !read}
                onClick={actions.onAdd}
                size="icon-xs"
                variant="ghost"
              >
                <MessageCirclePlus aria-hidden="true" />
              </Button>
            </Tip>
          )}
        </div>
        <div className="grid min-w-72 flex-1 grid-cols-[5rem_minmax(1.5rem,1fr)_10rem_minmax(1.5rem,1fr)] items-center text-xs text-muted-foreground @max-[42rem]/drive:flex @max-[42rem]/drive:min-w-0 @max-[42rem]/drive:basis-full @max-[42rem]/drive:gap-x-2 @max-[42rem]/drive:pl-3">
          <span className="w-20 shrink-0 text-right tabular-nums @max-[42rem]/drive:w-auto @max-[42rem]/drive:text-left">
            {cloudFileSize(asset)}
          </span>
          <span
            className="col-start-3 w-40 max-w-full shrink-0 truncate tabular-nums @max-[42rem]/drive:w-auto"
            title={modified}
          >
            {modified}
          </span>
        </div>
      </div>
      <div className="flex w-40 shrink-0 justify-end gap-2 @max-[42rem]/drive:hidden">
        {buttons
          .filter(button => button.show)
          .map(({ label, icon: Icon, disabled, action }) => (
            <Tip key={label} label={label}>
              <Button aria-label={label} disabled={busy || disabled} onClick={action} size="icon-xs" variant="ghost">
                <Icon aria-hidden="true" />
              </Button>
            </Tip>
          ))}
      </div>
      <div className="hidden shrink-0 @max-[42rem]/drive:block">
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
          <Button aria-label={`${localArtifacts.more} · ${asset.name}`} size="icon-xs" variant="ghost">
            <MoreHorizontal />
          </Button>
        </ActionsMenu>
      </div>
    </CloudFileRow>
  )
}
