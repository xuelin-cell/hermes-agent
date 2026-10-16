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
