import type {
  CloudDriveTransferProgress,
  CloudDriveTransferRequest,
  CloudDriveTransferResult
} from '../../../electron/login/contract'

import type { DriveTransferRecord } from './cloud-transfer-copy'

/** 预览不记入传输列表，上传和批量下载只创建各自批次的文件记录。 */
export function beginTransferRecords(
  records: DriveTransferRecord[],
  input: CloudDriveTransferRequest,
  name: string
): DriveTransferRecord[] {
  if (input.operation === 'preview') {
    return records
  }

  const files =
    input.operation === 'download-many'
      ? input.assets
      : [{ name: 'name' in input ? input.name : name, size: 'size' in input ? input.size : null }]

  return [
    ...records,
    ...files.map((file, index): DriveTransferRecord => ({
      batchId: input.id,
      index,
      name: file.name,
      operation: input.operation === 'download-many' ? 'download' : input.operation,
      state: 'waiting',
      completed: 0,
      total: file.size ?? null
    }))
  ]
}

/** 只接受对应批次和文件的进度，不从已完成文件推断整个批次成功。 */
export function progressTransferRecords(
  records: DriveTransferRecord[],
  value: CloudDriveTransferProgress
): DriveTransferRecord[] {
  const index = (value.fileIndex ?? 1) - 1

  return records.map(record =>
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
}

/** 逐项采用原生终态；取消选择移除当前批次，结果未知不得显示为成功。 */
export function finishTransferRecords(
  records: DriveTransferRecord[],
  id: string,
  result: CloudDriveTransferResult,
  silent: boolean
): DriveTransferRecord[] {
  if (silent || (result.status === 'succeeded' && result.preview)) {
    return records.filter(record => record.batchId !== id)
  }

  return records.map(record => {
    if (record.batchId !== id) {
      return record
    }
    const file = result.files?.find(file => file.index === record.index)

    return {
      ...record,
      name:
        file?.name ||
        (result.status === 'succeeded' && !result.files && records.filter(item => item.batchId === id).length === 1
          ? result.name
          : record.name),
      state: file?.status || result.status,
      code: file?.code || ('code' in result ? result.code : undefined)
    }
  })
}
