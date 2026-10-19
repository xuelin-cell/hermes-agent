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

  const request = vi.fn(async (_profile: string, url: string) => {
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
