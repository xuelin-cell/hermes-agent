import { useState } from 'react'

import type { DriveAsset, DriveSpace } from '@/api/drive'
import { moveDriveFile } from '@/api/drive-file-management'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useI18n } from '@/i18n'

import { driveFolderPath } from './drive-directory-index'
import { DriveFolderPicker } from './drive-folder-picker'
import { driveMutationMessage, useDriveMutation } from './use-drive-mutation'

interface DriveMoveDialogProps {
  asset: DriveAsset | readonly DriveAsset[]
  space: DriveSpace
  items: DriveAsset[]
  complete: boolean
  onClose: () => void
  onChanged: () => void
}

/** 文件移动弹窗使用现有索引浏览目录，不新增第二套网络扫描。 */
export function DriveMoveDialog({ asset, space, items, complete, onClose, onChanged }: DriveMoveDialogProps) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const assets = 'asset_id' in asset ? [asset] : asset
  const [parent, setParent] = useState(space.root_asset_id)
  const { busy, failure, uncertain, run } = useDriveMutation()
  const path = driveFolderPath(items, space.root_asset_id, parent)
  const target = items.find(item => item.asset_id === parent)

  const canMove =
    complete &&
    path !== null &&
    assets.every(item => parent !== item.parent_asset_id) &&
    target?.permissions?.write !== false

  /** 不确定操作离开弹窗前触发读取刷新，避免直接重用旧目录信息。 */
  function close(): void {
    if (busy) {
      return
    }

    if (uncertain) {
      onChanged()
    }

    onClose()
  }

  /** 用户确认成功后刷新目录；不确定结果只提供读取刷新，不重发移动。 */
  function submit(): void {
    if (!canMove || busy || uncertain) {
      return
    }

    void run(
      () => moveDriveFile(asset, parent),
      () => {
        onChanged()
        onClose()
      }
    )
  }

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          close()
        }
      }}
      open
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{copy.moveTitle}</DialogTitle>
          <DialogDescription>{copy.moveHint(assets.length)}</DialogDescription>
        </DialogHeader>
        <DriveFolderPicker
          complete={complete}
          disabled={busy || uncertain}
          items={items}
          onNavigate={setParent}
          parent={parent}
          path={path}
          root={space.root_asset_id}
        />
        {failure !== null && <p role="alert">{driveMutationMessage(failure, copy)}</p>}
        <DialogFooter>
          <Button disabled={busy} onClick={close} variant="ghost">
            {t.common.cancel}
          </Button>
          {uncertain ? (
            <Button onClick={close}>{copy.refresh}</Button>
          ) : (
            <Button disabled={busy || !canMove} onClick={submit}>
              {busy ? t.common.loading : t.common.confirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
