import type { createOfficePreviewService } from '../office-preview/service'

import { CloudDriveOperationError } from './cloud-drive'

export const CLOUD_DRIVE_PREVIEW_BYTES = 16 * 1024 * 1024

export type CloudDriveOfficePreview = (
  filePath: string,
  signal: AbortSignal
) => Promise<{ kind: 'pdf'; dataUrl: string }>

const FAILURE_CODES: Record<string, string> = {
  too_large: 'PREVIEW_TOO_LARGE',
  unsupported: 'PREVIEW_UNSUPPORTED',
  unavailable: 'OFFICE_PREVIEW_UNAVAILABLE',
  timeout: 'OFFICE_PREVIEW_TIMEOUT'
}

/** 云盘只传入已完整下载的账号临时文件，复用正式转换器及其账号缓存，不借用 Agent 文件接口。 */
export function createCloudDriveOfficePreview(
  service: ReturnType<typeof createOfficePreviewService>
): CloudDriveOfficePreview {
  return async (filePath, signal) => {
    signal.throwIfAborted()
    const result = await service.convert(filePath, signal)
    signal.throwIfAborted()

    if (result.ok === false) {
      throw new CloudDriveOperationError('failed', FAILURE_CODES[result.code] || 'OFFICE_PREVIEW_FAILED')
    }

    // 云盘跨 IPC 的预览统一限制为 16 MiB，转换后的 PDF 同样不能绕过。
    if (result.pdf.byteLength > CLOUD_DRIVE_PREVIEW_BYTES) {
      throw new CloudDriveOperationError('failed', 'PREVIEW_TOO_LARGE')
    }

    return { kind: 'pdf', dataUrl: `data:application/pdf;base64,${Buffer.from(result.pdf).toString('base64')}` }
  }
}
