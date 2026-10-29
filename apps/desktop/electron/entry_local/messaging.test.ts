import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { DesktopMessaging, MessagingBotIndex } from './messaging'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** 原版状态接口的最小连接事实，不包含账号或凭据。 */
function platformStatus(state = 'connected', gatewayRunning = true) {
  return { platforms: ['weixin', 'dingtalk', 'feishu', 'wecom'].map(id => ({
    id, enabled: true, configured: true, gateway_running: gatewayRunning, state
  })) }
}

/** 临时应用数据与真实摘要索引，不访问用户账号目录。 */
function fixture(account = 'account-a') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-messaging-'))
  directories.push(root)
  const index = new MessagingBotIndex(root)

  const request = vi.fn(async (_profile: string, url: string): Promise<any> => {
    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {return platformStatus()}

    if (url.includes('/platforms/')) {
      return { changed: true }
    }

    if (url.endsWith('/apply')) {
      return { name: 'gateway-restart' }
    }

    return { running: false, exit_code: 0 }
  })

  const service = new DesktopMessaging({ account, index, request, sleep: async () => undefined })

  return { root, index, request, service }
}

it('同机重复机器人先确认，摘要不包含原 ID，解绑只清除本归属', async () => {
  const { root, index, request, service } = fixture()
  index.remember('account-b', 'default', 'dingtalk', 'private-bot')

  const input = {
    operation: 'save' as const,
    platform: 'dingtalk' as const,
    env: { DINGTALK_CLIENT_ID: 'private-bot', DINGTALK_CLIENT_SECRET: 'secret' }
  }

  expect(await service.run(input)).toEqual({ confirmationRequired: true })
  expect(request).not.toHaveBeenCalled()
  expect(await service.run({ ...input, confirmed: true })).toMatchObject({ saved: true, actionFailed: false })
  expect(fs.readFileSync(path.join(root, 'messaging-bots.json'), 'utf8')).not.toContain('private-bot')
  await service.run({ operation: 'disconnect', platform: 'dingtalk' })
  expect(index.conflicts('account-a', 'default', 'dingtalk', 'private-bot')).toBe(true)
})

it('保存拒绝不重启，动作失败仍报告保存成功，重试不重复保存', async () => {
  const { request, service } = fixture()
  request.mockRejectedValueOnce(new Error('credentials_rejected'))
  await expect(service.run({ operation: 'save', platform: 'feishu' })).rejects.toThrow('credentials_rejected')
  expect(request).toHaveBeenCalledTimes(1)
  request.mockImplementation(async (_profile, url) => {
    if (url.includes('/platforms/')) {
      return { changed: true }
    }

    if (url.endsWith('/apply')) {
      return { name: 'gateway-restart' }
    }

    return { running: false, exit_code: 1 }
  })
  expect(await service.run({ operation: 'save', platform: 'feishu' })).toMatchObject({
    saved: true,
    actionFailed: true
  })
  request.mockClear()
  expect(await service.run({ operation: 'retry' })).toEqual({ actionFailed: true })
  expect(request.mock.calls.some(([, url]) => url.includes('/platforms/'))).toBe(false)
})

it('串行保存和动作，无变化不重启；退出封闭后不再接受操作', async () => {
  const { request, service } = fixture()
  request.mockResolvedValueOnce({ changed: false })
  expect(await service.run({ operation: 'save', platform: 'wecom' })).toMatchObject({ changed: false })
  expect(request).toHaveBeenCalledTimes(1)
  service.seal()
  await expect(service.run({ operation: 'retry' })).rejects.toThrow('messaging_account_closed')
  await service.settle()
})

it('提交立即返回，状态独立跟踪后台重启，快照不包含凭据', async () => {
  const { request, service } = fixture()
  let finish!: (result: { running: boolean; exit_code: number }) => void
  request.mockImplementation(async (_profile, url) => {
    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {return platformStatus()}

    if (url.includes('/platforms/')) {return { changed: true }}

    if (url.endsWith('/apply')) {return { name: 'gateway-restart' }}

    return await new Promise(resolve => { finish = resolve })
  })
  expect(await service.submit({ operation: 'save', platform: 'dingtalk', env: {
    DINGTALK_CLIENT_ID: 'private-id', DINGTALK_CLIENT_SECRET: 'private-key'
  } })).toEqual({ accepted: true })
  expect(await service.submit({ operation: 'save', platform: 'dingtalk', env: {
    DINGTALK_CLIENT_SECRET: 'private-key', DINGTALK_CLIENT_ID: 'private-id'
  } })).toEqual({ accepted: true })
  await vi.waitFor(() => expect(service.status().phase).toBe('restarting'))
  expect(JSON.stringify(service.status())).not.toContain('private-')
  expect(service.status()).toMatchObject({ saved: true, operation: 'save' })
  finish({ running: false, exit_code: 0 })
  await service.settle()
  expect(service.status().phase).toBe('completed')
  expect(request.mock.calls.filter(([, url]) => url.endsWith('/apply'))).toHaveLength(1)
})

