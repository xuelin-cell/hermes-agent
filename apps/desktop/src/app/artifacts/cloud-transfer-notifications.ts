import type { Translations } from '@/i18n/types'
import { notify } from '@/store/notifications'

import type { CloudDriveTransferRequest, CloudDriveTransferResult } from '../../../electron/login/contract'

import { driveTransferFailure } from './cloud-transfer-copy'

/** 结果在窗口内通知一次；仅业务成功才显示保存成功，未知写结果保留核对提示。 */
export function announceCloudTransfer(
  input: CloudDriveTransferRequest,
  value: CloudDriveTransferResult,
  t: Translations
): void {
  if (value.status === 'succeeded' && value.preview) {
    return
  }
  const copy = t.cloudLibrary
  const operation = input.operation === 'download-many' ? 'download' : input.operation
  let message: string

  if (value.status === 'succeeded') {
    message =
      input.operation === 'upload'
        ? copy.uploadSaved(value.name)
        : input.operation === 'download-many'
          ? copy.downloadsSaved(
              value.files?.filter(file => file.status === 'succeeded').length ?? input.assets.length,
              value.files?.filter(file => file.status === 'cancelled').length ?? 0
            )
          : copy.downloadSaved(value.name)
  } else if (value.status === 'cancelled') {
    message = operation === 'upload' ? copy.transferUploadStopped : copy.transferCancelled
  } else {
    message = driveTransferFailure(value.status, value.code, operation, copy)
  }

  notify({
    id: `drive-transfer-${input.id}`,
    title: copy.transfers,
    message,
    kind:
      value.status === 'succeeded'
        ? 'success'
        : value.status === 'cancelled'
          ? 'info'
          : value.status === 'failed'
            ? 'error'
            : 'warning'
  })
}
