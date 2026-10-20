import type { SessionInfo } from '@/types/hermes'

/** 最近目录最多展示的条数，与 UniWork 一致。 */
export const RECENT_WORKDIR_LIMIT = 8

// 与 UniWork `_mount_policy.is_blacklisted_root` 相同：只拒绝这些目录本身，子目录允许。
const BLOCKED_WORKDIRS = new Set([
  '/',
  '/usr',
  '/etc',
  '/var',
  '/sys',
  '/proc',
  '/system',
  '/applications',
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/programdata',
  'c:/users',
  '/users',
  '/home'
])

/** 统一分隔符、大小写和末尾斜杠，只用于比较，不用于显示或发送。 */
export function workdirKey(path: string): string {
  const unified = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/, '') : unified

  return trimmed.toLowerCase()
}

/** 判断两个路径是否指向同一目录（Windows 路径不区分大小写）。 */
export function sameWorkdir(a: string, b: string): boolean {
  return workdirKey(a) !== '' && workdirKey(a) === workdirKey(b)
}

/** 系统目录、盘符根目录、用户主目录本身不允许作为工作目录。 */
export function isBlockedWorkdir(path: string): boolean {
  const key = workdirKey(path)

  if (!key || BLOCKED_WORKDIRS.has(key)) {
    return true
  }

  const parts = key.split('/').filter(Boolean)

  // `C:` 或 `C:/` 这样的盘符根目录。
  if (parts.length === 1 && /^[a-z]:$/.test(parts[0])) {
    return true
  }

  // `C:/Users/<名字>` 这样的用户主目录本身。
  if (parts.length === 3 && /^[a-z]:$/.test(parts[0]) && parts[1] === 'users') {
    return true
  }

  // `/Users/<名字>`、`/home/<名字>`。
  return key.startsWith('/') && parts.length === 2 && (parts[0] === 'users' || parts[0] === 'home')
}

/** 取路径最后一级作为按钮上的短名称。 */
export function workdirName(path: string): string {
  const parts = path.trim().split(/[/\\]+/).filter(Boolean)

  return parts.at(-1) ?? path.trim()
}

/** 从已有会话中整理最近用过的目录：按最近活动排序、去重，并排除默认工作区和 `skip` 认出的目录。 */
export function recentWorkdirs(
  sessions: readonly Pick<SessionInfo, 'cwd' | 'last_active'>[],
  exclude: readonly string[] = [],
  skip: (path: string) => boolean = () => false
): string[] {
  const seen = new Set(exclude.map(workdirKey).filter(Boolean))
  const result: string[] = []

  for (const session of [...sessions].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0))) {
    const cwd = session.cwd?.trim()
    const key = cwd ? workdirKey(cwd) : ''

    if (!cwd || seen.has(key) || skip(cwd)) {
      continue
    }

    seen.add(key)
    result.push(cwd)

    if (result.length >= RECENT_WORKDIR_LIMIT) {
      break
    }
  }

  return result
}
