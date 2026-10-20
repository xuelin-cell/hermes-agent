export interface ArtifactShareSource {
  sessionId: string
  path?: string
  content?: string
  hash?: string
}

export interface ArtifactShareEligibility {
  publishable: boolean
  reason: 'unknown_origin' | 'user_upload' | 'content_changed' | null
}

/** 为模型生成的 HTML 片段补全文档，与预览和发布使用完全相同的内容。 */
export function composeArtifactHtml(content: string): string {
  if (/<html[\s>]|<!doctype\s+html/i.test(content)) {
    return content
  }

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>',
    content,
    '</body></html>'
  ].join('\n')
}

export interface ArtifactShareRecord {
  key: string
  shareId: string
  url: string
  title: string
  hash: string
  version: number
  updatedAt: string
  /** Older records have no deadline until the user explicitly sets one. */
  expiresAt?: string | null
  deletedAt?: string
  cleanupError?: string
}

export interface ArtifactSharePublishInput {
  key: string
  html: string
  title: string
  source: ArtifactShareSource
  ttlDays?: number
}

export function artifactShareExpired(record: Pick<ArtifactShareRecord, 'expiresAt'>, now = Date.now()): boolean {
  return !!record.expiresAt && new Date(record.expiresAt).getTime() <= now
}

export function artifactShareActive(record: ArtifactShareRecord, now = Date.now()): boolean {
  return !record.deletedAt && !artifactShareExpired(record, now)
}

export function artifactShareDeadline(ttlDays: number, now: number): string {
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 7) {
    throw new Error('有效期必须为 1～7 天的整数。')
  }

  return new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString()
}
