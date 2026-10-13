import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import type { PayloadInfo } from '../payload-backend'

import { accountSourceBackend } from './desktop-environment'
import { resolveAccountInstallation } from './runtime-installation'

it('完整安装包按构建契约定位 Python 和依赖，忽略外部源码覆盖并可从账号工作区启动', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-packaged-account-'))

  try {
    const payload: PayloadInfo = {
      root, repoDir: path.join(root, 'repo'), toolsDir: path.join(root, 'tools'),
      storePython: path.join(root, 'tools/python.exe'), sitePackages: path.join(root, 'deps'),
      commands: { hermes: path.join(root, 'bin/hermes.cmd') }, shim: path.join(root, 'bin/hermes.cmd')
    }

    fs.mkdirSync(payload.toolsDir)
    fs.writeFileSync(payload.storePython, '')
    const installation = resolveAccountInstallation('missing-checkout', 'untrusted-python', payload, true)
    expect(installation.installationRoot).toBe(payload.repoDir)
    expect(installation.python).toBe(payload.storePython)
    expect(fs.statSync(installation.gatewayLogoutScript!).isFile()).toBe(true)

    const backend = accountSourceBackend({ ...installation, id: 'account-test', home: path.join(root, 'home'),
      workspace: path.join(root, 'workspace'), desktopState: path.join(root, 'desktop') }, ['serve'])

    expect(backend.command).toBe(payload.storePython)
    expect(backend.env.PYTHONPATH).toBe([payload.repoDir, payload.sitePackages].join(path.delimiter))
    expect(backend.args).toEqual(['-m', 'hermes_cli.main', 'serve', '--isolated'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('缺少 Agent 的安装包不能借用开发源码绕过完整包要求', () => {
  expect(() => resolveAccountInstallation(process.cwd(), process.execPath, null, true)).toThrow('完整安装包')
})
