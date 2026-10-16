import { afterEach, expect, it, vi } from 'vitest'

import { DriveOperationError, driveRequest } from './drive'

afterEach(() => vi.unstubAllGlobals())

it('页面保留 IPC 返回的操作状态，不把部分成功或未知结果当作成功数据', async () => {
  const request = vi.fn()
  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })

  for (const status of ['failed', 'partial_success', 'outcome_unknown']) {
    request.mockResolvedValueOnce(
      structuredClone({ protocol: 'uniwork.drive-result.v1', ok: false, status, code: 'SERVICE_ERROR' })
    )
    const failure = await driveRequest('/assets/move', 'POST', { file_ids: ['file-id'] }).catch(error => error)
    expect(failure).toBeInstanceOf(DriveOperationError)
    expect(failure).toMatchObject({ status, code: 'SERVICE_ERROR' })
  }

  request.mockResolvedValueOnce({ items: [] })
  expect(await driveRequest('/asset-spaces')).toEqual({ items: [] })
  expect(request.mock.calls.every(([input]) => !('token' in input) && !('phone' in input))).toBe(true)
})

it('IPC 中断后的写操作标记结果未知，读取失败仍保留原错误且两者均不重放', async () => {
  const error = new Error('IPC disconnected')
  const request = vi.fn().mockRejectedValue(error)
  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })
  await expect(driveRequest('/assets/move', 'POST', { file_ids: ['file-id'] })).rejects.toMatchObject({
    status: 'outcome_unknown',
    code: 'IPC_ERROR'
  })
  await expect(driveRequest('/unicom/QueryRecycleData', 'POST', { pageNo: 1 })).rejects.toBe(error)
  expect(request).toHaveBeenCalledTimes(2)
})
