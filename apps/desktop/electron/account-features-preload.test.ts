import { expect, it, vi } from 'vitest'

import type { CloudDriveRequest, CloudDriveTransferProgress, CloudDriveTransferRequest } from './login/contract'
import type { UniworkAsrBridge } from './uniwork-asr/contract'

const host = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: host.expose },
  ipcRenderer: { invoke: host.invoke, on: host.on, removeListener: host.removeListener, sendSync: vi.fn(() => ({})) },
  webFrame: {},
  webUtils: {}
}))

it('真实 preload 同时保留模板、语音、分享和云盘，并分别解除事件订阅', async () => {
  await import('./preload')

  const bridge = host.expose.mock.calls.at(-1)![1] as {
    getWelcomeCatalog: (locale: string) => Promise<unknown>
    uniworkAsr: UniworkAsrBridge
    artifactShare: {
      inspect: (key: string) => Promise<unknown>
      setExpiration: (key: string, shareId: string, days: number) => Promise<unknown>
      onChanged: (callback: (key: string) => void) => () => void
    }
    cloudDriveRequest: (request: CloudDriveRequest) => Promise<unknown>
    cloudDriveAgentReady: (profile: string) => Promise<boolean>
    cloudDriveTransfer: (request: CloudDriveTransferRequest) => Promise<unknown>
    onCloudDriveProgress: (callback: (progress: CloudDriveTransferProgress) => void) => () => void
  }

  await bridge.getWelcomeCatalog('zh-CN')
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:uniwork-welcome:catalog', 'zh-CN')
  await bridge.uniworkAsr.start('zh')
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:uniwork-asr', { operation: 'start', language: 'zh' })
  await bridge.artifactShare.inspect('share-key')
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:artifact-share:inspect', 'share-key')
  await bridge.artifactShare.setExpiration('share-key', 'share-id', 3)
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:artifact-share:expiration', 'share-key', 'share-id', 3)
  await bridge.cloudDriveRequest({ route: '/asset-spaces' })
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:maas-drive:request', { route: '/asset-spaces' })
  await bridge.cloudDriveAgentReady('work')
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:maas-drive:agent-ready', 'work')
  const request = { id: 'transfer', operation: 'download' as const, assetId: 'file', name: '报告.pdf' }
  await bridge.cloudDriveTransfer(request)
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:maas-drive:transfer', request)
  const onProgress = vi.fn()
  const onShare = vi.fn()
  const offProgress = bridge.onCloudDriveProgress(onProgress)
  const progressListener = host.on.mock.calls.at(-1)!
  const offShare = bridge.artifactShare.onChanged(onShare)
  const shareListener = host.on.mock.calls.at(-1)!
  const progress = { id: 'transfer', completed: 5, total: 10 }
  progressListener[1]({}, progress)
  shareListener[1]({}, 'share-key')
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(progress)
  expect(onShare).toHaveBeenCalledExactlyOnceWith('share-key')
  offProgress()
  offShare()
  expect(host.removeListener.mock.calls).toEqual([
    ['hermes:maas-drive:progress', progressListener[1]],
    ['hermes:artifact-share:changed', shareListener[1]]
  ])
})