it('后台错误只保留稳定错误类型，保存成功后的停止失败不丢配置结果', async () => {
  const { request, service } = fixture()
  request.mockRejectedValueOnce(new Error('credentials_rejected PRIVATE-UPSTREAM-DETAIL'))
  expect(await service.submit({ operation: 'save', platform: 'feishu' })).toEqual({ accepted: true })
  await service.settle()
  expect(service.status()).toMatchObject({ phase: 'failed', saved: false, error: 'credentials_rejected' })
  expect(JSON.stringify(service.status())).not.toContain('PRIVATE')
  request.mockImplementation(async (_profile, url) => {
    if (url.includes('/unbind')) {return { ok: true }}

    if (url.endsWith('/apply')) {return { name: 'gateway-stop' }}

    return { running: false, exit_code: 1 }
  })
  expect(await service.submit({ operation: 'disconnect', platform: 'weixin', profile: 'worker' })).toEqual({ accepted: true })
  await service.settle()
  expect(request).toHaveBeenCalledWith('worker', '/api/plugins/weixin-qr/unbind?profile=worker', 'POST', {})
  expect(service.status()).toMatchObject({ phase: 'failed', saved: true, error: 'apply_failed' })
})

it('微信只在原后台作用域跟踪已有动作，不重复发起重启', async () => {
  const { request, service } = fixture()
  expect(await service.submit({ operation: 'watch', platform: 'weixin', profile: 'worker' })).toEqual({ accepted: true })
  await service.settle()
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledWith('worker', '/api/actions/gateway-restart/status?lines=1', 'GET')
  expect(service.status()).toMatchObject({ phase: 'completed', saved: true })
})

it('退出等待已接收的保存，封闭后不再接受任务或重新拉起网关', async () => {
  const { request, service } = fixture()
  let finish!: (result: { changed: boolean }) => void
  request.mockImplementation(async () => await new Promise(resolve => { finish = resolve }))
  expect(await service.submit({ operation: 'save', platform: 'feishu' })).toEqual({ accepted: true })
  await vi.waitFor(() => expect(service.status().phase).toBe('saving'))
  service.seal()
  expect(() => service.submit({ operation: 'retry' })).toThrow('messaging_account_closed')
  let settled = false
  const pending = service.settle().then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish({ changed: true })
  await pending
  expect(settled).toBe(true)
  expect(request).toHaveBeenCalledTimes(1)
  expect(service.status()).toMatchObject({ phase: 'failed', saved: true, error: 'apply_failed' })
})

