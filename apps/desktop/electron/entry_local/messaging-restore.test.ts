import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { DesktopMessaging, MessagingBotIndex } from './messaging'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

/** 隔离索引，状态与动作由本测试控制，不接触用户网关。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-restore-'))
  roots.push(root)

  const request = vi.fn(async (_profile: string, url: string, _method: string, _body?: any): Promise<any> => {
    if (url.split('?')[0].endsWith('/restore')) {return { configured: true, name: 'gateway-start', profiles: ['default'] }}

    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {return { platforms: [connection()] }}

    return { running: false, exit_code: 0 }
  })

  const service = new DesktopMessaging({ account: root, index: new MessagingBotIndex(root), request, sleep: async () => undefined })

  return { service, request }
}

/** 最小原版状态，明确区分配置、进程和平台连接。 */
function connection(enabled = true) {
  return { id: 'dingtalk', enabled, configured: enabled, gateway_running: enabled, state: enabled ? 'connected' : 'disabled' }
}

it('启用但缺少配置的渠道不能被过滤后冒充全部恢复', async () => {
  const { service, request } = fixture()
  request.mockImplementation(async (_profile, url) => {
    if (url.endsWith('/restore')) {return { configured: true, profiles: ['default'] }}

    return { platforms: [
      { ...connection(), configured: false, state: 'not_configured' },
      { ...connection(), id: 'weixin' }
    ] }
  })
  expect(await service.restore()).toEqual({ actionFailed: true })
  expect(service.status()).toMatchObject({ error: 'connection_timeout' })
})

it('5G-only restoration waits for the real connection and uses the same single startup queue', async () => {
  const { service, request } = fixture()
  let reads = 0
  request.mockImplementation(async (_profile, url) => {
    if (url.endsWith('/restore')) {
      return { configured: true, name: 'gateway-start', profiles: ['default'] }
    }

    reads++

    return { platforms: [{ ...connection(), id: 'uniagentgate', state: reads === 1 ? 'pending_restart' : 'connected' }] }
  })
  expect(await service.restore()).toEqual({ actionFailed: false })
  expect(reads).toBe(2)
  expect(request.mock.calls.filter(([, url]) => url.endsWith('/restore'))).toHaveLength(1)
  expect(service.status()).toMatchObject({ phase: 'completed', operation: 'restore' })
})

it.each([null, 'gateway-start', 'gateway-stop'])('恢复独立于页面且每进程一次；已有动作 %s 不被重复启动', async name => {
  const { service, request } = fixture()
  request.mockResolvedValueOnce({ configured: true, name, profiles: ['default'] })
  const first = service.restore()
  expect(service.restore()).toBe(first)
  expect(await first).toEqual({ actionFailed: false })
  expect(service.status()).toMatchObject({ operation: 'restore', phase: 'completed' })
  expect(request.mock.calls.filter(([, url]) => url.endsWith('/restore'))).toHaveLength(name === 'gateway-stop' ? 2 : 1)
  expect(request.mock.calls.filter(([, url]) => url.startsWith('/api/actions/'))).toHaveLength(name === 'gateway-stop' ? 1 : 0)
  expect(() => service.submit({ operation: 'restore' } as any)).toThrow('invalid_messaging_request')
})

it('无配置不启动；启动失败只影响消息状态，显式重试仍经过归属检查', async () => {
  const { service, request } = fixture()
  request.mockResolvedValueOnce({ configured: false, profiles: [], name: null })
  await service.restore()
  expect(request).toHaveBeenCalledTimes(1)
  expect(service.status().phase).toBe('idle')
  const failing = fixture()
  failing.request.mockRejectedValueOnce(new Error('gateway_identity_unverified PRIVATE-DETAIL'))
  await expect(failing.service.restore()).rejects.toThrow()
  expect(failing.service.status()).toMatchObject({ phase: 'failed', operation: 'restore', error: 'gateway_identity_unverified' })
  expect(JSON.stringify(failing.service.status())).not.toContain('PRIVATE')
  await failing.service.run({ operation: 'retry' })
  expect(failing.request.mock.calls.filter(([, url]) => url.includes('/restore'))).toHaveLength(2)
  expect(failing.request).toHaveBeenCalledWith('default', '/api/plugins/desktop-messaging/restore?restart=true', 'POST', {})
  expect(failing.request.mock.calls.some(([, url]) => url.endsWith('/apply'))).toBe(false)
})

