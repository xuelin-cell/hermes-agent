import { useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'
import { browserMediaPlaybackUrl, browserShellCopy } from '@/lib/browser-shell'
import { mediaKind } from '@/lib/media'
import type { PreviewTarget } from '@/store/preview'

import { PreviewEmptyState } from './preview-file'

// Browser build only (lib/browser-shell.ts::previewsMediaInPanel): audio and
// video files play in the preview pane, streamed from the instance, where
// upstream reads them as binary and offers to show the bytes as text.

export function MediaPreview({ reloadKey, target }: { reloadKey: number; target: PreviewTarget }) {
  const { locale, t } = useI18n()
  const copy = browserShellCopy(locale)
  const path = target.path || target.source
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let objectUrl = ''

    setSrc('')
    setFailed(false)
    void (browserMediaPlaybackUrl(path) ?? Promise.reject(new Error('not the browser build'))).then(
      url => {
        if (url.startsWith('blob:')) {
          objectUrl = url
        }

        if (active) {
          setSrc(url)
        } else if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }
      },
      () => {
        if (active) {
          setFailed(true)
        }
      }
    )

    return () => {
      active = false

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [path, reloadKey])

  if (failed) {
    return <PreviewEmptyState body={copy.media.failed} title={t.preview.unavailable} />
  }

  if (!src) {
    return <PageLoader label={copy.media.loading} />
  }

  if (mediaKind(path) === 'audio') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md rounded-xl border border-border/60 bg-background p-4 shadow-sm">
          <div className="mb-3 truncate text-sm font-medium text-foreground">{target.label}</div>
          <audio
            aria-label={target.label}
            className="block w-full"
            controls
            onError={() => setFailed(true)}
            preload="metadata"
            src={src}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/30 p-4">
      <video
        aria-label={target.label}
        className="max-h-full max-w-full rounded-md bg-black shadow-[0_6px_24px_rgba(0,0,0,0.12)]"
        controls
        onError={() => setFailed(true)}
        playsInline
        preload="metadata"
        src={src}
      />
    </div>
  )
}
