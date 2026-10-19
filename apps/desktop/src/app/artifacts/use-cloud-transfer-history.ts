import { useCallback, useState } from 'react'

import type {
  CloudDriveTransferProgress,
  CloudDriveTransferRequest,
  CloudDriveTransferResult
} from '../../../electron/login/contract'

import { type DriveTransferRecord, isDriveTransferActive } from './cloud-transfer-copy'

/** 传输记录只属于当前页面，关闭浮窗保留任务，离页后由传输控制器取消。 */
export function useCloudTransferHistory() {
  const [records, setRecords] = useState<DriveTransferRecord[]>([])
  const [open, setOpen] = useState(false)

  /** 上传及下载才进入传输浮窗，预览准备由右侧预览入口负责。 */
  function begin(input: CloudDriveTransferRequest, name: string): void {
    if (input.operation === 'preview') {
      return
    }

    const files =
      input.operation === 'download-many'
        ? input.assets
        : [{ name: 'name' in input ? input.name : name, size: 'size' in input ? input.size : null }]

    setRecords(old => [
      ...old,
      ...files.map((file, index): DriveTransferRecord => ({
        batchId: input.id,
        index,
        name: file.name,
        operation: input.operation === 'download-many' ? 'download' : input.operation,
        state: 'waiting',
        completed: 0,
        total: file.size ?? null
      }))
    ])
    setOpen(true)
  }

  /** 只更新对应批次的当前文件，逐项完成事件不能推断未开始文件已经成功。 */
  const progress = useCallback(function updateProgress(value: CloudDriveTransferProgress): void {
    const index = (value.fileIndex ?? 1) - 1
    setRecords(old =>
      old.map(record =>
        record.batchId === value.id && record.index === index
          ? {
              ...record,
              name: value.name || record.name,
              completed: value.completed,
              total: value.total,
              state: value.fileStatus || value.phase || (record.operation === 'upload' ? 'uploading' : 'downloading')
            }
          : record
      )
    )
  }, [])

  /** 原生最终结果逐项覆盖，预览成功或取消选择不留下传输成功提示。 */
  function finish(id: string, result: CloudDriveTransferResult, silent = false): void {
    if (silent || (result.status === 'succeeded' && result.preview)) {
      setRecords(old => old.filter(record => record.batchId !== id))
      setOpen(false)

      return
    }

    setRecords(old =>
      old.map(record => {
        if (record.batchId !== id) {
          return record
        }

        const file = result.files?.find(file => file.index === record.index)

        return {
          ...record,
          name:
            file?.name ||
            (result.status === 'succeeded' && !result.files && old.filter(item => item.batchId === id).length === 1
              ? result.name
              : record.name),
          state: file?.status || result.status,
          code: file?.code || ('code' in result ? result.code : undefined)
        }
      })
    )
  }

  /** 只清理已结束的记录，不取消任务、不重试或再发业务请求。 */
  function clearFinished(): void {
    setRecords(old => old.filter(isDriveTransferActive))
    setOpen(false)
  }

  return { records, open, setOpen, begin, progress, finish, clearFinished }
}
