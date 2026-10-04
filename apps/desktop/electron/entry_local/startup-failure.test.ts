import { expect, it, vi } from 'vitest'

const { quit, showMessageBox } = vi.hoisted(() => ({ quit: vi.fn(), showMessageBox: vi.fn() }))
vi.mock('electron', () => ({ app: { quit }, dialog: { showMessageBox } }))

import { LocalStartupError, showLocalStartupFailure } from './startup-failure'

it('各阶段只显示安全说明，嵌套磁盘和权限错误提供下一步，不回显敏感原文', () => {
  for (const stage of ['directory', 'config', 'credentials', 'runtime', 'backend'] as const) {
    const original = Object.assign(new Error('private-token private-key C:/private-account'), { code: 'ENOSPC' })
    const error = new LocalStartupError(stage, new Error('private-uid', { cause: original }))
    expect(error.message).toContain('释放空间')
    expect(error.message).toContain('完整退出应用后重新打开')
    expect(error.message).toContain('账号数据会保留')
    expect(error.message).not.toMatch(/private|C:\//)
    expect(new LocalStartupError(stage, Object.assign(new Error('private'), { code: 'EACCES' })).message).toContain(
      '访问权限'
    )
    expect(new LocalStartupError(stage, new Error('private')).message).toContain('寻求支持')
  }

  expect(new LocalStartupError('backend', new Error('private-path: database or disk is full')).message).toContain(
    '释放空间'
  )
  expect(new LocalStartupError('backend', new Error('private-path: permission denied')).message).toContain('访问权限')
})

it('并发失败只弹一个退出提示，点击前不退出，点击后正常退出而不提供重试', async () => {
  let answer!: () => void
  showMessageBox.mockReturnValue(
    new Promise<void>(resolve => {
      answer = resolve
    })
  )
  const window = { isDestroyed: () => false }
  showLocalStartupFailure(new LocalStartupError('backend'), window as never)
  showLocalStartupFailure(new LocalStartupError('config'), window as never)
  expect(showMessageBox).toHaveBeenCalledTimes(1)
  expect(showMessageBox.mock.calls[0][1].buttons).toEqual(['退出应用'])
  expect(quit).not.toHaveBeenCalled()
  answer()
  await Promise.resolve()
  expect(quit).toHaveBeenCalledTimes(1)
})
