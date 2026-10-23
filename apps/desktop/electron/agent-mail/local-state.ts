import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'
import type { LoginIdentity } from '../login/session'

const STATE_FILE = 'agent-mail-state.enc'
const STATE_VERSION = 1

export interface AgentMailLocalState {
  authorizationCode?: string
  email: string
  enabled: boolean
}

interface StoredState {
  records: Record<string, AgentMailLocalState>
  version: number
}

function recordKey(identity: LoginIdentity): string {
  const phone = identity.phone?.trim() ?? ''

  if (!identity.uid || !/^1\d{10}$/.test(phone)) {
    return ''
  }

  return createHash('sha256').update(`${identity.uid}\0${phone}`).digest('hex')
}

function validState(value: unknown): value is AgentMailLocalState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const row = value as Record<string, unknown>

  return (
    typeof row.email === 'string' &&
    typeof row.enabled === 'boolean' &&
    (row.authorizationCode === undefined || typeof row.authorizationCode === 'string')
  )
}

/** Encrypted, local-only Agent Mail recovery data, scoped to one login identity. */
export class AgentMailLocalStateStore {
  constructor(
    private readonly directory: string,
    private readonly encrypt: (value: string) => Buffer,
    private readonly decrypt: (value: Buffer) => string
  ) {}

  get(identity: LoginIdentity): AgentMailLocalState | null {
    const key = recordKey(identity)

    if (!key) {
      return null
    }

    try {
      const file = path.join(this.directory, STATE_FILE)
      const stat = fs.lstatSync(file, { throwIfNoEntry: false })

      if (!stat?.isFile() || stat.isSymbolicLink()) {
        return null
      }

      const parsed = JSON.parse(this.decrypt(fs.readFileSync(file))) as Partial<StoredState>

      if (parsed.version !== STATE_VERSION || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
        return null
      }

      const state = parsed.records[key]

      return validState(state) ? { ...state } : null
    } catch {
      return null
    }
  }

  save(identity: LoginIdentity, state: AgentMailLocalState): void {
    const key = recordKey(identity)

    if (!key || !validState(state)) {
      throw new Error('Invalid Agent Mail local state')
    }

    const records = this.readRecords()
    records[key] = { ...state }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeSecretFileAtomic(path.join(this.directory, STATE_FILE), this.encrypt(JSON.stringify({ records, version: STATE_VERSION })))
  }

  private readRecords(): Record<string, AgentMailLocalState> {
    const file = path.join(this.directory, STATE_FILE)
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })

    if (!stat?.isFile() || stat.isSymbolicLink()) {
      return {}
    }

    try {
      const parsed = JSON.parse(this.decrypt(fs.readFileSync(file))) as Partial<StoredState>

      if (parsed.version !== STATE_VERSION || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
        return {}
      }

      return Object.fromEntries(Object.entries(parsed.records).filter(([, value]) => validState(value)))
    } catch {
      return {}
    }
  }
}
