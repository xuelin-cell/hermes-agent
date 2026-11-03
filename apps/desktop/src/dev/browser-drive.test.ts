import { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, expect, it, vi } from 'vitest'

import { HermesGateway } from '@/api/client'

import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'

import { browserDrive } from './browser-drive'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('uses the account business transport and preserves uncertain writes without automatically replaying them', async () => {
  storeBrowserLogin('/hermes/', {
    maas_auth: { token: 'private-login', loginId: 'login-a', expiresAt: Date.now() + 60000 }
  })
  const requests: Array<{ path: string; body: any }> = []

  const failed = {
    protocol: 'uniwork.drive-result.v1',
    ok: false,
    status: 'outcome_unknown',
    code: 'UPLOAD_INTERRUPTED'
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options: RequestInit) => {
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer private-login')
      expect(options.credentials).toBe('same-origin')
      const path = new URL(url).pathname
      const body = JSON.parse(options.body as string)
      requests.push({ path, body })

      return new Response(
        JSON.stringify(path.endsWith('/status') ? { done: true, result: failed } : { id: 'operation' })
      )
    })
  )
  const bridge = browserDrive('/hermes/')

  const value = await bridge.cloudDriveTransfer({
    id: 'client-operation',
    operation: 'upload',
    parentAssetId: '0',
    artifact: { sessionId: 'session', profile: 'default', value: '/workspace/report.txt' }
  })

  expect(value).toEqual(failed)
  expect(requests.map(value => value.path)).toEqual(['/hermes/__entry/drive/transfer', '/hermes/__entry/drive/status'])
  expect(JSON.stringify(requests)).not.toContain('private-login')
  const handed: string[] = []
  const updates: unknown[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    handed.push(this.href)
  })
  bridge.onCloudDriveProgress(value => updates.push(value))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options: RequestInit) => {
      const body = JSON.parse(options.body as string)
      const status = new URL(url).pathname.endsWith('/status')

      return new Response(
        JSON.stringify(
          status
            ? {
                done: true,
                progress: { id: body.id, completed: 1, total: 1 },
                result: body.id.endsWith('-0')
                  ? { status: 'succeeded', name: 'one.txt', readyForBrowser: true }
                  : { status: 'failed', code: 'DOWNLOAD_FAILED' }
              }
            : { id: body.id }
        )
      )
    })
  )

  const batch = await bridge.cloudDriveTransfer({
    id: 'batch',
    operation: 'download-many',
    assets: [
      { assetId: 'one', name: 'one.txt' },
      { assetId: 'two', name: 'two.txt' }
    ]
  })

  expect(batch.status).toBe('partial_success')
  expect(batch.files?.map(file => file.status)).toEqual(['succeeded', 'failed'])
  expect(updates).toContainEqual(expect.objectContaining({ id: 'batch', fileIndex: 0, fileCount: 2 }))
  expect(handed).toHaveLength(1)
  expect(new URL(handed[0]).search).toBe('')
})

it('attaches a capability to each prompt request while keeping credentials out of text and other RPCs unchanged', async () => {
  const prepare = vi.fn(async (sessionId: string) => ({ cloud_drive: `capability-${sessionId}` }))
  vi.stubGlobal('hermesDesktop', { prepareCloudDriveTurn: prepare })
  const send = vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockResolvedValue({ status: 'streaming' })
  const gateway = new HermesGateway()
  await gateway.request('prompt.submit', { session_id: 'one', text: 'read the file', queued: true })
  await gateway.request('prompt.submit', { session_id: 'two', text: 'another task' })
  await gateway.request('session.list', {})
  expect(send.mock.calls[0][1]).toEqual({
    session_id: 'one',
    text: 'read the file',
    queued: true,
    execution_metadata: { cloud_drive: 'capability-one' }
  })
  expect(send.mock.calls[1][1]?.execution_metadata).toEqual({ cloud_drive: 'capability-two' })
  expect(send.mock.calls[2][1]).toEqual({})
  expect(prepare.mock.calls).toEqual([['one'], ['two']])
  vi.stubGlobal('hermesDesktop', {})
  await gateway.request('prompt.submit', { session_id: 'desktop', text: 'unchanged' })
  expect(send.mock.calls[3][1]).toEqual({ session_id: 'desktop', text: 'unchanged' })
})
