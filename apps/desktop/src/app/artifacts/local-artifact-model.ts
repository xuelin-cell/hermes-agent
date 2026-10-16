import { readKey, writeKey } from '@/lib/storage'
import type { SessionInfo } from '@/types/hermes'

import type { ArtifactRecord } from './artifact-utils'

export const LOCAL_ARTIFACT_TYPES = [
  'all',
  'document',
  'spreadsheet',
  'presentation',
  'pdf',
  'image',
  'video',
  'audio',
  'website',
  'markdown',
  'code',
  'other'
] as const
export type LocalArtifactType = (typeof LOCAL_ARTIFACT_TYPES)[number]
export interface LocalArtifact extends ArtifactRecord {
  resolvedPath?: string
  byteSize?: number
}
export interface LocalArtifactGroup {
  session: SessionInfo
  files: LocalArtifact[]
}

const EXTENSIONS: Partial<Record<LocalArtifactType, readonly string[]>> = {
  document: ['doc', 'docx', 'odt', 'rtf', 'txt'],
  spreadsheet: ['xls', 'xlsx', 'ods', 'csv', 'tsv'],
  presentation: ['ppt', 'pptx', 'odp'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'],
  website: ['html', 'htm'],
  markdown: ['md', 'mdx', 'markdown'],
  code: [
    'py',
    'js',
    'jsx',
    'ts',
    'tsx',
    'json',
    'css',
    'sql',
    'sh',
    'go',
    'rs',
    'java',
    'cpp',
    'c',
    'yaml',
    'yml',
    'xml',
    'toml'
  ]
}

// 收藏属于原生账号分区中的本机物理文件，不属于 Profile；重命名 Profile 不改变收藏。
const FAVORITES_KEY = 'hermes.desktop.localArtifactFavorites.v1'

/** 分享页是发布入口的链接，不是新产物；匹配专用路径，不按随机文件名猜测。 */
export function isPublishedArtifactLink(value: string): boolean {
  try {
    const url = new URL(value)

    return /^https?:$/.test(url.protocol) && /\/uniclaw-shares\/[^/]+\.html$/i.test(decodeURIComponent(url.pathname))
  } catch {
    return false
  }
}

/** 首屏缓存也排除分享链接及只有分享链接的会话，无变化时保持原引用。 */
export function withoutPublishedArtifactLinks(groups: LocalArtifactGroup[]): LocalArtifactGroup[] {
  let changed = false

  const next = groups.flatMap(group => {
    const files = group.files.filter(file => !isPublishedArtifactLink(file.value))

    if (files.length === group.files.length) {
      return [group]
    }

    changed = true

    return files.length ? [{ ...group, files }] : []
  })

  return changed ? next : groups
}

/** 按扩展名归类，未知格式保留在其他类型中。 */
export function localArtifactType(file: ArtifactRecord): LocalArtifactType {
  const ext = file.label.split('.').pop()?.toLowerCase() || ''

  return (
    LOCAL_ARTIFACT_TYPES.find(type => EXTENSIONS[type]?.includes(ext)) || (file.kind === 'image' ? 'image' : 'other')
  )
}

/** 会话缓存显式包含来源连接和 Profile，防止不同存储中的同名 ID 冲突。 */
export function localSessionKey(session: SessionInfo): string {
  return JSON.stringify([session.connection_id || 'local', session.profile || 'default', session.id])
}

/** 收藏用已解析的本机绝对路径标识，无法解析和外部链接不写入收藏。 */
export function localFavoriteKey(file: LocalArtifact): string | undefined {
  return file.resolvedPath ? JSON.stringify(['local', file.resolvedPath]) : undefined
}

/** 只接受合法的字符串集合，损坏或过期存储不会中断资料库。 */
export function readLocalFavorites(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readKey(FAVORITES_KEY) || '[]')

    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

/** 保存后回读核对，存储失败时不显示虚假的收藏成功状态。 */
export function writeLocalFavorites(favorites: ReadonlySet<string>): boolean {
  const encoded = JSON.stringify([...favorites])
  writeKey(FAVORITES_KEY, encoded)

  return readKey(FAVORITES_KEY) === encoded
}

/** 类型、收藏和搜索组合过滤；会话标题命中时保留该会话中的合格文件。 */
export function filterLocalArtifacts(
  groups: readonly LocalArtifactGroup[],
  query: string,
  type: LocalArtifactType,
  favoritesOnly: boolean,
  favorites: ReadonlySet<string>
): LocalArtifactGroup[] {
  const needle = query.trim().toLocaleLowerCase()

  return groups.flatMap(group => {
    const titleMatches = (group.session.title || group.files[0]?.sessionTitle || '')
      .toLocaleLowerCase()
      .includes(needle)

    const files = group.files.filter(
      file =>
        (type === 'all' || localArtifactType(file) === type) &&
        (!favoritesOnly || favorites.has(localFavoriteKey(file) || '')) &&
        (!needle || titleMatches || file.label.toLocaleLowerCase().includes(needle))
    )

    return files.length ? [{ ...group, files }] : []
  })
}

/** 相对路径只相对来源会话工作区解析，禁止借用当前聊天目录。 */
export function localArtifactPath(file: ArtifactRecord, session: SessionInfo): string | undefined {
  if (file.kind === 'link' || (file.connectionId && file.connectionId !== 'local')) {
    return undefined
  }

  if (/^https?:\/\//i.test(file.value)) {
    return undefined
  }

  if (!session.cwd && !/^(?:file:\/\/|[\\/]|[a-z]:[\\/]|~[\\/])/i.test(file.value)) {
    return undefined
  }

  // 原样交给主进程解析 UNC、盘符和用户目录，Renderer 不猜测本机路径语义。
  return file.value
}

/** 大小只展示主进程提供的有限数字，不为未知大小伪造零字节。 */
export function localArtifactSize(size?: number): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) {
    return '—'
  }

  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, size)) / Math.log(1024)))

  return `${unit ? (size / 1024 ** unit).toFixed(1) : size} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
