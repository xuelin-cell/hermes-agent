import { hermesApi } from '@/api/client'
import { getAllSessionMessages, listAllProfileSessions } from '@/hermes'
import type { PaginatedSessions, SessionInfo } from '@/types/hermes'

import { collectArtifactsForSession } from './artifact-utils'
import {
  isPublishedArtifactLink,
  type LocalArtifactGroup,
  localArtifactPath,
  localSessionKey
} from './local-artifact-model'

export interface LocalArtifactScan {
  groups: LocalArtifactGroup[]
  processed: number
  total: number
  failures: number
  scanning: boolean
}
export interface LocalArtifactCache {
  stamp: string
  group: LocalArtifactGroup
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
      .filter(row => !row.connection_id || row.connection_id === 'local')
      .map(row => [localSessionKey(row), { ...row, connection_id: 'local' }])
  )

  let failures = first.errors?.length || 0

  for (const [profile, total] of Object.entries(first.profile_totals || {})) {
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
  const valid = new Set(sessions.map(localSessionKey))

  for (const key of cache.keys()) {
    if (!valid.has(key)) {
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
    const stamp = JSON.stringify([session.last_active, session.message_count, session.archived, session.cwd])

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

        group = { session, files: collectArtifactsForSession(session, result.messages) }
      }

      const files = []

      for (const file of group.files) {
        if (!isCurrent()) {
          return
        }

        // 新扫描及已有提取缓存共用同一规则，分享页不参与文件读取和产物计数。
        if (isPublishedArtifactLink(file.value)) {
          continue
        }

        const candidate = localArtifactPath(file, session)

        // 原生预览规范化包含路径策略、文件存在性和有界元信息读取，不搬运文件字节。
        const metadata = candidate
          ? await window.hermesDesktop.normalizePreviewTarget(candidate, session.cwd || undefined).catch(() => null)
          : null

        if (!isCurrent()) {
          return
        }

        files.push({ ...file, id: `${key}:${file.value}`, resolvedPath: metadata?.path, byteSize: metadata?.byteSize })
      }

      group = { session, files }

      if (!session.is_active) {
        cache.set(key, { stamp, group })
      } else {
        cache.delete(key)
      }

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
