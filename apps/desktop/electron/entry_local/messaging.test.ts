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

/** 临时应用数据与真实摘要索引，不访问用户账号目录。 */
function fixture(account = 'account-a') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-messaging-'))
  directories.push(root)
  const index = new MessagingBotIndex(root)

  const request = vi.fn(async (_profile: string, url: string): Promise<any> => {
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
  expect(request).toHaveBeenCalledTimes(1)
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
