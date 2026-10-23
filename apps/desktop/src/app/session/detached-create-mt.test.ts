import { beforeEach, describe, expect, it } from 'vitest'

import {
  _resetDetachedCreateForTests,
  bumpFreshDraftEpoch,
  currentFreshDraftEpoch,
  type DetachCreateInput,
  markDetachedCreate,
  pendingNewChatSubmitLockKey,
  shouldDetachCreate,
  takeDetachedCreate
} from './detached-create-mt'

/** 发送后又开了一个新对话、其他条件都满足转后台的输入。 */
function detachable(overrides: Partial<DetachCreateInput> = {}): DetachCreateInput {
  const startEpoch = currentFreshDraftEpoch()
  bumpFreshDraftEpoch()

  return {
    createdWithOverrides: false,
    nowConnection: 'http://127.0.0.1:9119',
    nowProfile: 'default',
    startConnection: 'http://127.0.0.1:9119',
    startEpoch,
    startProfile: 'default',
    stored: 'stored-a',
    switching: false,
    ...overrides
  }
}

beforeEach(() => _resetDetachedCreateForTests())

describe('新对话发出后又开了新对话时转后台', () => {
  it('发送后开了新对话才转后台', () => {
    expect(shouldDetachCreate(detachable())).toBe(true)
    expect(shouldDetachCreate({ ...detachable(), startEpoch: currentFreshDraftEpoch() })).toBe(false)
  })

  it.each([
    ['没拿到 stored id', { stored: null }],
    ['新手引导等带参数的创建', { createdWithOverrides: true }],
    ['正在切换连接', { switching: true }],
    ['连接换了', { nowConnection: 'http://other' }],
    ['身份换了', { nowProfile: 'work' }]
  ])('%s时不转后台', (_name, overrides) => {
    expect(shouldDetachCreate(detachable(overrides))).toBe(false)
  })

  it('新对话的提交锁按代次区分', () => {
    const first = pendingNewChatSubmitLockKey()
    bumpFreshDraftEpoch()

    expect(pendingNewChatSubmitLockKey()).not.toBe(first)
    expect(pendingNewChatSubmitLockKey()).toBe(pendingNewChatSubmitLockKey())
  })

  it('转后台的记录由发起发送的一方取走一次', () => {
    markDetachedCreate('rt-a', 'stored-a')

    expect(takeDetachedCreate('rt-b')).toBeNull()
    expect(takeDetachedCreate('rt-a')).toBe('stored-a')
    expect(takeDetachedCreate('rt-a')).toBeNull()
    expect(takeDetachedCreate(null)).toBeNull()
  })

  it('没人取的记录只留最近的几条', () => {
    for (let i = 0; i < 30; i++) {
      markDetachedCreate(`rt-${i}`, `stored-${i}`)
    }

    expect(takeDetachedCreate('rt-0')).toBeNull()
    expect(takeDetachedCreate('rt-29')).toBe('stored-29')
  })
})
