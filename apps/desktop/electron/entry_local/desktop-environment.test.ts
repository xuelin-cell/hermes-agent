import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { accountDesktopEnvironment, accountSourceBackend } from './desktop-environment'
import type { PreparedLocalContext } from './runtime-context'

it('账号启动只使用固定源码与数据位置，不继承旧连接、Profile 或平台 Key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mt-bind-'))
  const oldHome = path.join(root, 'old-home')
  fs.mkdirSync(oldHome)
  fs.writeFileSync(path.join(oldHome, '.env'), 'OLD_MODEL_KEY=fixture-old\n')

  const context: PreparedLocalContext = Object.freeze({
    id: 'fixture-account',
    home: path.join(root, 'account-home'),
    workspace: path.join(root, 'workspace'),
    desktopState: path.join(root, 'desktop-state'),
    installationRoot: path.join(root, 'source'),
    python: path.join(root, 'source', '.venv', 'Scripts', 'python.exe')
  })

  const inherited = {
    HERMES_HOME: oldHome,
    OLD_MODEL_KEY: 'fixture-old',
    DESKTOP_MT_MAAS_API_KEY: 'fixture-other-account',
    HERMES_PROFILE: 'other',
    HERMES_DESKTOP_REMOTE_URL: 'https://other.invalid',
    HERMES_DESKTOP_REMOTE_TOKEN: 'fixture-token',
    HERMES_DESKTOP_CWD: oldHome,
    TERMINAL_CWD: oldHome,
    PERSONAL_SHELL_SETTING: 'kept'
  }

  const env = accountDesktopEnvironment(context, inherited)
  expect(env.HERMES_HOME).toBe(context.home)
  expect(env.TERMINAL_CWD).toBe(context.workspace)
  expect(env.OLD_MODEL_KEY).toBeUndefined()
  expect(env.DESKTOP_MT_MAAS_API_KEY).toBeUndefined()
  expect(env.HERMES_PROFILE).toBeUndefined()
  expect(env.HERMES_DESKTOP_REMOTE_URL).toBeUndefined()
  expect(env.HERMES_DESKTOP_REMOTE_TOKEN).toBeUndefined()
  expect(env.PERSONAL_SHELL_SETTING).toBe('kept')
  const backend = accountSourceBackend(context, ['serve', '--host', '127.0.0.1', '--port', '0'], env)
  expect(backend.command).toBe(context.python)
  expect(backend.root).toBe(context.installationRoot)
  expect(backend.env.PYTHONPATH).toBe(context.installationRoot)
  expect(backend.bootstrap).toBe(false)
  expect(backend.args).toContain('--isolated')
  expect(inherited.HERMES_HOME).toBe(oldHome)
  expect(fs.readdirSync(root)).toEqual(['old-home'])
})
