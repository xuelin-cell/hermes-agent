import { type DriveAsset, driveRequest } from './drive'

export interface DriveRecycleItem {
  deleteNo: string
  name: string
  kind: DriveAsset['kind']
  size: number | null
  deletedAt: string | null
}

export const DRIVE_RECYCLE_PAGE_SIZE = 50

/** 联通紧凑时间按北京时间解释，避免跟随运行电脑时区产生偏移。 */
function recycleTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return null
  }

  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(value)

  const text = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6] || '00'}+08:00`
    : value

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return null
  }

  const [year, month, day] = text.slice(0, 10).split('-').map(Number)
  const date = new Date(text)

  if (
    !Number.isFinite(date.getTime()) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) {
    return null
  }

  return date.toISOString()
}

/** 回收站使用删除操作编号 deleteNo，不能用原文件 ID 代替恢复目标。 */
export function parseRecycleItems(value: unknown): DriveRecycleItem[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid recycle response')
  }

  return value.map(row => {
    if (
      !row ||
      typeof row.deleteNo !== 'string' ||
      !row.deleteNo ||
      typeof row.name !== 'string' ||
      !['0', '1'].includes(String(row.type))
    ) {
      throw new Error('Invalid recycle item')
    }

    const size = row.fileSize == null || row.fileSize === '' ? NaN : Number(row.fileSize)

    return {
      deleteNo: row.deleteNo,
      name: row.name,
      kind: String(row.type) === '0' ? 'directory' : 'file',
      size: String(row.type) === '1' && Number.isFinite(size) && size >= 0 ? size : null,
      deletedAt: recycleTime(row.deleteTime)
    }
  })
}

/** 逐页读取回收站，只在页面明确加载下一页时继续。 */
export async function listDriveRecycle(page: number): Promise<DriveRecycleItem[]> {
  return parseRecycleItems(
    await driveRequest('/unicom/QueryRecycleData', 'POST', {
      pageNo: page,
      pageSize: DRIVE_RECYCLE_PAGE_SIZE,
      sortRule: '0'
    })
  )
}

/** 将单个回收站项目恢复到云盘服务记录的原位置，不自动重试。 */
export function restoreDriveItem(item: DriveRecycleItem): Promise<unknown> {
  return driveRequest('/unicom/ReductionRecycleData', 'POST', { deleteNos: [item.deleteNo] })
}

/** 个人回收站按删除操作号彻底删除一项，不能使用原文件 ID 或项目空间参数。 */
export function permanentlyDeleteDriveItem(item: DriveRecycleItem): Promise<unknown> {
  return driveRequest('/unicom/DeleteRecycleData', 'POST', { deleteNos: [item.deleteNo] })
}

/** 个人回收站清空接口只接收空对象；空间由服务个人入口决定。 */
export function emptyDriveRecycle(): Promise<unknown> {
  return driveRequest('/unicom/EmptyRecycleData', 'POST', {})
}

/** 对齐源版本只移动文件的行为，保持原始文件 ID 和目标目录 ID。 */
export function moveDriveFile(source: DriveAsset | readonly DriveAsset[], destination: string): Promise<unknown> {
  const assets = 'asset_id' in source ? [source] : source

  if (
    !assets.length ||
    assets.some(
      asset => asset.kind !== 'file' || asset.permissions?.write === false || destination === asset.parent_asset_id
    ) ||
    !destination ||
    assets.some(asset => !asset.asset_id)
  ) {
    throw new Error('Invalid move destination')
  }

  return driveRequest('/assets/move', 'POST', {
    file_ids: [...new Set(assets.map(asset => asset.asset_id))],
    directory_ids: [],
    target_parent_asset_id: destination
  })
}
