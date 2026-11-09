import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath } }))

import * as secretStorage from '../app-secret-storage'
import { createLocalSecretStorage } from '../local-secret-storage'
import { CredentialStore, MAAS_IDENTITY_NAMESPACE } from '../login/credential-store'

import { accountDataRoot, prepareAccountPaths } from './account-paths'
import { savedSkillsHome } from './skills-cli'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('技能 CLI 从真实密文恢复已过期的 JWT，保留账号归属和退出拦截，不改写登录记录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skills-login-'))
  roots.push(root)
  getPath.mockReturnValue(root)
  vi.stubEnv('LOCALAPPDATA', root)
  const userData = path.join(root, 'desktop')
  const keyFile = path.join(root, 'fixture.key')
  fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 })
  const storage = createLocalSecretStorage(keyFile)
  vi.spyOn(secretStorage, 'getAppSecretStorage').mockReturnValue(storage)
  const account = prepareAccountPaths({ data: accountDataRoot(root), userData }, MAAS_IDENTITY_NAMESPACE, 'fixture')
  vi.stubEnv('HERMES_HOME', account.home)
  const credentials = new CredentialStore(userData)
  credentials.save({ uid: 'fixture', token: 'fixture-login-token', maskedPhone: '138****0000', expiresAt: Date.now() - 60_000 })
  const file = path.join(userData, 'maas-login.enc')
  const original = fs.readFileSync(file)

  expect(await savedSkillsHome(userData)).toBe(account.home)
  expect(fs.readFileSync(file)).toEqual(original)
  expect(original.toString()).not.toContain('fixture-login-token')
  fs.writeFileSync(path.join(userData, 'maas-logout-pending.json'), '{}')
  await expect(savedSkillsHome(userData)).rejects.toThrow('账号正在退出')
  credentials.clear()
  await expect(savedSkillsHome(userData)).rejects.toThrow('请先在 UniWork 中登录')
})
