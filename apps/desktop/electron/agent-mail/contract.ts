export const AGENT_MAIL_CHANNEL = 'hermes:agent-mail'

export type AgentMailAction =
  | 'delete_email'
  | 'download_attachment'
  | 'get_email'
  | 'get_folder_status'
  | 'list_folders'
  | 'mark_email_read'
  | 'search_emails'
  /** Internal-only: downloads into an app-managed temporary file for the chat composer. */
  | 'stage_attachment'

export interface AgentMailRequest {
  operation: 'status' | 'enable' | 'disable' | 'action'
  profile: string
  action?: AgentMailAction
  input?: Record<string, unknown>
}

export interface AgentMailStatus {
  dailyQuota: number
  email: string
  enabled: boolean
  todaySent: number
}

export interface AgentMailResult {
  data?: unknown
  status: AgentMailStatus
}
