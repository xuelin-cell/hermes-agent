import { type CloudDriveFailure, isCloudDriveReadOperation } from '../../electron/login/contract'

/** 保留跨 IPC 的操作状态，供页面决定是否需要先刷新确认结果。 */
export class DriveOperationError extends Error {
  /** 错误码只用于界面选择提示，不包含上游服务原文。 */
  constructor(
    readonly status: CloudDriveFailure['status'],
    readonly code: string
  ) {
    super('个人云盘操作未完成，请刷新重试')
  }
}

export interface DriveAsset {
  asset_id: string
  fid?: string
  name: string
  kind: 'directory' | 'file'
  parent_asset_id?: string | null
  size_bytes?: number | null
  modified_at?: string | null
  created_at?: string | null
  permissions?: { read?: boolean; write?: boolean; delete?: boolean }
}

export interface DriveSpace {
  space_id: string
  root_asset_id: string
  kind: string
}

export interface DrivePage {
  items: DriveAsset[]
  page?: { has_more: boolean }
}

export interface DriveCapabilities {
  create_folder: boolean
  rename: boolean
  trash: boolean
  download: boolean
  move?: boolean
  upload?: boolean
  max_upload_bytes?: number | null
}

/** 用原生桌面鉴权读取目录分页，调用方负责过期响应和扫描生命周期。 */
export function listDriveDirectory(spaceId: string, parent: string, page: number): Promise<DrivePage> {
  const params = new URLSearchParams({
    space_id: spaceId,
    parent_asset_id: parent,
    page_no: String(page),
    page_size: '100',
    sort: 'name_asc'
  })

  return driveRequest<DrivePage>(`/assets?${params}`)
}

/** 云盘凭据由主进程添加，不读取旧 Web 登录缓存。 */
export async function driveRequest<T>(
  route: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: Record<string, unknown>,
  onVerifying?: () => void
): Promise<T> {
  if (!window.hermesDesktop?.cloudDriveRequest) {
    throw new Error('请使用新版桌面端打开个人云盘')
  }

  let result: CloudDriveFailure | T
  const requestId = onVerifying ? crypto.randomUUID() : undefined

  const dispose = onVerifying
    ? window.hermesDesktop.onCloudDriveMutationProgress?.(value => {
        if (value.id === requestId && value.phase === 'verifying') {
          onVerifying()
        }
      })
    : undefined

  try {
    result = (await window.hermesDesktop.cloudDriveRequest({
      route,
      method,
      body,
      ...(requestId ? { requestId } : {})
    })) as CloudDriveFailure | T
  } catch (error) {
    if (!isCloudDriveReadOperation({ route, method })) {
      // IPC 中断时主进程可能已完成写入，页面不能把它当作可直接重试的失败。
      throw new DriveOperationError('outcome_unknown', 'IPC_ERROR')
    }

    throw error
  } finally {
    dispose?.()
  }

  if (
    result &&
    typeof result === 'object' &&
    'protocol' in result &&
    result.protocol === 'uniwork.drive-result.v1' &&
    'ok' in result &&
    result.ok === false
  ) {
    const failure = result as CloudDriveFailure

    throw new DriveOperationError(failure.status, failure.code)
  }

  return result as T
}
