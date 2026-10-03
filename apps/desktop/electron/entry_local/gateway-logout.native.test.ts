import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { accountGatewayLogout } from './gateway-logout'
import type { PreparedLocalContext } from './runtime-context'

it.skipIf(process.platform !== 'win32')('真实 TypeScript 子进程保留账号完整环境，原版 source-backend 的增量环境不能替代它', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-gateway-bridge-'))
  const source = path.resolve(import.meta.dirname, '../../../..')

  const context: PreparedLocalContext = {
    id: 'test-account', home: path.join(root, 'home'), workspace: path.join(root, 'workspace'),
    desktopState: path.join(root, 'desktop'), installationRoot: source,
    python: path.join(source, '.venv/Scripts/python.exe')
  }

  fs.mkdirSync(context.home)
  fs.writeFileSync(path.join(context.home, 'history-sentinel.txt'), 'keep')

  try {
    expect(await accountGatewayLogout(context, 'snapshot')).toEqual([])
    expect(await accountGatewayLogout(context, 'stop')).toEqual([])
    expect(await accountGatewayLogout(context, 'check')).toEqual([])
    expect(fs.readFileSync(path.join(context.home, 'history-sentinel.txt'), 'utf8')).toBe('keep')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
