import { IconFolderSymlink, IconMessageCirclePlus } from '@tabler/icons-react'

import type { DriveAsset, DriveCapabilities } from '@/api/drive'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Download, Pencil, Trash2 } from '@/lib/icons'

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
  const { cloudLibrary: copy } = useI18n().t
  const file = asset.kind === 'file'
  const read = asset.permissions?.read !== false
  const write = asset.permissions?.write !== false

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
      icon: IconFolderSymlink,
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
      label: copy.addToDraft,
      icon: IconMessageCirclePlus,
      show: file,
      disabled: !capabilities?.download || !read,
      action: actions.onAdd
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
      <CloudFileName
        disabled={busy || !read || (file && !capabilities?.download)}
        kind={asset.kind}
        name={asset.name}
        onOpen={() => actions.onOpen()}
      />
      {buttons
        .filter(button => button.show)
        .map(({ label, icon: Icon, disabled, action }) => (
          <Tip key={label} label={label}>
            <Button aria-label={label} disabled={busy || disabled} onClick={action} size="icon-xs" variant="ghost">
              <Icon aria-hidden="true" />
            </Button>
          </Tip>
        ))}
    </CloudFileRow>
  )
}
