import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveReadableFileForIpc } from '../hardening'
import { resolveLocalReadPath } from '../wsl-path-bridge'

import { CloudDriveOperationError } from './cloud-drive'
import type { CloudDriveArtifactSource } from './contract'

export interface AuthorizedArtifactFile {
  path: string
  name: string
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
}

interface ArtifactBackend {
  mode: string
}

interface ArtifactSourceDependencies {
  connect: (profile: string) => Promise<ArtifactBackend>
  read: (backend: ArtifactBackend, route: string, signal: AbortSignal) => Promise<unknown>
  workspace: string
}

export type ResolveDriveArtifact = (
  source: CloudDriveArtifactSource,
  signal: AbortSignal
) => Promise<AuthorizedArtifactFile>

/** 只接受会话与文件标识，不允许页面指定网络地址、账号或下载凭据。 */
function validSource(source: CloudDriveArtifactSource): boolean {
  return (
    !!source &&
    typeof source.sessionId === 'string' &&
    /^[a-zA-Z0-9_-]{1,160}$/.test(source.sessionId) &&
    typeof source.profile === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(source.profile) &&
    (!source.connectionId || source.connectionId === 'local') &&
    typeof source.value === 'string' &&
    source.value.length > 0 &&
    source.value.length <= 4096 &&
    !/^(?:https?:|data:|hermes-media:)/i.test(source.value)
  )
}

/** 引用必须完整出现，不能用 report.txt 认领 report.txt.secret 或子路径。 */
function containsReference(text: string, candidates: string[]): boolean {
  return candidates.some(candidate => {
    let start = text.indexOf(candidate)

    while (start !== -1) {
      const before = start === 0 ? '' : text[start - 1]
      const after = text[start + candidate.length] || ''

      if ((!before || /[\s"'`(<:[]/.test(before)) && (!after || /[\s"'`)>,;\]}]/.test(after))) {
        return true
      }

      start = text.indexOf(candidate, start + candidate.length)
    }

    return false
  })
}

/** 原始字符串和嵌套工具结果均可确认引用，但不消费用户消息中的伪造产物。 */
function references(value: unknown, candidates: string[], depth = 0): boolean {
  if (typeof value === 'string') {
    return containsReference(value, candidates)
  }

  if (!value || typeof value !== 'object' || depth > 24) {
    return false
  }

  return Object.values(value).some(child => references(child, candidates, depth + 1))
}

/** 主进程从固定本机来源核对会话记录，再复用既有文件读取规则和敏感文件拦截。 */
export function createDriveArtifactResolver(dependencies: ArtifactSourceDependencies): ResolveDriveArtifact {
  return async (source, signal) => {
    if (!validSource(source)) {
      throw new CloudDriveOperationError('failed', 'ARTIFACT_SOURCE_INVALID')
    }

    signal.throwIfAborted()
    const backend = await interruptible(dependencies.connect(source.profile), signal)
    signal.throwIfAborted()

    if (backend.mode !== 'local') {
      throw new CloudDriveOperationError('failed', 'ARTIFACT_SOURCE_REMOTE')
    }

    const query = new URLSearchParams({ profile: source.profile })
    const base = `/api/sessions/${encodeURIComponent(source.sessionId)}`

    const detail = (await interruptible(dependencies.read(backend, `${base}?${query}`, signal), signal)) as {
      id?: string
      profile?: string
      cwd?: string
    }

    signal.throwIfAborted()

    if (detail?.id !== source.sessionId || (detail.profile && detail.profile !== source.profile)) {
      throw new CloudDriveOperationError('failed', 'ARTIFACT_SOURCE_INVALID')
    }

    const sessionCwd = typeof detail.cwd === 'string' ? resolveLocalReadPath(detail.cwd, undefined, source.profile) : ''
    const cwd = path.isAbsolute(sessionCwd) ? sessionCwd : dependencies.workspace

    let file: Awaited<ReturnType<typeof resolveReadableFileForIpc>>

    try {
      file = await resolveReadableFileForIpc(resolveLocalReadPath(source.value, undefined, source.profile), {
        baseDir: cwd,
        purpose: 'Artifact upload'
      })
    } catch (error) {
      throw new CloudDriveOperationError(
        'failed',
        (error as { code?: string })?.code === 'sensitive-file' ? 'ARTIFACT_SOURCE_BLOCKED' : 'ARTIFACT_SOURCE_INVALID'
      )
    }

    const candidates = [...new Set([source.value, file.resolvedPath, pathToFileURL(file.resolvedPath).href])]
    candidates.push(...candidates.map(candidate => JSON.stringify(candidate).slice(1, -1)))
    let offset = 0
    let characters = 0

    while (characters < 32_000_000) {
      signal.throwIfAborted()

      const params = new URLSearchParams({
        profile: source.profile,
        limit: '500',
        offset: String(offset),
        order: 'oldest',
        include_compacted: 'true',
        inline_images: 'false'
      })

      const page = (await interruptible(dependencies.read(backend, `${base}/messages?${params}`, signal), signal)) as {
        profile?: string
        messages?: Array<{ role?: string; content?: unknown }>
        pagination?: { limit?: number; offset?: number }
      }

      signal.throwIfAborted()

      if (
        !Array.isArray(page?.messages) ||
        (page.profile && page.profile !== source.profile) ||
        (page.pagination?.offset != null && page.pagination.offset !== offset)
      ) {
        throw new CloudDriveOperationError('failed', 'ARTIFACT_SOURCE_INVALID')
      }

      characters += JSON.stringify(page.messages).length

      if (characters > 32_000_000) {
        break
      }

      if (
        page.messages.some(
          message => ['assistant', 'tool'].includes(message.role || '') && references(message.content, candidates)
        )
      ) {
        return {
          path: file.realPath,
          name: path.basename(file.resolvedPath),
          snapshot: {
            dev: file.stat.dev,
            ino: file.stat.ino,
            size: file.stat.size,
            mtimeMs: file.stat.mtimeMs,
            ctimeMs: file.stat.ctimeMs
          }
        }
      }

      if (!page.pagination || page.messages.length === 0 || page.messages.length < (page.pagination.limit || 500)) {
        break
      }

      offset += page.messages.length
    }

    throw new CloudDriveOperationError('failed', 'ARTIFACT_NOT_REFERENCED')
  }
}

/** 核对会话时取消也立即结束等待，迟到的读取不能继续扫描或进入分片上传。 */
async function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void

  const cancelled = new Promise<T>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })

  try {
    return await Promise.race([pending, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
