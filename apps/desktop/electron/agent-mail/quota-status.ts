import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AgentMailQuotaStatus {
  dailyQuota: number
  todaySent: number
}

export function readAgentMailQuotaStatus(
  connectorDirectory: string,
  email: string,
  now = new Date()
): AgentMailQuotaStatus {
  const fallback = { dailyQuota: 50, todaySent: 0 }

  if (!email.trim()) {
    return fallback
  }

  try {
    const file = path.join(connectorDirectory, 'agent-mail-quota.json')
    const stat = fs.lstatSync(file)

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      return fallback
    }

    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

    if (value.version !== 1 || typeof value.salt !== 'string' || !/^[a-f0-9]{64}$/.test(value.salt)) {
      return fallback
    }

    const accounts = value.accounts

    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
      return fallback
    }

    const key = createHash('sha256').update(`${value.salt}\0${email.trim().toLowerCase()}`).digest('hex')
    const row = (accounts as Record<string, unknown>)[key] as Record<string, unknown> | undefined
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const sent = row?.sent

    return {
      dailyQuota: 50,
      todaySent:
        row?.date === date && Number.isInteger(sent) && Number(sent) >= 0 && Number(sent) <= 50 ? Number(sent) : 0
    }
  } catch {
    return fallback
  }
}
