import { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, expect, it, vi } from 'vitest'

import { HermesGateway } from './client'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('carries independent drive and share grants only in prompt execution metadata', async () => {
  const request = vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockResolvedValue({})
  const drive = vi.fn(async () => ({ cloud_drive: 'drive-grant' }))
  const share = vi.fn(async () => ({ cloud_share: 'share-grant' }))
  vi.stubGlobal('hermesDesktop', { prepareCloudDriveTurn: drive, prepareCloudShareTurn: share })
  const client = new HermesGateway()
  const params = { session_id: 'runtime', prompt: '分享产物' }
  await client.request('prompt.submit', params)
  expect(request).toHaveBeenLastCalledWith('prompt.submit', {
    ...params, execution_metadata: { cloud_drive: 'drive-grant', cloud_share: 'share-grant' }
  }, undefined, undefined)
  expect(params).not.toHaveProperty('execution_metadata')
  drive.mockRejectedValueOnce(new Error('drive disabled'))
  await client.request('prompt.submit', params)
  expect(request).toHaveBeenLastCalledWith('prompt.submit', {
    ...params, execution_metadata: { cloud_share: 'share-grant' }
  }, undefined, undefined)
  await client.request('session.info', params)
  expect(request).toHaveBeenLastCalledWith('session.info', params, undefined, undefined)
})
