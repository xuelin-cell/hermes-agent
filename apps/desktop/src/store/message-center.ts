import { atom, computed } from 'nanostores'

import type { NtfyAnnouncement } from '../../electron/uniwork-notify/contract'

/** 公告按账号分区持久化；重启后仍在，已读状态也在这里。 */
const STORAGE_PREFIX = 'uniwork.desktop.messageCenter.v1'

/** 只留最近这么多条，避免长期运行把 localStorage 撑满。 */
export const MESSAGE_CENTER_LIMIT = 200

export interface AnnouncementRecord extends NtfyAnnouncement {
  /** 本地已读时间；null 表示未读。 */
  readAt: number | null
}

export const $announcements = atom<readonly AnnouncementRecord[]>([])

export const $unreadAnnouncements = computed($announcements, list => list.filter(item => item.readAt === null).length)

/** 铃铛弹出的消息中心是否展开。 */
export const $messageCenterOpen = atom(false)

/** 当前持久化归属（脱敏手机号）；空串表示没有登录账号。 */
let scope = ''

function keyFor(account: string): string {
  return `${STORAGE_PREFIX}:${account}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 记录只保留契约字段；坏记录整条丢弃，不让一条脏数据拖垮消息中心。 */
function normalizeRecord(value: unknown): AnnouncementRecord | null {
  if (!isRecord(value)) {
    return null
  }

  const { at, id, priority, readAt, text, title, topic } = value

  if (typeof id !== 'string' || !id || typeof at !== 'number' || !Number.isFinite(at)) {
    return null
  }

  return {
    at,
    id,
    priority: typeof priority === 'number' && Number.isFinite(priority) ? priority : 3,
    readAt: typeof readAt === 'number' && Number.isFinite(readAt) ? readAt : null,
    text: typeof text === 'string' ? text : '',
    title: typeof title === 'string' ? title : '',
    topic: typeof topic === 'string' ? topic : ''
  }
}

function readScope(account: string): AnnouncementRecord[] {
  try {
    const raw = window.localStorage.getItem(keyFor(account))
    const parsed: unknown = raw ? JSON.parse(raw) : []

    if (!Array.isArray(parsed)) {
      return []
    }

    const seen = new Set<string>()
    const records: AnnouncementRecord[] = []

    for (const item of parsed) {
      const record = normalizeRecord(item)

      if (record && !seen.has(record.id)) {
        seen.add(record.id)
        records.push(record)
      }
    }

    return records.slice(0, MESSAGE_CENTER_LIMIT)
  } catch {
    return []
  }
}

function write(text: readonly AnnouncementRecord[]): void {
  if (!scope) {
    return
  }

  try {
    window.localStorage.setItem(keyFor(scope), JSON.stringify(text))
  } catch {
    // 存储不可用时消息仍在本次会话内可用，不打断用户。
  }
}

/** 切换账号时重读该账号的消息；上一个账号的记录不留在当前窗口。 */
export function openMessageCenterScope(account: string | null): void {
  const next = account ?? ''

  if (next === scope) {
    return
  }

  scope = next
  $announcements.set(scope ? readScope(scope) : [])
  $messageCenterOpen.set(false)
}

/** 收到公告：按 id 去重（回填与重连会重放），按发布时间倒序插入。 */
export function receiveAnnouncement(announcement: NtfyAnnouncement): void {
  const current = $announcements.get()

  if (current.some(item => item.id === announcement.id)) {
    return
  }

  const merged = [...current, { ...announcement, readAt: null }]
    .sort((left, right) => right.at - left.at)
    .slice(0, MESSAGE_CENTER_LIMIT)

  $announcements.set(merged)
  write(merged)
}

export function markAnnouncementRead(id: string): void {
  const next = $announcements.get().map(item => (item.id === id && item.readAt === null ? { ...item, readAt: Date.now() } : item))

  $announcements.set(next)
  write(next)
}

export function markAllAnnouncementsRead(): void {
  const now = Date.now()
  const next = $announcements.get().map(item => (item.readAt === null ? { ...item, readAt: now } : item))

  $announcements.set(next)
  write(next)
}

export function toggleMessageCenter(open?: boolean): void {
  $messageCenterOpen.set(open ?? !$messageCenterOpen.get())
}

/** 测试与账号清理用：不经过 scope 直接清空当前窗口的公告。 */
export function resetMessageCenter(): void {
  $announcements.set([])
  $messageCenterOpen.set(false)
}
