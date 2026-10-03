import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { loadNativeTokenSet, persistNativeTokenSet } from '../native-token-store'
import { recordDismissed, wasDismissed } from '../plugin-compat-notice'
import { readSecretStoragePolicy, writeSecretStoragePolicy } from '../secret-storage-policy'

import { prepareAccountPaths } from './account-paths'
import { accountDesktopStatePaths } from './desktop-state'

test('账号状态路径固定在已准备的目录内，A→B→A 不改变安装或全局目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mt-state-'))
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
  const a = prepareAccountPaths(roots, 'fixture-platform', 'A')
  const b = prepareAccountPaths(roots, 'fixture-platform', 'B')
  const paths = accountDesktopStatePaths(a)

  expect(accountDesktopStatePaths(a)).toEqual(paths)
  expect(Object.isFrozen(paths)).toBe(true)

  for (const [key, value] of Object.entries(paths)) {
    expect(path.dirname(value)).toBe(a.desktopState)
    expect(value).not.toBe(accountDesktopStatePaths(b)[key as keyof typeof paths])
  }

  expect(fs.readdirSync(a.desktopState)).toEqual([])
  expect(fs.readdirSync(b.desktopState)).toEqual([])
})

test('原版凭据、加密策略和插件提示通过真实文件读写按账号复用，同网关不会覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mt-state-'))
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
  const a = prepareAccountPaths(roots, 'fixture-platform', 'A')
  const b = prepareAccountPaths(roots, 'fixture-platform', 'B')
  const gateway = 'https://fixture.invalid'

  for (const account of [a, b, a]) {
    const paths = accountDesktopStatePaths(account)

    const io = {
      readStoreText: () => fs.readFileSync(paths.nativeTokens, 'utf8'),
      writeStoreText: (text: string) => fs.writeFileSync(paths.nativeTokens, text),
      encrypt: (value: string) => ({ encoding: 'fixture', value }),
      decrypt: (secret: { value: string }) => secret.value
    }

    const policy = {
      readText: () => fs.readFileSync(paths.secretStoragePolicy, 'utf8'),
      writeText: (text: string) => fs.writeFileSync(paths.secretStoragePolicy, text)
    }

    const existing = loadNativeTokenSet(gateway, io)

    if (existing) {
      expect(existing.userId).toBe(a.id)
      expect(readSecretStoragePolicy(policy).on).toBe(true)
      expect(wasDismissed(account.desktopState, 'same-plugin-report')).toBe(true)
    } else {
      expect(wasDismissed(account.desktopState, 'same-plugin-report')).toBe(false)
      expect(readSecretStoragePolicy(policy).on).toBe(false)
      persistNativeTokenSet(
        gateway,
        {
          userId: account.id,
          accessToken: `access-${account.id}`,
          refreshToken: `refresh-${account.id}`,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          provider: 'fixture'
        },
        io
      )
      writeSecretStoragePolicy({ on: account.id === a.id, migrated: true }, policy)

      if (account.id === a.id) {recordDismissed(account.desktopState, 'same-plugin-report')}
    }
  }

  expect(fs.existsSync(path.join(roots.userData, 'native-oauth-tokens.json'))).toBe(false)
})
