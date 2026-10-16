import type { Translations } from '@/i18n/types'

export type TransferOperation = 'upload' | 'download' | 'preview'
export type TransferState =
  | 'waiting'
  | 'uploading'
  | 'downloading'
  | 'verifying'
  | 'converting'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'partial_success'
  | 'outcome_unknown'
  | 'not_started'

export interface DriveTransferRecord {
  batchId: string
  index: number
  operation: TransferOperation
  name: string
  state: TransferState
  completed: number
  total: number | null
  code?: string
}

/** 正在执行或等待的记录不能被清除，停止后仍等原生端返回最终状态。 */
export function isDriveTransferActive(record: DriveTransferRecord): boolean {
  return ['waiting', 'uploading', 'downloading', 'verifying', 'converting'].includes(record.state)
}

/** 按固定错误码选用原数字员工场景文案，不展示上游原文或凭据。 */
export function driveTransferFailure(
  status: string,
  code: string | undefined,
  operation: TransferOperation,
  copy: Translations['cloudLibrary']
): string {
  if (status === 'outcome_unknown') {
    return operation === 'upload' ? copy.transferUnknown : copy.operationUnknown
  }

  if (status === 'partial_success') {
    return operation === 'download' ? copy.transferDownloadPartial : copy.operationPartial
  }

  const specific: Record<string, string> = {
    PREVIEW_UNSUPPORTED: copy.previewUnsupported,
    PREVIEW_TOO_LARGE: copy.previewTooLarge,
    OFFICE_PREVIEW_UNAVAILABLE: copy.officePreviewUnavailable,
    OFFICE_PREVIEW_TIMEOUT: copy.officePreviewTimeout,
    OFFICE_PREVIEW_FAILED: copy.officePreviewFailed,
    ARTIFACT_SOURCE_REMOTE: copy.artifactRemote,
    ARTIFACT_SOURCE_INVALID: copy.artifactUnavailable,
    ARTIFACT_NOT_REFERENCED: copy.artifactUnavailable,
    ARTIFACT_SOURCE_BLOCKED: copy.artifactSensitive,
    FILE_CHANGED: copy.artifactChanged
  }

  return specific[code || ''] || copy.transferErrors[code || ''] || copy.transferFailed
}

/** 状态标签由当前语言即时计算，未知结果不得显示为已保存或百分之百成功。 */
export function driveTransferText(
  record: DriveTransferRecord,
  copy: Translations['cloudLibrary'],
  converting: string
): string {
  const states: Partial<Record<TransferState, string>> = {
    waiting: copy.transferWaiting,
    uploading: copy.transferUploading,
    downloading: record.operation === 'preview' ? copy.transferPreparingPreview : copy.transferDownloading,
    verifying: copy.transferVerifying,
    converting,
    succeeded: record.operation === 'upload' ? copy.uploaded : copy.downloaded,
    cancelled: record.operation === 'upload' ? copy.transferUploadStopped : copy.transferCancelled,
    not_started: copy.transferNotStarted
  }

  return states[record.state] || driveTransferFailure(record.state, record.code, record.operation, copy)
}