it('恢复后的重试再次失败仍显示恢复失败，下次重试继续经过归属检查', async () => {
  const { service, request } = fixture()
  request.mockRejectedValueOnce(new Error('validation_timeout')).mockRejectedValueOnce(new Error('validation_timeout'))
  await expect(service.restore()).rejects.toThrow()
  await expect(service.run({ operation: 'retry' })).rejects.toThrow()
  expect(service.status()).toMatchObject({ phase: 'failed', operation: 'restore' })
  await service.run({ operation: 'retry' })
  expect(request.mock.calls.filter(([, url]) => url.includes('/restore'))).toHaveLength(3)
  expect(request.mock.calls.some(([, url]) => url.endsWith('/apply'))).toBe(false)
})

it('默认环境就绪不能掩盖命名 Profile 未连接，不重复启动它们的网关', async () => {
  const { service, request } = fixture()
  let finish!: (value: unknown) => void
  request.mockImplementation(async (profile, url) => {
    if (url.endsWith('/restore')) {return { configured: true, profiles: ['default', 'worker'], name: null }}

    if (profile === 'worker') {return await new Promise(resolve => { finish = resolve })}

    return { platforms: [connection()] }
  })
  const pending = service.restore()
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('worker', '/api/plugins/desktop-messaging/platforms?profile=worker', 'GET'))
  expect(service.status().phase).toBe('checking')
  finish({ platforms: [connection()] })
  await pending
  expect(service.status().phase).toBe('completed')
  expect(request.mock.calls.some(([, url]) => url.includes('/api/actions/'))).toBe(false)
})

it('恢复与连续保存、解绑串行；最后一次解绑决定停止，不丢弃已接收配置', async () => {
  const { service, request } = fixture()
  let release!: (value: unknown) => void
  let enabled = false
  request.mockImplementation(async (_profile, url, _method, body) => {
    if (url.endsWith('/restore')) {return await new Promise(resolve => { release = resolve })}

    if (url.includes('/platforms/dingtalk?')) {
      enabled = body.enabled

      return { changed: true }
    }

    if (url.endsWith('/apply')) {return { name: enabled ? 'gateway-restart' : 'gateway-stop' }}

    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {return { platforms: [connection(enabled)] }}

    return { running: false, exit_code: 0 }
  })
  void service.restore()
  await vi.waitFor(() => expect(service.status().phase).toBe('applying'))

  for (const id of ['first', 'second']) {
    await service.submit({ operation: 'save', platform: 'dingtalk', env: { DINGTALK_CLIENT_ID: id } })
  }

  await service.submit({ operation: 'disconnect', platform: 'dingtalk' })
  expect(request).toHaveBeenCalledTimes(1)
  release({ configured: false, profiles: [], name: null })
  await service.settle()
  const writes = request.mock.calls.filter(([, url]) => url.includes('/platforms/dingtalk?'))
  expect(writes.map(([, , , body]) => body.env.DINGTALK_CLIENT_ID)).toEqual(['first', 'second', undefined])
  expect(enabled).toBe(false)
  expect(service.status()).toMatchObject({ phase: 'completed', operation: 'disconnect' })
})

it('恢复中退出等待在途动作且拒绝新启动，排队保存不会越过停止快照', async () => {
  const { service, request } = fixture()
  let release!: (value: unknown) => void
  request.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
  void service.restore()
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  await service.submit({ operation: 'save', platform: 'feishu' })
  service.seal()
  expect(() => service.submit({ operation: 'retry' })).toThrow('messaging_account_closed')
  let settled = false
  const stop = service.settle().then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  release({ configured: true, profiles: ['default'], name: 'gateway-start' })
  await stop
  expect(request.mock.calls.some(([, url]) => url.includes('/platforms/feishu') || url.endsWith('/apply'))).toBe(false)
  expect(request.mock.calls.filter(([, url]) => url.endsWith('/restore'))).toHaveLength(1)
})
