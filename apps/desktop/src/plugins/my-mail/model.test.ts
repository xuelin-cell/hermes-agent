import { describe, expect, it } from 'vitest'

import { groupMailMessages, mergeMailMessages, resolveMailFolders, type MailFolder, type MailMessage } from './model'

const folders: MailFolder[] = [
  { flags: [], name: '收件箱', path: 'INBOX', specialUse: '\\Inbox' },
  { flags: [], name: '已发送', path: 'Sent Messages', specialUse: '\\Sent' }
]

describe('My Mail model', () => {
  it('uses provider special-use metadata instead of guessing localized folder names', () => {
    expect(resolveMailFolders(folders)).toEqual({ inbox: 'INBOX', sent: 'Sent Messages' })
  })

  it('deduplicates appended pages and keeps newest messages first', () => {
    const newer = { date: '2026-10-20T03:00:00Z', folder: 'INBOX', uid: 3 } as MailMessage
    const older = { date: '2026-10-18T03:00:00Z', folder: 'INBOX', uid: 1 } as MailMessage
    const replacement = { ...older, subject: 'updated' }

    expect(mergeMailMessages([newer, older], [replacement])).toEqual([newer, replacement])
  })

  it('groups messages into stable recency sections', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    const messages = [
      { date: '2026-10-20T03:00:00Z', folder: 'INBOX', uid: 3 },
      { date: '2026-10-19T03:00:00Z', folder: 'INBOX', uid: 2 },
      { date: '2026-09-20T03:00:00Z', folder: 'INBOX', uid: 1 }
    ] as MailMessage[]

    expect(groupMailMessages(messages, now).map(group => group.key)).toEqual(['today', 'yesterday', 'earlier'])
  })
})
