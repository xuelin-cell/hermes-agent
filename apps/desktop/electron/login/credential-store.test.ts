import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

const { storage } = vi.hoisted(() => ({
  storage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    getSelectedStorageBackend: vi.fn()
  }
}))

vi.mock('electron', () => ({ safeStorage: storage }))

import { CredentialStore, MAAS_IDENTITY_NAMESPACE } from './credential-store'

const roots: string[] = []

const identity = {
  uid: 'fixture-uid',
  token: 'fixture-token',
  expiresAt: Date.now() + 60_000,
  maskedPhone: '138****0000'
}

/** 创建只属于本测试的凭据目录，不接触真实桌面数据。 */
function fixture(): { store: CredentialStore; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-login-store-'))
  roots.push(root)
  storage.isEncryptionAvailable.mockReturnValue(true)
  storage.getSelectedStorageBackend.mockReturnValue('unknown')

  return { store: new CredentialStore(root), file: path.join(root, 'maas-login.enc') }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('整份身份加密后原子替换；加密和替换失败不损坏原文件，也不写明文', () => {
  const { store, file } = fixture()
  expect(store.load()).toBeNull()
  const cipher = Buffer.from('fixture-encrypted-blob')
  storage.encryptString.mockReturnValue(cipher)
  store.save(identity)
  const record = { namespace: MAAS_IDENTITY_NAMESPACE, ...identity }
  expect(JSON.parse(storage.encryptString.mock.calls[0][0])).toEqual(record)
  expect(fs.readFileSync(file)).toEqual(cipher)
  expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  storage.decryptString.mockReturnValue(JSON.stringify(record))
  expect(new CredentialStore(path.dirname(file)).load()).toEqual(record)
  storage.isEncryptionAvailable.mockReturnValue(false)
  expect(() => store.save(identity)).toThrow()
  expect(() => store.load()).toThrow()
  expect(fs.readFileSync(file)).toEqual(cipher)
  storage.isEncryptionAvailable.mockReturnValue(true)
  storage.encryptString.mockImplementationOnce(() => {
    throw new Error('private-keyring-detail')
  })
  expect(() => store.save(identity)).toThrow()
  expect(fs.readFileSync(file)).toEqual(cipher)
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('private-write-detail')
  })
  expect(() => store.save({ ...identity, uid: 'another-uid' })).toThrow()
  expect(fs.readFileSync(file)).toEqual(cipher)
  expect(fs.readFileSync(`${file}.tmp`)).toEqual(cipher)
  store.save({ ...identity, uid: 'another-uid' })
  expect(fs.existsSync(`${file}.tmp`)).toBe(false)
})

it('损坏、无法解密和字段错配都拒绝读取，原始文件保留且不回退明文', () => {
  const { store, file } = fixture()
  const cipher = Buffer.from('unreadable-original')
  fs.writeFileSync(file, cipher)
  storage.decryptString.mockImplementationOnce(() => {
    throw new Error('private-decrypt-detail')
  })
  expect(() => store.load()).toThrow()

  const record = { namespace: MAAS_IDENTITY_NAMESPACE, ...identity }

  for (const invalid of [
    null,
    [],
    {},
    { ...record, namespace: 'another-platform' },
    { ...record, uid: '' },
    { ...record, uid: 123 },
    { ...record, token: '' },
    { ...record, expiresAt: 'tomorrow' },
    { ...record, expiresAt: 0 },
    { ...record, expiresAt: Number.MAX_SAFE_INTEGER },
    { ...record, maskedPhone: '13800000000' }
  ]) {
    storage.decryptString.mockReturnValueOnce(JSON.stringify(invalid))
    expect(() => store.load()).toThrow()
    expect(fs.readFileSync(file)).toEqual(cipher)
  }

  storage.decryptString.mockReturnValueOnce('not-json')
  expect(() => store.load()).toThrow()
  expect(() => store.save({ ...identity, token: '' })).toThrow()
  expect(storage.encryptString).not.toHaveBeenCalled()
  expect(fs.readFileSync(file)).toEqual(cipher)
  storage.decryptString.mockReturnValueOnce(JSON.stringify({ ...record, expiresAt: 1 }))
  expect(store.load()?.expiresAt).toBe(1) // 读取旧记录不等于允许恢复到期身份。
  fs.rmSync(file)
  fs.mkdirSync(file)
  expect(() => store.load()).toThrow()
})
