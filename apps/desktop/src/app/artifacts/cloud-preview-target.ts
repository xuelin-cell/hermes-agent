import type { DriveAsset } from '@/api/drive'
import { registerDesktopPreviewFile } from '@/lib/desktop-preview-files'
import type { PreviewTarget } from '@/store/preview'

import type { CloudDriveTransferResult } from '../../../electron/login/contract'

/** 云盘只提供受控下载的原文件，格式元信息由已有原生规范化入口决定。 */
export async function cloudPreviewTarget(
  spaceId: string,
  asset: DriveAsset,
  result: Extract<CloudDriveTransferResult, { status: 'succeeded' }>
): Promise<PreviewTarget | null> {
  const preview = result.preview

  if (!preview || preview.kind !== 'file') {
    return null
  }

  const bridge = window.hermesDesktop
  const target = await bridge.normalizePreviewTarget(preview.path)

  if (!target || target.kind !== 'file' || bridge !== window.hermesDesktop) {
    return null
  }

  registerDesktopPreviewFile(target.path || preview.path)

  return {
    ...target,
    label: asset.name,
    source: `cloud-drive://${encodeURIComponent(spaceId)}/${encodeURIComponent(asset.asset_id)}/${encodeURIComponent(asset.name)}`,
    shareOrigin: null
  }
}
