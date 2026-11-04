import fs from 'node:fs'
import path from 'node:path'

import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  install: vi.fn(async () => ''),
  runtime: vi.fn(() => ({ python: '/bundle/python' }))
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('./runtime-installation', () => ({ resolveAccountInstallation: mocks.runtime }))
vi.mock('./skills-cli-registration.mjs', () => ({ installSkillsCli: mocks.install }))

import { registerPackagedSkillsCli } from './skills-cli-install'

beforeEach(() => {
  mocks.app.isPackaged = true
  vi.clearAllMocks()
})

it('安装包用自身可执行文件和构建契约 Python 注册，辅助脚本已进入 dist', async () => {
  await registerPackagedSkillsCli()
  expect(mocks.install).toHaveBeenCalledWith(
    expect.objectContaining({ executable: process.execPath, python: '/bundle/python' })
  )
  expect(mocks.install).toHaveBeenCalledWith(expect.not.objectContaining({ appPath: expect.anything() }))

  for (const name of ['skills-cli.py', 'skills-cli.ps1']) {
    expect(fs.existsSync(path.resolve('dist', name))).toBe(true)
  }
})

it('开发启动不自动抢占命令，仍由开发者手动注册', async () => {
  mocks.app.isPackaged = false
  await registerPackagedSkillsCli()
  expect(mocks.install).not.toHaveBeenCalled()
})

it('缺少完整运行组件时报告注册失败', async () => {
  mocks.runtime.mockImplementationOnce(() => {
    throw new Error('缺少完整安装包')
  })
  await expect(registerPackagedSkillsCli()).rejects.toThrow('完整安装包')
  expect(mocks.install).not.toHaveBeenCalled()
})
