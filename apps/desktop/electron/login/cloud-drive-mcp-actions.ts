import { setTimeout as delay } from 'node:timers/promises'

import type { CloudDriveClient } from './cloud-drive'
import { CloudDriveOperationError } from './cloud-drive'
import type { DriveMcpInput } from './cloud-drive-mcp-tools'
import type { CloudDriveRequest } from './contract'

/** 上游查询仅按已知字段读取，不将不完整任务或回收站响应当作空列表。 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 名称可位于详情主体、数组或 items/files 包装中，兼容现有服务返回值。 */
export function driveFileName(value: unknown): string | null {
  const container = record(value)

  const row = record(
    Array.isArray(value)
      ? value[0]
      : Array.isArray(container.items)
        ? container.items[0]
        : Array.isArray(container.files)
          ? container.files[0]
          : value
  )

  return (
    [row.fileName, row.file_name, row.name].find((name): name is string => typeof name === 'string' && !!name.trim()) ??
    null
  )
}

/** 个人回收站固定由服务选择 spaceType=0；不接受工具传入其他空间。 */
async function recycle(drive: CloudDriveClient, input: DriveMcpInput, signal: AbortSignal) {
  const raw = await drive.execute(
    {
      route: '/unicom/QueryRecycleData',
      method: 'POST',
      body: {
        pageNo: input.page_no,
        pageSize: input.page_size,
        sortRule: '0'
      }
    },
    signal
  )

  const rows = Array.isArray(raw) ? raw : (record(raw).items ?? record(raw).list)

  if (!Array.isArray(rows)) {
    throw new CloudDriveOperationError('failed', 'INVALID_RESPONSE')
  }

  const items = rows.map(value => {
    const row = record(value)

    if (typeof row.deleteNo !== 'string' || !row.deleteNo) {
      throw new CloudDriveOperationError('failed', 'INVALID_RESPONSE')
    }

    const directory = String(row.type) === '0'

    return {
      delete_no: row.deleteNo,
      name: typeof row.name === 'string' ? row.name : '',
      kind: directory ? 'directory' : 'file',
      size_bytes: !directory && Number.isSafeInteger(row.fileSize) && Number(row.fileSize) >= 0 ? row.fileSize : null,
      deleted_at: typeof row.deleteTime === 'string' ? row.deleteTime : null,
      keep_days: Number.isSafeInteger(row.keepDays) ? row.keepDays : null
    }
  })

  return {
    items,
    page: { page_no: input.page_no, page_size: input.page_size, has_more: items.length >= Number(input.page_size) }
  }
}

/** 异步搜索只返回完整分页结果，取消时清理同一身份的后台任务。 */
async function search(drive: CloudDriveClient, input: DriveMcpInput, caller: AbortSignal) {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(660_000)])
  const check = drive.guardIdentity()
  const page = new URLSearchParams({ page_no: String(input.page_no), page_size: String(input.page_size) })
  let searchId: string | undefined
  let completed = false

  try {
    let result = await drive.execute({ route: '/assets/search', method: 'POST', body: input }, signal)

    while (record(result).state === 'running') {
      const id = record(result).search_id

      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || (searchId && id !== searchId)) {
        throw new CloudDriveOperationError('failed', 'INVALID_SEARCH_JOB')
      }

      searchId = id
      await delay(1000, undefined, { signal })
      check()
      result = await drive.execute({ route: `/assets/search/${searchId}?${page}` }, signal)
    }

    if (!Array.isArray(record(result).items) || !record(result).page || typeof record(result).page !== 'object') {
      throw new CloudDriveOperationError('failed', 'INVALID_RESPONSE')
    }

    completed = true

    return result
  } finally {
    if (searchId && !completed) {
      try {
        check()
        await drive.execute({ route: `/assets/search/${searchId}`, method: 'DELETE' }, AbortSignal.timeout(3000))
      } catch {
        // 不跨账号取消任务，清理失败也不能覆盖原始失败或取消状态。
      }
    }
  }
}

/** 主进程仍限制单条彻底删除；批量逐条确认，失败即停且绝不重放未知写入。 */
async function remove(drive: CloudDriveClient, input: DriveMcpInput, signal: AbortSignal) {
  if (input.mode !== 'purge') {
    return drive.execute(
      {
        route: '/assets/trash',
        method: 'POST',
        body: { file_ids: input.file_ids ?? [], directory_ids: input.directory_ids ?? [] }
      },
      signal
    )
  }

  const check = drive.guardIdentity()
  const entries = input.delete_nos as string[]
  const results: Array<{ delete_no: string; status: string; code?: string }> = []

  for (const deleteNo of entries) {
    try {
      check()
      signal.throwIfAborted()
      await drive.execute(
        { route: '/unicom/DeleteRecycleData', method: 'POST', body: { deleteNos: [deleteNo] } },
        signal
      )
      results.push({ delete_no: deleteNo, status: 'succeeded' })
    } catch (error) {
      const failure = error instanceof CloudDriveOperationError ? error.result : { status: 'failed', code: 'CANCELLED' }
      results.push({ delete_no: deleteNo, status: failure.status, code: failure.code })
      const succeeded = results.filter(item => item.status === 'succeeded').length

      for (const remaining of entries.slice(results.length)) {
        results.push({ delete_no: remaining, status: 'not_started' })
      }

      return {
        ok: false,
        status:
          failure.status === 'outcome_unknown' ? 'outcome_unknown' : succeeded ? 'partial_success' : failure.status,
        code: failure.code,
        item_results: results,
        summary: { succeeded, total: entries.length }
      }
    }
  }

  return { item_results: results, summary: { succeeded: results.length, total: entries.length } }
}

/** 固定动作表复用现有账号客户端，不新增上游或 Renderer 网络通道。 */
export async function executeDriveMcpAction(
  drive: CloudDriveClient,
  name: string,
  input: DriveMcpInput,
  signal: AbortSignal
): Promise<unknown> {
  const request = (route: string, method: CloudDriveRequest['method'] = 'GET', body?: Record<string, unknown>) =>
    drive.execute({ route, method, body }, signal)

  const handlers: Record<string, () => Promise<unknown>> = {
    list_files: () =>
      request(`/assets?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`),
    filesearch: () => search(drive, input, signal),
    make_dir: () => request('/folders', 'POST', input),
    rename_file: () =>
      request(`/assets/${encodeURIComponent(String(input.asset_id))}`, 'PATCH', {
        new_name: input.new_name,
        kind: input.kind
      }),
    move_files: () =>
      request('/assets/move', 'POST', {
        file_ids: input.file_ids ?? [],
        directory_ids: input.directory_ids ?? [],
        target_parent_asset_id: input.target_parent_asset_id
      }),
    delete_files: () => remove(drive, input, signal),
    get_file_info: () => request('/unicom/FileDetails', 'POST', { fileId: input.asset_id }),
    list_recycle_bin: () => recycle(drive, input, signal),
    restore_files: () => request('/unicom/ReductionRecycleData', 'POST', { deleteNos: input.delete_nos }),
    get_capacity: () => request('/asset-spaces/personal/usage')
  }

  const handler = handlers[name]

  if (!handler) {
    throw new CloudDriveOperationError('failed', 'TOOL_UNAVAILABLE')
  }

  return handler()
}
