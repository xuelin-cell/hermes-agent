import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { createLocalSecretStorage, LegacySecretFormatError } from './local-secret-storage'
import { preserveLegacyConnector } from './open-connector/legacy-secrets'

// 验证真实文件加密、重启恢复及损坏保护，不触及 Electron 或系统钥匙串。
test('local secrets survive a new instance and reject tampering without replacing keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-secrets-'))

  try {
    const key = path.join(root, 'secret.key')
    const first = createLocalSecretStorage(key)
    const encrypted = first.encryptString('test-token')
    expect(createLocalSecretStorage(key).decryptString(encrypted)).toBe('test-token')
    expect(first.encryptString('test-token')).not.toEqual(encrypted)

    if (process.platform !== 'win32') {expect(fs.statSync(key).mode & 0o777).toBe(0o600)}
    expect(() => first.decryptString(Buffer.from('old-system-ciphertext'))).toThrow(LegacySecretFormatError)
    const tampered = Buffer.from(encrypted)
    tampered[tampered.length - 1] ^= 1
    expect(() => first.decryptString(tampered)).toThrow()
    fs.writeFileSync(key, 'broken')
    expect(first.isEncryptionAvailable()).toBe(false)
    expect(() => first.encryptString('next-token')).toThrow()
    expect(fs.readFileSync(key, 'utf8')).toBe('broken')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 模拟备份在移动密钥后中断；恢复后保留旧库，后续启动不搬走新库。
test('connector legacy backup resumes and preserves the replacement database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-connectors-'))

  try {
    const backup = path.join(root, 'legacy-keychain-backup')
    fs.mkdirSync(backup)
    fs.writeFileSync(path.join(backup, 'secrets.enc'), 'old-key')
    fs.writeFileSync(path.join(root, 'connect.sqlite'), 'old-database')
    preserveLegacyConnector(root)
    expect(fs.readFileSync(path.join(backup, 'connect.sqlite'), 'utf8')).toBe('old-database')
    fs.writeFileSync(path.join(root, 'connect.sqlite'), 'new-database')
    preserveLegacyConnector(root)
    expect(fs.readFileSync(path.join(root, 'connect.sqlite'), 'utf8')).toBe('new-database')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
