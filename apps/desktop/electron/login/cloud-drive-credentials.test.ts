import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

const { encryption } = vi.hoisted(() => ({
  encryption: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

vi.mock('electron', () => ({ safeStorage: encryption }))

import { CloudDriveClient } from './cloud-drive'
import { CloudDriveCredentials } from './cloud-drive-credentials'
import { installDriveCredentialRenewal } from './cloud-drive-renewal'
import { CloudDriveTokenStore } from './cloud-drive-token-store'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  encryption.isEncryptionAvailable.mockReturnValue(true)
  encryption.getSelectedStorageBackend.mockReturnValue('unknown')

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** 真实 HTTP 与临时密文文件验证主进程鉴权，系统密钥环用不可逆测试密文替身隔离。 */
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-credentials-'))
  roots.push(root)
  const encrypted = new Map<string, string>()
  encryption.encryptString.mockImplementation((text: string) => {
    const cipher = createHash('sha256').update(text).digest('hex')
    encrypted.set(cipher, text)

    return Buffer.from(cipher)
  })
  encryption.decryptString.mockImplementation((bytes: Buffer) => encrypted.get(bytes.toString())!)
  let now = Date.now()

  let identity = {
    uid: 'a',
    token: 'login-a',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: now + 60 * 86400_000
  }

  let logins = 0
  let reject = false
  const calls: Array<{ route: string; token?: string; body: string }> = []

  const server = createServer(async (request, response) => {
    const chunks = []

    for await (const chunk of request) {
      chunks.push(chunk)
    }

    const route = request.url!
    const token = request.headers['x-drive-access-token'] as string | undefined
    calls.push({ route, token, body: Buffer.concat(chunks).toString() })
    response.setHeader('Content-Type', 'application/json')

    if (route.endsWith('/access-token')) {
      response.end(JSON.stringify({ meta: { code: '' }, result: { accessToken: `cloud-${++logins}` } }))
    } else if (reject) {
      response.end(
        JSON.stringify({ ok: false, status: 'failed', error: { code: 'DRIVE_AUTH_EXPIRED', provider_code: '9999' } })
      )
    } else {
      response.end(JSON.stringify({ ok: true, status: 'succeeded', data: { items: [] } }))
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const request: typeof fetch = (url, options) =>
    fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, options)

  const store = new CloudDriveTokenStore(path.join(root, 'desktop-a'))
  const create = () => new CloudDriveClient(() => identity, request, { store, now: () => now })

  return {
    root,
    store,
    create,
    calls,
    logins: () => logins,
    expire: () => {
      now += 7 * 86400_000 + 1
    },
    account: (uid: string) => {
      identity = { ...identity, uid, token: `login-${uid}` }
    },
    reject: (value: boolean) => {
      reject = value
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

it('密文跨重启复用，七天到期续期；A→B→A 不串令牌，另一个账号目录不认领缓存', async () => {
  const f = await fixture()

  try {
    let client = f.create()
    await Promise.all([client.execute({ route: '/assets' }), client.execute({ route: '/asset-spaces' })])
    expect(f.logins()).toBe(1)
    client = f.create()
    await client.execute({ route: '/assets' })
    expect(f.logins()).toBe(1)
    f.expire()
    await Promise.all([client.renewCredentials(), client.execute({ route: '/assets' })])
    expect(f.logins()).toBe(2)
    f.account('b')
    await client.execute({ route: '/assets' })
    f.account('a')
    await client.execute({ route: '/assets' })
    expect(f.logins()).toBe(3)
    expect(f.calls.filter(c => c.route.endsWith('/assets')).map(c => c.token)).toEqual([
      'cloud-1',
      'cloud-1',
      'cloud-2',
      'cloud-3',
      'cloud-2'
    ])
    const files = fs.readdirSync(path.join(f.root, 'desktop-a', 'cloud-drive-tokens'))
    expect(files).toHaveLength(2)

    for (const name of files) {
      const file = path.join(f.root, 'desktop-a', 'cloud-drive-tokens', name)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(file).toString()).not.toMatch(/cloud-|login-|13800000000/)
    }

    const originalFile = path.join(f.root, 'desktop-a', 'cloud-drive-tokens', files[0])
    const original = fs.readFileSync(originalFile)

    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('native-private-detail')
    })

    expect(() =>
      f.store.save(files[0].slice(0, -4), { token: 'new-cloud-token', expiresAt: Date.now() + 60_000 })
    ).toThrow('安全保存')
    expect(fs.readFileSync(originalFile)).toEqual(original)
    rename.mockRestore()

    expect(new CloudDriveTokenStore(path.join(f.root, 'desktop-b')).load(files[0].slice(0, -4))).toBeNull()
    encryption.getSelectedStorageBackend.mockReturnValue('basic_text')
    expect(() => f.store.load(files[0].slice(0, -4))).toThrow('安全存储')
    encryption.getSelectedStorageBackend.mockReturnValue('unknown')
    client.clearCredentials()
    expect(fs.existsSync(path.join(f.root, 'desktop-a', 'cloud-drive-tokens'))).toBe(false)
  } finally {
    await f.close()
  }
})

it('并发过期只续期一次，持续拒绝在一分钟内不重复认证，写入与分片均不重放', async () => {
  const f = await fixture()

  try {
    const client = f.create()
    await client.execute({ route: '/assets' })
    f.reject(true)
    const reads = await Promise.allSettled([client.execute({ route: '/assets' }), client.execute({ route: '/assets' })])
    expect(reads.every(r => r.status === 'rejected')).toBe(true)
    expect(f.logins()).toBe(2)
    await expect(client.execute({ route: '/assets' })).rejects.toMatchObject({ result: { code: 'DRIVE_AUTH_EXPIRED' } })
    expect(f.logins()).toBe(2)
    const write = f.create()
    await expect(
      write.execute({ route: '/unicom/DeleteRecycleData', method: 'POST', body: { deleteNos: ['deleted-op'] } })
    ).rejects.toMatchObject({ result: { code: 'DRIVE_AUTH_EXPIRED' } })
    expect(f.calls.filter(c => c.route.endsWith('/DeleteRecycleData'))).toHaveLength(1)
    expect(f.logins()).toBe(3)
    await expect(
      write.uploadPart({ partIndex: 1, totalPart: 1 }, new Uint8Array([1]), new AbortController().signal)
    ).rejects.toMatchObject({ result: { code: 'DRIVE_AUTH_EXPIRED' } })
    expect(f.calls.filter(c => c.route.endsWith('/drive/upload-part'))).toHaveLength(1)
    expect(f.logins()).toBe(3)
  } finally {
    await f.close()
  }
})

it('账号切换和清除之后，迟到的令牌不落盘；失败续期的普通请求也遵守限频', async () => {
  let identity = { uid: 'a', token: 'a', expiresAt: Date.now() + 60_000, maskedPhone: '138****0000' }
  const pending: Array<(token: string) => void> = []
  const acquire = vi.fn(() => new Promise<string>(resolve => pending.push(resolve)))
  const store = { load: vi.fn(() => null), save: vi.fn(), clear: vi.fn() }
  const cache = new CloudDriveCredentials(() => identity, acquire, { store })
  const old = cache.get().catch(e => e)
  identity = { ...identity, uid: 'b', token: 'b' }
  const fresh = cache.get()
  pending[0]('old-token')
  expect(await old).toBeInstanceOf(Error)
  expect(store.save).not.toHaveBeenCalled()
  pending[1]('new-token')
  expect(await fresh).toBe('new-token')
  const recovered = cache.recover('new-token').catch(e => e)
  cache.clear()
  pending[2]('late-token')
  expect(await recovered).toBeInstanceOf(Error)
  expect(store.save).toHaveBeenCalledTimes(1)
  const failedAcquire = vi.fn().mockResolvedValueOnce('initial').mockRejectedValue(new Error('offline'))
  const failed = new CloudDriveCredentials(() => identity, failedAcquire)
  await failed.get()
  await expect(failed.recover('initial')).rejects.toThrow()
  await expect(failed.get()).rejects.toThrow()
  expect(failedAcquire).toHaveBeenCalledTimes(2)
})

it('三十分钟与唤醒检查使用同一入口，关闭后清除计时器及监听', async () => {
  vi.useFakeTimers()
  const power = new EventEmitter()
  const drive = { renewCredentials: vi.fn().mockResolvedValue(undefined) }
  const stop = installDriveCredentialRenewal(drive, power)
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
  expect(drive.renewCredentials).toHaveBeenCalledTimes(1)
  power.emit('resume')
  expect(drive.renewCredentials).toHaveBeenCalledTimes(2)
  stop()
  power.emit('resume')
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
  expect(drive.renewCredentials).toHaveBeenCalledTimes(2)
  expect(power.listenerCount('resume')).toBe(0)
})
