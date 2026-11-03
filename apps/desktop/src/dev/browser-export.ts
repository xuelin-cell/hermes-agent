import { readBrowserAuth } from '../../../shared/src/browser-maas-auth.js'
import { type PreviewExport, type PreviewExportResult, wordDocument } from '../../../shared/src/preview-export'

/** Native Save As becomes a browser handoff; only PDF bytes require the user's instance. */
export function browserExport(base: string, backend: string) {
  return async (input: PreviewExport): Promise<PreviewExportResult> => {
    try {
      if (!input || !['md', 'pdf', 'docx'].includes(input.format) || typeof input.content !== 'string' ||
          typeof input.name !== 'string' || new TextEncoder().encode(input.content).length > 8 * 1024 * 1024) {
        return { status: 'failed' }
      }

      const login = readBrowserAuth(base)?.loginId

      const name = input.name.replaceAll('\\', '/').split('/').pop()!
        .replace(/\.(md|markdown|mdx)$/i, '').replace(/[<>:"|?*\p{Cc}]/gu, '_').slice(0, 100) || 'document'

      let blob: Blob

      if (input.format === 'pdf') {
        const response = await fetch(`${backend}/__mt_user/preview-export`, {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: input.content }), signal: AbortSignal.timeout(60_000)
        })

        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/pdf')) {
          return { status: 'failed' }
        }

        blob = await response.blob()

        if (blob.size > 32 * 1024 * 1024 || await blob.slice(0, 5).text() !== '%PDF-') {
          return { status: 'failed' }
        }
      } else {
        blob = input.format === 'md'
          ? new Blob([input.content], { type: 'text/markdown;charset=utf-8' })
          : new Blob([wordDocument(input.content) as Uint8Array<ArrayBuffer>], {
              type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            })
      }

      if (readBrowserAuth(base)?.loginId !== login) {
        return { status: 'failed' }
      }

      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${name}.${input.format}`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)

      return { status: 'handed-off' }
    } catch {
      return { status: 'failed' }
    }
  }
}
