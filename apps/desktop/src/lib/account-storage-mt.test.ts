import { beforeEach, describe, expect, it } from 'vitest'

import { scopeStorageToAccount } from './account-storage-mt'

function memoryStorage(limit = Infinity): Storage {
  const data = new Map<string, string>()

  return {
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size
    },
    removeItem: key => void data.delete(key),
    setItem: (key, value) => {
      const size = Array.from(data.entries()).reduce((sum, [k, v]) => sum + k.length + v.length, 0)

      if (size - (data.get(key)?.length ?? 0) + value.length > limit) {
        throw new DOMException('full', 'QuotaExceededError')
      }

      data.set(key, value)
    }
  }
}

function snapshot(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {}

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)!

    out[key] = storage.getItem(key)!
  }

  return out
}

describe('local state per account (desktop-mt)', () => {
  let storage: Storage

  beforeEach(() => {
    storage = memoryStorage()
  })

  it('leaves what was there to the first account seen', () => {
    storage.setItem('hermes.desktop.lastSessionId', 's-1')
    scopeStorageToAccount('u-1', storage)

    expect(storage.getItem('hermes.desktop.lastSessionId')).toBe('s-1')
    expect(storage.getItem('hermes.mt.account.v1')).toBe('u-1')

    scopeStorageToAccount('u-1', storage) // every start: nothing moves
    expect(storage.getItem('hermes.desktop.lastSessionId')).toBe('s-1')
  })

  it('puts one account away and brings the other back, keeping the shared keys', () => {
    scopeStorageToAccount('u-1', storage)
    storage.setItem('hermes.desktop.lastSessionId', 's-1')
    storage.setItem('hermes:composer-drafts:v3', '{"draft":"写给一号的"}')
    storage.setItem('hermes-desktop-theme-v2', 'dark')
    storage.setItem('hermes.cloud.auth.v1:/agents/api', '{"token":"sso"}')

    scopeStorageToAccount('ent:t-1:member:m-1', storage)
    expect(storage.getItem('hermes.desktop.lastSessionId')).toBeNull()
    expect(storage.getItem('hermes:composer-drafts:v3')).toBeNull()
    expect(storage.getItem('hermes-desktop-theme-v2')).toBe('dark')
    expect(storage.getItem('hermes.cloud.auth.v1:/agents/api')).toBe('{"token":"sso"}')
    storage.setItem('hermes.desktop.lastSessionId', 's-9')

    scopeStorageToAccount('u-1', storage)
    expect(storage.getItem('hermes.desktop.lastSessionId')).toBe('s-1')
    expect(storage.getItem('hermes:composer-drafts:v3')).toBe('{"draft":"写给一号的"}')
    expect(snapshot(storage)['hermes.mt.account-archive.v1:u-1']).toBeUndefined() // brought back, archive gone

    scopeStorageToAccount('ent:t-1:member:m-1', storage)
    expect(storage.getItem('hermes.desktop.lastSessionId')).toBe('s-9')
  })

  it('drops the previous account rather than handing it on when storage is full', () => {
    storage = memoryStorage(130)
    scopeStorageToAccount('u-1', storage)
    storage.setItem('k', 'x'.repeat(100))

    scopeStorageToAccount('u-2', storage)
    expect(storage.getItem('k')).toBeNull()
    expect(storage.getItem('hermes.mt.account.v1')).toBe('u-2')
    expect(storage.getItem('hermes.mt.account-archive.v1:u-1')).toBeNull() // did not fit: gone, not handed on
  })

  it('starts an account afresh when its archive is broken', () => {
    scopeStorageToAccount('u-1', storage)
    storage.setItem('hermes.mt.account-archive.v1:u-2', '{not json')
    scopeStorageToAccount('u-2', storage)

    expect(storage.getItem('hermes.mt.account.v1')).toBe('u-2')
    expect(storage.getItem('hermes.mt.account-archive.v1:u-2')).toBeNull()
  })
})
