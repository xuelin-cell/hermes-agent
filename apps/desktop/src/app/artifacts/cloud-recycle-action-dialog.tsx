import {
  type DriveRecycleItem,
  emptyDriveRecycle,
  permanentlyDeleteDriveItem,
  restoreDriveItem
} from '@/api/drive-file-management'
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

import { driveMutationMessage, useDriveMutation } from './use-drive-mutation'

export type RecycleAction = { kind: 'restore' | 'delete'; item: DriveRecycleItem } | { kind: 'empty' }

/** 恢复、彻底删除及清空共用一次确认；未知结果只允许刷新核对，不能再次发出写请求。 */
export function CloudRecycleActionDialog({
  action,
  onClose,
  onChanged
}: {
  action: RecycleAction
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const { busy, failure, uncertain, run } = useDriveMutation()

  const title =
    action.kind === 'restore' ? copy.restore : action.kind === 'delete' ? copy.permanentDelete : copy.emptyRecycle

  const hint =
    action.kind === 'restore'
      ? copy.restoreHint
      : action.kind === 'delete'
        ? copy.permanentDeleteHint
        : copy.emptyRecycleHint

  /** 关闭未知结果时先读取服务最新状态，不能让旧条目继续被提交。 */
  function close(): void {
    if (busy) {
      return
    }

    if (uncertain) {
      onChanged()
    }

    onClose()
  }

  /** 使用捕获的删除编号或个人清空接口，每次点击只执行一个写操作。 */
  function submit(): void {
    void run(
      () =>
        action.kind === 'empty'
          ? emptyDriveRecycle()
          : action.kind === 'delete'
            ? permanentlyDeleteDriveItem(action.item)
            : restoreDriveItem(action.item),
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
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {action.kind !== 'empty' && <p className="truncate">{action.item.name}</p>}
        <DialogDescription>{hint}</DialogDescription>
        {failure !== null && <p role="alert">{driveMutationMessage(failure, copy)}</p>}
        <DialogFooter>
          <Button disabled={busy} onClick={close} variant="ghost">
            {t.common.cancel}
          </Button>
          {uncertain ? (
            <Button onClick={close}>{copy.refresh}</Button>
          ) : (
            <Button disabled={busy} onClick={submit} variant={action.kind === 'restore' ? 'default' : 'destructive'}>
              {busy ? t.common.loading : title}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