it('动作退出不等于平台就绪；重启、扫码和解绑等待真实状态，确认有界且不重复重启', async () => {
  for (const operation of ['save', 'watch', 'disconnect', 'retry'] as const) {
    const { request, service } = fixture()
    let finish!: (value: ReturnType<typeof platformStatus>) => void
    let reads = 0
    request.mockImplementation(async (_profile, url) => {
      if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {
        reads += 1

        return await new Promise(resolve => { finish = resolve })
      }

      if (url.endsWith('/apply')) {return { name: 'gateway-restart' }}

      if (url.includes('/platforms/')) {return { changed: true }}

      return { running: false, exit_code: 0 }
    })
    await service.submit({ operation, platform: operation === 'save' ? 'dingtalk' : 'weixin', profile: 'worker' })

    for (const [index, state] of ['gateway_stopped', 'pending_restart', 'connecting'].entries()) {
      await vi.waitFor(() => expect(reads).toBe(index + 1))
      expect(service.status().phase).toBe('checking')
      const snapshot = platformStatus(state, state !== 'gateway_stopped')

      if (operation === 'disconnect' && index === 2) {snapshot.platforms[0].enabled = false}
      finish(snapshot)
    }

    await vi.waitFor(() => expect(reads).toBe(4))
    const ready = platformStatus()

    if (operation === 'disconnect') {
      ready.platforms[0].enabled = false
      ready.platforms[0].configured = false
    }

    finish(ready)
    await service.settle()
    expect(service.status()).toMatchObject({ phase: 'completed', saved: true })
    expect(request).toHaveBeenCalledWith('worker', '/api/plugins/desktop-messaging/platforms?profile=worker', 'GET')
    expect(request.mock.calls.filter(([, url]) => url.endsWith('/apply'))).toHaveLength(operation === 'watch' ? 0 : 1)
  }

  const { request, service } = fixture()
  let reads = 0
  request.mockImplementation(async (_profile, url) => {
    if (url.endsWith('/apply')) {return { name: 'gateway-stop' }}

    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {
      const snapshot = platformStatus('disabled', ++reads === 1)
      snapshot.platforms.forEach(row => { row.enabled = false; row.configured = false })

      return snapshot
    }

    return { running: false, exit_code: 0 }
  })
  await service.submit({ operation: 'disconnect', platform: 'weixin' })
  await service.settle()
  expect(reads).toBe(2)
  expect(service.status().phase).toBe('completed')

  reads = 0
  request.mockImplementation(async (_profile, url) => {
    if (url.endsWith('/apply')) {return { name: 'gateway-restart' }}

    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {
      reads += 1

      return platformStatus('pending_restart')
    }

    return { running: false, exit_code: 0 }
  })
  await service.submit({ operation: 'retry' })
  await service.settle()
  expect(reads).toBeGreaterThan(1)
  expect(reads).toBeLessThanOrEqual(30)
  expect(service.status()).toMatchObject({ phase: 'failed', saved: true, error: 'connection_timeout' })
})

it('索引写入失败与连接超时分开，不允许正常连接掩盖保存错误', async () => {
  const { index, service, request } = fixture()
  vi.spyOn(index, 'remember').mockImplementation(() => { throw new Error('fixture disk failure') })
  await service.submit({ operation: 'save', platform: 'dingtalk' })
  await service.settle()
  expect(service.status()).toMatchObject({ phase: 'failed', saved: true, error: 'index_failed' })
  expect(request.mock.calls.some(([, url]) => url.endsWith('/apply'))).toBe(false)
})

it('飞书解绑确认清空凭据并完成网关动作，不等待其它渠道恢复连接', async () => {
  const { request, service } = fixture()
  let reads = 0
  request.mockImplementation(async (_profile, url) => {
    if (url.includes('/platforms/')) {
      return { changed: true }
    }

    if (url.endsWith('/apply')) {
      return { name: 'gateway-restart' }
    }

    if (url.startsWith('/api/plugins/desktop-messaging/platforms?')) {
      reads += 1
      const snapshot = platformStatus('retrying', reads !== 3)
      const feishu = snapshot.platforms.find(row => row.id === 'feishu')!
      feishu.enabled = false
      feishu.configured = reads === 1
      Object.assign(feishu, { env_vars: [{ required: true, is_set: reads === 2 }] })

      return snapshot
    }

    return { running: false, exit_code: 0 }
  })
  await service.submit({ operation: 'disconnect', platform: 'feishu', profile: 'worker' })
  await service.settle()
  expect(reads).toBe(4)
  expect(service.status()).toMatchObject({ phase: 'completed', saved: true, platform: 'feishu' })
  expect(request).toHaveBeenCalledWith(
    'worker',
    '/api/plugins/desktop-messaging/platforms/feishu?profile=worker',
    'PUT',
    { enabled: false, env: {} }
  )
  expect(request.mock.calls.filter(([, url]) => url.endsWith('/apply'))).toHaveLength(1)
})

it.each(['save', 'apply'] as const)('飞书解绑 %s 失败仍明确报告，不凭旧禁用状态冒充完成', async failure => {
  const { request, service } = fixture()
  request.mockImplementation(async (_profile, url) => {
    if (url.includes('/platforms/')) {
      if (failure === 'save') {
        throw new Error('disk failed')
      }

      return { changed: true }
    }

    if (url.endsWith('/apply')) {
      return { name: 'gateway-restart' }
    }

    return { running: false, exit_code: 1 }
  })
  await service.submit({ operation: 'disconnect', platform: 'feishu' })
  await service.settle()
  expect(service.status()).toMatchObject({ phase: 'failed', saved: failure !== 'save' })
  expect(request.mock.calls.some(([, url]) => url.includes('/platforms?'))).toBe(false)
})
