import { readWoMailQuotaStatus } from '../../services/open-connector/src/providers/wo_mail/quota'

export interface AgentMailQuotaStatus {
  dailyQuota: number
  todaySent: number
}

/** Read-only view of the quota ledger owned by the profile's connector runtime. */
export function readAgentMailQuotaStatus(
  connectorDirectory: string,
  email: string,
  now = new Date()
): AgentMailQuotaStatus {
  return readWoMailQuotaStatus(connectorDirectory, email, now)
}
