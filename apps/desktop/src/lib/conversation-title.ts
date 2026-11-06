import { atom } from 'nanostores'

import type { ComposerAttachment } from '@/store/composer'
import type { SessionInfo } from '@/types/hermes'

/** 发送即显示用户文字；纯粘贴使用原文预览，纯附件使用实际文件名。 */
export function temporaryConversationTitle(
  text: string,
  attachments: Pick<ComposerAttachment, 'label' | 'titlePreview'>[]
): string {
  const pasted = attachments.find(item => item.titlePreview?.trim())?.titlePreview

  const files = attachments.length
    ? attachments[0].label + (attachments.length > 1 ? ` 等${attachments.length}个文件` : '')
    : ''

  const value = (text.trim() || pasted?.trim() || files || '新会话')
    .replace(/[\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const units = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].map(item => item.segment)

  return units.length <= 24 ? value : units.slice(0, 23).join('') + '…'
}

export interface TitleOwner {
  profile?: string | null
  connectionId?: string | null
}

/** 显式比较后端及Profile；相同会话ID不代表同一个账号上下文。 */
export function titleOwnerMatches(row: SessionInfo, owner: TitleOwner): boolean {
  return (
    (row.profile?.trim() || 'default') === (owner.profile?.trim() || 'default') &&
    (row.connection_id?.trim() || 'local') === (owner.connectionId?.trim() || 'local')
  )
}

export const $titleRevision = atom(0)
let revision = 0
const observations = new Map<string, { revision: number; title: string | null }>()

/** 标题只在窗口内记录版本，用来拒绝较早发出的列表响应；重启仍以原生数据库为准。 */
export function titleReadRevision(): number {
  return revision
}

/** 使用后端/Profile/持久谱系隔离观测，不使用当前选中的运行时ID。 */
function keys(row: SessionInfo): string[] {
  return [...new Set([row.id, row._lineage_root_id, ...(row._lineage_ids ?? [])].filter(Boolean))].map(id =>
    JSON.stringify([row.connection_id || 'local', row.profile || 'default', id])
  )
}

/** 保存已确认标题事件的版本，手动改名和自动命名共用同一保护。 */
export function observeTitle(row: SessionInfo, title: string | null): void {
  const value = { revision: ++revision, title }

  for (const key of keys(row)) {
    observations.delete(key)
    observations.set(key, value)
  }

  while (observations.size > 2000) {
    observations.delete(observations.keys().next().value!)
  }

  $titleRevision.set(revision)
}

/** 较旧请求不能覆盖等待期间已收到的标题；新请求仍接受服务器上的手动更改。 */
export function reconcileTitleRead(row: SessionInfo, started: number): SessionInfo {
  const latest = keys(row)
    .map(key => observations.get(key))
    .filter(Boolean)
    .sort((a, b) => b!.revision - a!.revision)[0]

  if (!latest) {
    return row
  }

  if (latest.revision > started) {
    return latest.title !== row.title ? { ...row, title: latest.title } : row
  }

  // 新发出的权威读取可看到其他窗口的手动更改，更新项目快照的同一观测缓存。
  if (latest.title !== (row.title || null)) {
    observeTitle(row, row.title || null)
  }

  return row
}
