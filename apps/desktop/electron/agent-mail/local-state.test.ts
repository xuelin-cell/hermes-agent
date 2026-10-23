import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import type { LoginIdentity } from '../login/session'

import { AgentMailLocalStateStore } from './local-state'

const roots: string[] = []

const identity = (phone = '13800138000', uid = 'account-a'): LoginIdentity => ({
  expiresAt: Date.now() + 60_000,
  maskedPhone: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
  phone,
  token: 'token',
  uid
})

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-state-'))
  roots.push(root)

  const states = new AgentMailLocalStateStore(root, value => Buffer.from(`encrypted:${value}`), value => {
    const text = value.toString()

    if (!text.startsWith('encrypted:')) {
      throw new Error('not encrypted')
    }

    return text.slice('encrypted:'.length)
  })

  return { root, states }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

it('keeps an enabled mailbox recovery record locally for its login identity', () => {
  const { states } = store()
  states.save(identity(), { authorizationCode: 'mail-code', email: '13800138000@wo.cn', enabled: true })

  expect(states.get(identity())).toEqual({ authorizationCode: 'mail-code', email: '13800138000@wo.cn', enabled: true })
})

it('does not expose one identity record to another account or phone', () => {
  const { states } = store()
  states.save(identity(), { authorizationCode: 'mail-code', email: '13800138000@wo.cn', enabled: true })

  expect(states.get(identity('13900139000'))).toBeNull()
  expect(states.get(identity('13800138000', 'account-b'))).toBeNull()
})

it('treats an unreadable local state file as a cache miss', () => {
  const { root, states } = store()
  fs.writeFileSync(path.join(root, 'agent-mail-state.enc'), 'not encrypted')

  expect(states.get(identity())).toBeNull()
})
