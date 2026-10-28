import type { AgentMailAction } from '../../../electron/agent-mail/contract'

import type { MailDetail, MailFolder, MailMessage } from './model'

async function request(profile: string, operation: 'status' | 'enable' | 'disable') {
  if (!window.hermesDesktop?.agentMail) {
    throw new Error('当前环境尚未接通智能体邮箱，请更新应用后重试。')
  }

  return window.hermesDesktop.agentMail({ operation, profile })
}

async function action<T>(profile: string, name: AgentMailAction, input: Record<string, unknown>): Promise<T> {
  const result = await window.hermesDesktop.agentMail({ action: name, input, operation: 'action', profile })

  return result.data as T
}

export const mailStatus = (profile: string) => request(profile, 'status')
export const enableMail = (profile: string) => request(profile, 'enable')
export const disableMail = (profile: string) => request(profile, 'disable')
export const listFolders = (profile: string) => action<{ folders: MailFolder[] }>(profile, 'list_folders', {})
export const listMessages = (profile: string, folder: string, beforeUid?: number) =>
  action<{ emails: MailMessage[]; nextBeforeUid: null | number }>(profile, 'search_emails', {
    folder,
    limit: 10,
    ...(beforeUid ? { beforeUid } : {})
  })
export const searchMessages = (profile: string, folder: string, query: string) =>
  action<{ emails: MailMessage[]; nextBeforeUid: null | number }>(profile, 'search_emails', {
    folder,
    limit: 50,
    text: query
  })
export const getMessage = (profile: string, folder: string, uid: number) =>
  action<MailDetail>(profile, 'get_email', { folder, uid })
export const downloadAttachment = (profile: string, folder: string, uid: number, attachmentId: string) =>
  action<{ file: { downloadUrl: string } }>(profile, 'download_attachment', { attachmentId, folder, uid })
export const markRead = (profile: string, folder: string, uid: number) =>
  action(profile, 'mark_email_read', { folder, uid })
export const deleteMessage = (profile: string, folder: string, uid: number) =>
  action(profile, 'delete_email', { folder, uid })
