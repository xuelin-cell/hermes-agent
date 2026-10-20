import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect, it, vi } from 'vitest'

const { handle, fromWebContents } = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle }, BrowserWindow: { fromWebContents } }))

import { installAccountIpc } from './account-ipc'
import { CloudDriveClient, CloudDriveOperationError } from './cloud-drive'

const identity = {
  uid: 'user-a',
  token: 'login-private',
  phone: '13800000000',
  maskedPhone: '138****0000',
  expiresAt: Date.now() + 60_000
}

/** 在本机 HTTP 服务上验证真实请求、凭据注入及响应解析，所有生产域名都映射到该服务。 */
async function service() {
  const calls: Array<{ path: string; body: unknown; token?: string }> = []
  let mode = 'succeeded'

  const server = createServer(async (request, response) => {
    const chunks = []

    for await (const chunk of request) {
      chunks.push(chunk)
    }

    const body = Buffer.concat(chunks).toString()
    const path = request.url!
    calls.push({
      path,
      body: body ? JSON.parse(body) : null,
      token: request.headers['x-drive-access-token'] as string | undefined
    })
    response.setHeader('Content-Type', 'application/json')

    if (path.endsWith('access-token')) {
      response.end(JSON.stringify({ meta: { code: '' }, result: { accessToken: 'drive-private' } }))
    } else if (mode === 'disconnect') {
      response.destroy()
    } else if (mode === 'expired') {
      response.end(JSON.stringify({ ok: false, status: 'failed', error: { code: 'DRIVE_AUTH_EXPIRED' } }))
    } else {
      response.end(
        JSON.stringify({ ok: true, status: mode, data: [], error: { code: 'SERVICE_ERROR', message: 'drive-private' } })
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const nativeFetch = globalThis.fetch

  const request: typeof fetch = (url, options) =>
    nativeFetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, options)

  return {
    calls,
    request,
    mode: (value: string) => {
      mode = value
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

it('真实 HTTP 链路保留写操作状态，不重放过期或断线请求，并限制回收站操作范围', async () => {
  const backend = await service()

  try {
    const client = new CloudDriveClient(() => identity, backend.request)
    expect(await client.execute({ route: '/unicom/QueryRecycleData', method: 'POST', body: { pageNo: 1 } })).toEqual([])

    for (const mode of ['partial_success', 'outcome_unknown', 'expired', 'disconnect']) {
      backend.mode(mode)
      const before = backend.calls.filter(call => call.path.endsWith('ReductionRecycleData')).length

      const failure = await client
        .execute({ route: '/unicom/ReductionRecycleData', method: 'POST', body: { deleteNos: ['delete-operation'] } })
        .catch(error => error)

      expect(failure).toBeInstanceOf(CloudDriveOperationError)

      if (!(failure instanceof CloudDriveOperationError)) {
        throw failure
      }

      expect(failure.result.status).toBe(
        mode === 'expired' ? 'failed' : mode === 'disconnect' ? 'outcome_unknown' : mode
      )
      expect(backend.calls.filter(call => call.path.endsWith('ReductionRecycleData')).length - before).toBe(1)
      expect(JSON.stringify(failure.result)).not.toMatch(/drive-private|login-private/)
    }

    expect(backend.calls.find(call => call.path.endsWith('QueryRecycleData'))?.token).toBe('drive-private')
    const before = backend.calls.length
    await expect(client.execute({ route: '/unicom/DeleteRecycleData', method: 'POST' })).rejects.toThrow('不受支持')
    await expect(
      client.execute({ route: '/unicom/EmptyRecycleData', method: 'POST', body: { spaceType: '93' } })
    ).rejects.toThrow('不受支持')
    await expect(client.execute({ route: '/project-drive/assets/trash', method: 'POST' })).rejects.toThrow('不受支持')
    await expect(client.execute({ route: '/unicom/EmptyRecycleData', method: 'POST' })).rejects.toThrow('不受支持')
    expect(backend.calls).toHaveLength(before)
    backend.mode('succeeded')
    await client.execute({
      route: '/unicom/DeleteRecycleData',
      method: 'POST',
      body: { deleteNos: ['delete-operation'] }
    })
    await client.execute({ route: '/unicom/EmptyRecycleData', method: 'POST', body: {} })
    expect(backend.calls.find(call => call.path.endsWith('DeleteRecycleData'))?.body).toEqual({
      deleteNos: ['delete-operation']
    })
    expect(backend.calls.find(call => call.path.endsWith('EmptyRecycleData'))?.body).toEqual({})
  } finally {
    await backend.close()
  }
})

it('经过来源校验、真实网络和 IPC 数据序列化后，错误状态保持完整且不泄露凭据', async () => {
  const backend = await service()
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/artifacts' }
  const sender = Object.assign(new EventEmitter(), { mainFrame: frame, session: partition })

  try {
    vi.stubGlobal('fetch', backend.request)
    fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
    installAccountIpc(
      partition as never,
      () => 'http://127.0.0.1:5174',
      () => identity,
      undefined,
      () => identity
    )
    const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-drive:request')![1]

    for (const status of ['partial_success', 'outcome_unknown']) {
      backend.mode(status)

      const failure = structuredClone(
        await invoke(
          { sender, senderFrame: frame },
          {
            route: '/assets/move',
            method: 'POST',
            body: { file_ids: ['file'], directory_ids: [], target_parent_asset_id: 'folder' }
          }
        )
      )

      expect(failure).toMatchObject({ protocol: 'uniwork.drive-result.v1', ok: false, status })
      expect(JSON.stringify(failure)).not.toMatch(/drive-private|login-private/)
    }

    const before = backend.calls.length
    await expect(
      invoke({ sender, senderFrame: {} }, { route: '/unicom/QueryRecycleData', method: 'POST' })
    ).rejects.toThrow('无效')
    expect(backend.calls).toHaveLength(before)
  } finally {
    vi.unstubAllGlobals()
    await backend.close()
  }
})
