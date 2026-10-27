import { hermesApi } from '@/api/client'
import { getAllSessionMessages, listAllProfileSessions } from '@/hermes'
import type { PaginatedSessions, SessionInfo } from '@/types/hermes'

import { collectDeliveredLocalArtifacts } from './local-artifact-delivery'
import {
  isPublishedArtifactLink,
  type LocalArtifactGroup,
  localArtifactPath,
  localSessionKey
} from './local-artifact-model'
import { artifactFileResolver, usesInstanceArtifactLibrary } from './local-artifact-platform'

export interface LocalArtifactScan {
  groups: LocalArtifactGroup[]
  processed: number
  total: number
  failures: number
  scanning: boolean
}
export interface LocalArtifactCache {
  extractionVersion?: number
  stamp: string
  group: LocalArtifactGroup
}

const EXTRACTION_VERSION = 1

/** 旧版缓存没有交付依据，不能在首屏或读取失败时重新显示过程文件。 */
export function cachedLocalArtifactGroups(cache: ReadonlyMap<string, LocalArtifactCache>): LocalArtifactGroup[] {
  return [...cache.values()]
    .filter(value => value.extractionVersion === EXTRACTION_VERSION)
    .map(value => value.group)
    .filter(group => group.files.length)
}

export interface LocalArtifactSessionList {
  sessions: SessionInfo[]
  failures: number
}

/** 首次聚合读取后按 Profile 补齐超过聚合上限的历史，不把固定窗口当成全量。 */
export async function listLocalArtifactSessions(isCurrent: () => boolean): Promise<LocalArtifactSessionList> {
  const first = await listAllProfileSessions(500, 1, 'include')

  const sessions = new Map(
    first.sessions
      .filter(row => (!row.connection_id || row.connection_id === 'local') &&
        (!usesInstanceArtifactLibrary() || !row.profile || row.profile === 'default'))
      .map(row => [localSessionKey(row), { ...row, connection_id: 'local' }])
  )

  let failures = first.errors?.length || 0

  for (const [profile, total] of Object.entries(first.profile_totals || {})) {
    if (usesInstanceArtifactLibrary() && profile !== 'default') {
      continue
    }

    let offset = [...sessions.values()].filter(row => (row.profile || 'default') === profile).length

    if (offset >= total) {
      continue
    }

    // 每个 Profile 单独分页绕过聚合接口每库 500 条的限制，固定每页大小限制瞬时内存。
    offset = 0

    while (offset < total && isCurrent()) {
      try {
        const page = await hermesApi<PaginatedSessions>({
          connectionId: 'local',
          profile,
          path: `/api/sessions?limit=100&offset=${offset}&min_messages=1&archived=include&order=recent`,
          timeoutMs: 60_000
        })

        if (!isCurrent()) {
          break
        }

        let added = 0

        for (const row of page.sessions) {
          if (row.connection_id && row.connection_id !== 'local') {
            continue
          }

          const tagged = { ...row, profile, connection_id: 'local' }

          if (!sessions.has(localSessionKey(tagged))) {
            added += 1
          }

          sessions.set(localSessionKey(tagged), tagged)
        }

        offset += page.limit || 100

        if (!page.sessions.length || (offset > 500 && !added)) {
          if (offset < total) {
            failures += 1
          }

          break
        }
      } catch {
        failures += 1

        break
      }
    }
  }

  return { sessions: [...sessions.values()].sort((a, b) => b.last_active - a.last_active), failures }
}

/** 一次只保留一个会话的消息；缓存提取结果，不缓存大段正文，失败和活跃会话可重试。 */
export async function scanLocalArtifacts(
  sessions: readonly SessionInfo[],
  cache: Map<string, LocalArtifactCache>,
  isCurrent: () => boolean,
  publish: (scan: LocalArtifactScan) => void,
  initialFailures = 0
): Promise<void> {
  const resolveFile = artifactFileResolver()
  const valid = new Set(sessions.map(localSessionKey))

  for (const [key, entry] of cache) {
    if (!valid.has(key) || entry.extractionVersion !== EXTRACTION_VERSION) {
      cache.delete(key)
    }
  }

  const results = new Map<string, LocalArtifactGroup>()

  for (const session of sessions) {
    const previous = cache.get(localSessionKey(session))?.group

    if (previous?.files.length) {
      results.set(localSessionKey(session), previous)
    }
  }

  /** 按本次会话顺序发布，缓存中的未扫描组在后台刷新时保持可见。 */
  const groups = () =>
    sessions.flatMap(session => {
      const group = results.get(localSessionKey(session))

      return group ? [group] : []
    })

  let failures = initialFailures
  let processed = 0

  for (const session of sessions) {
    if (!isCurrent()) {
      return
    }

    const key = localSessionKey(session)

    const stamp = JSON.stringify([
      session.last_active,
      session.message_count,
      session.archived,
      session.cwd,
      session.is_active
    ])

    try {
      let group = !session.is_active && cache.get(key)?.stamp === stamp ? cache.get(key)!.group : undefined

      if (!group) {
        const result = await getAllSessionMessages(
          session.id,
          {
            connectionId: session.connection_id || 'local',
            profile: session.profile || 'default'
          },
          { passive: true }
        )

        if (!isCurrent()) {
          return
        }

        group = { session, files: collectDeliveredLocalArtifacts(session, result.messages) }
      }

      const files = []
      const seen = new Set<string>()

      for (const file of group.files) {
        if (!isCurrent()) {
          return
        }

        // 新扫描及已有提取缓存共用同一规则，分享页不参与文件读取和产物计数。
        if (isPublishedArtifactLink(file.value)) {
          continue
        }

        const candidate = localArtifactPath(file, session)

        if (!candidate) {
          continue
        }

        // 文件边界核对路径和存在性；云端目录读取失败进入降级提示，不能当成空资料库。
        const metadata = await resolveFile(candidate, session.cwd || undefined).catch(error => {
          if (usesInstanceArtifactLibrary()) {
            throw error
          }

          return null
        })

        if (!isCurrent()) {
          return
        }

        if (metadata?.kind !== 'file' || !metadata.path || seen.has(metadata.path)) {
          continue
        }

        seen.add(metadata.path)
        // 使用原生文件名，既还原 file URL 的中文，也保留真实名称中的字面 %，不再二次解码。
        files.push({
          ...file,
          value: usesInstanceArtifactLibrary() ? metadata.path : file.value,
          id: `${key}:${metadata.path}`,
          label: metadata.label,
          resolvedPath: metadata.path,
          byteSize: metadata.byteSize
        })
      }

      group = { session, files }

      // 活跃会话也保留已加载列表供分屏重挂载时展示；上面的复用条件仍强制重新读取活跃会话。
      cache.set(key, { extractionVersion: EXTRACTION_VERSION, stamp, group })

      if (files.length) {
        results.set(key, group)
      } else {
        results.delete(key)
      }
    } catch {
      failures += 1
      // 当前读取失败仍保留已知文件，但明确显示降级状态。
      const previous = cache.get(key)?.group

      if (previous?.files.length) {
        results.set(key, previous)
      }
    }

    processed += 1
    publish({ groups: groups(), processed, total: sessions.length, failures, scanning: true })
  }

  if (isCurrent()) {
    publish({ groups: groups(), processed, total: sessions.length, failures, scanning: false })
  }
}
