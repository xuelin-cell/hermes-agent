import type { DriveAsset } from '@/api/drive'
import { fmtDateTime } from '@/lib/time'

import { driveBytes } from './use-drive-usage'

export type CloudFileSort = 'default' | 'asc' | 'desc'

/** 缺失或无效修改时间保留未知状态，不借用创建时间。 */
export function cloudModifiedTime(asset: DriveAsset): number | null {
  const time = asset.modified_at ? Date.parse(asset.modified_at) : NaN

  return Number.isFinite(time) ? time : null
}

/** 文件夹不伪造容量，非法文件大小与缺失元信息统一显示破折号。 */
export function cloudFileSize(asset: DriveAsset): string {
  const size = asset.size_bytes

  return asset.kind === 'file' && typeof size === 'number' && Number.isFinite(size) && size >= 0
    ? driveBytes(size)
    : '—'
}

/** 使用 Hermes 的共享时间格式，列表与其他页面保持一致。 */
export function cloudFileModified(asset: DriveAsset): string {
  const time = cloudModifiedTime(asset)

  return time === null ? '—' : fmtDateTime.format(new Date(time))
}

/** 默认保留服务顺序并优先文件夹；时间排序覆盖全部结果再分页，同时间保持原顺序。 */
export function sortCloudFiles(items: readonly DriveAsset[], sort: CloudFileSort): DriveAsset[] {
  return [...items].sort((left, right) => {
    const kind = Number(right.kind === 'directory') - Number(left.kind === 'directory')

    if (kind || sort === 'default') {
      return kind
    }

    const direction = sort === 'asc' ? 1 : -1

    const a = cloudModifiedTime(left)
    const b = cloudModifiedTime(right)

    if (a === null || b === null) {
      return a === b ? 0 : a === null ? 1 : -1
    }

    return (a - b) * direction
  })
}
