export interface MailFolder {
  flags: string[]
  name: string
  path: string
  specialUse: null | string
}

export interface MailAddress {
  email: null | string
  name: null | string
}

export interface MailMessage {
  date: null | string
  flags: string[]
  folder: string
  from: MailAddress | null
  hasAttachments: boolean
  seen: boolean
  subject: null | string
  to: MailAddress[]
  uid: number
}

export interface MailDetail extends MailMessage {
  attachments: MailAttachment[]
  cc: MailAddress[]
  html: null | string
  text: null | string
}

export interface MailAttachment {
  attachmentId: string
  contentId: null | string
  contentType: null | string
  filename: null | string
  size: null | number
}

export function resolveMailFolders(folders: readonly MailFolder[]): { inbox: string; sent: string } {
  return {
    inbox: folders.find(folder => folder.specialUse?.toLowerCase() === '\\inbox')?.path ?? 'INBOX',
    sent:
      folders.find(folder => ['\\sent', '\\sentmail'].includes(folder.specialUse?.toLowerCase() ?? ''))?.path ?? 'Sent'
  }
}

export function mergeMailMessages(current: readonly MailMessage[], incoming: readonly MailMessage[]): MailMessage[] {
  const merged = new Map(current.map(message => [`${message.folder}:${message.uid}`, message]))

  for (const message of incoming) {
    merged.set(`${message.folder}:${message.uid}`, message)
  }

  return [...merged.values()].sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''))
}

export function groupMailMessages(messages: readonly MailMessage[], now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const groups = [
    { key: 'today', items: [] as MailMessage[] },
    { key: 'yesterday', items: [] as MailMessage[] },
    { key: 'earlier', items: [] as MailMessage[] }
  ]

  for (const message of messages) {
    const time = Date.parse(message.date ?? '')
    groups[time >= start ? 0 : time >= start - 86_400_000 ? 1 : 2].items.push(message)
  }

  return groups.filter(group => group.items.length > 0)
}

export function addressLabel(address: MailAddress | null): string {
  return address?.name?.trim() || address?.email?.trim() || ''
}
